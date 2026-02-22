/**
 * Observe Route - POST /api/observe
 *
 * Unified memory creation endpoint. Creates either:
 * - OBSERVATION (has source) - facts from reality
 * - THOUGHT (has derived_from) - derived beliefs
 * - PREDICTION (has derived_from + resolves_by) - time-bound thoughts
 * - HYBRID (has source + derived_from) - observed facts linked to prior memories
 *
 * Memory type is determined by field presence, not a type column.
 * At least one of "source" OR "derived_from" is required.
 *
 * Flow:
 * 1. Validate request
 * 2. Duplicate detection (blocks on match)
 * 3. Completeness check (advisory — saves as draft if warnings, unless override: true)
 * 4. Active path: return 201 immediately, defer writes to waitUntil()
 * 5. Draft path: blocking D1 write, return ID + warnings
 * 6. Sync path (?sync=true): blocking full pipeline
 *
 * Three-Table Architecture:
 * - Content embeddings stored in MEMORY_VECTORS
 * - invalidates_if conditions stored in INVALIDATES_VECTORS
 * - confirms_if conditions stored in CONFIRMS_VECTORS
 */

import { Hono } from 'hono';
import type {
  MemoryRequest,
  ExposureCheckResult,
} from '../../lib/shared/types/index.js';
import { logField, logOperation, logError } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateId } from '../../lib/id.js';
import { generateEmbedding, checkDuplicate, checkDuplicateWithLLM } from '../../lib/embeddings.js';
import { checkExposures, checkExposuresForNewThought } from '../../services/exposure-checker.js';
import { computeSurprise } from '../../services/surprise.js';
import { TYPE_STARTING_CONFIDENCE } from '../../services/confidence.js';
import { getStartingConfidenceForSource } from '../../jobs/compute-stats.js';
import { checkMemoryCompleteness } from '../../services/classification-challenge.js';
import {
  normalizeAndValidateSource,
  validateDerivedFromIds,
  validateOrigin,
  validateTimeBound,
  commitMemory,
  type CommitPayload,
  type ObserveCommitJob,
} from '../../usecases/observe-memory.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Response type */
interface ObserveResponse {
  success: true;
  id: string;
  status: 'active' | 'draft';
  time_bound?: boolean;
  exposure_check?: 'queued';
  exposure_result?: ExposureCheckResult;
  surprise?: number;
  warnings?: {
    missing_fields: Array<{ field: string; reason: string }>;
    reasoning: string;
  };
}

app.post('/', async (c) => {
  const t0 = performance.now();
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');

  // Check for sync mode
  const syncMode = c.req.query('sync') === 'true';

  // Validate request
  let body: MemoryRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.content || typeof body.content !== 'string') {
    return c.json({ success: false, error: 'content is required' }, 400);
  }

  // Normalize source before validation/persistence
  const sourceValidation = normalizeAndValidateSource(body.source);
  if (sourceValidation.error) {
    return c.json({ success: false, error: sourceValidation.error }, 400);
  }
  const normalizedSource = sourceValidation.normalizedSource;

  // Validate origin: at least one of source or derived_from required
  const originError = validateOrigin(normalizedSource, body.derived_from);
  if (originError) {
    return c.json({ success: false, error: originError }, 400);
  }
  const hasSource = normalizedSource !== undefined;
  const hasDerivedFrom = body.derived_from !== undefined && body.derived_from !== null && body.derived_from.length > 0;

  // Field-specific validation
  if (hasDerivedFrom) {
    const derivedFromError = await validateDerivedFromIds(c.env.DB, body.derived_from);
    if (derivedFromError) {
      return c.json({ success: false, error: derivedFromError }, 404);
    }
  }

  // Time-bound validation
  const timeBoundError = validateTimeBound(body.resolves_by, body.outcome_condition);
  if (timeBoundError) {
    return c.json({ success: false, error: timeBoundError }, 400);
  }
  const timeBound = body.resolves_by !== undefined;

  // ── Pre-creation guards ──
  // Generate content embedding early for duplicate check
  const t1 = performance.now();
  const contentEmbedding = await generateEmbedding(c.env.AI, body.content, config, requestId);
  const t2 = performance.now();

  // Duplicate detection (two-phase: vector similarity → optional LLM) — always blocks
  const dupCheck = await checkDuplicate(c.env, contentEmbedding, requestId);
  const t3 = performance.now();
  if (dupCheck.id && dupCheck.similarity >= config.dedupThreshold) {
    const existing = await c.env.DB.prepare(
      `SELECT content FROM memories WHERE id = ? AND retracted = 0`
    ).bind(dupCheck.id).first<{ content: string }>();
    if (existing) {
      return c.json({
        success: false,
        error: `Duplicate detected (${Math.round(dupCheck.similarity * 100)}% match)`,
        duplicate_id: dupCheck.id,
        duplicate_content: existing.content,
      }, 409);
    }
  } else if (dupCheck.id && dupCheck.similarity >= config.dedupLowerThreshold) {
    const existing = await c.env.DB.prepare(
      `SELECT content FROM memories WHERE id = ? AND retracted = 0`
    ).bind(dupCheck.id).first<{ content: string }>();
    if (existing) {
      const llmResult = await checkDuplicateWithLLM(c.env.AI, body.content, existing.content, config, requestId, c.env);
      if (llmResult.isDuplicate && llmResult.confidence >= config.dedupConfidenceThreshold) {
        return c.json({
          success: false,
          error: `Duplicate detected (LLM: ${Math.round(llmResult.confidence * 100)}% confidence)`,
          duplicate_id: dupCheck.id,
          duplicate_content: existing.content,
          reasoning: llmResult.reasoning,
        }, 409);
      }
    }
  }

  // Completeness check + confidence lookup in parallel (independent operations)
  const t4 = performance.now();
  const [completeness, startingConfidence] = await Promise.all([
    checkMemoryCompleteness(c.env, c.env.AI, config, {
      content: body.content,
      has_source: hasSource,
      has_derived_from: hasDerivedFrom,
      has_invalidates_if: Boolean(body.invalidates_if?.length),
      has_confirms_if: Boolean(body.confirms_if?.length),
      has_resolves_by: timeBound,
      atomic_override: body.atomic_override,
      requestId,
    }),
    hasSource
      ? getStartingConfidenceForSource(c.env.DB, normalizedSource!)
      : Promise.resolve(timeBound ? TYPE_STARTING_CONFIDENCE.predict : TYPE_STARTING_CONFIDENCE.think),
  ]);

  let completenessWarnings: ObserveResponse['warnings'];
  if (completeness && !completeness.is_complete && completeness.missing_fields.length > 0) {
    completenessWarnings = {
      missing_fields: completeness.missing_fields,
      reasoning: completeness.reasoning,
    };
  }

  const isDraft = Boolean(completenessWarnings);
  const initialState = isDraft ? 'draft' : 'active';
  const now = Date.now();
  const id = generateId();

  const hasConditions = (body.invalidates_if && body.invalidates_if.length > 0) ||
    (body.confirms_if && body.confirms_if.length > 0);

  // Build commit payload (shared by all paths)
  const commitPayload: CommitPayload = {
    id, body, normalizedSource, hasSource, hasDerivedFrom,
    initialState, timeBound, hasConditions: Boolean(hasConditions),
    startingConfidence, contentEmbedding,
    sessionId, requestId, userAgent, ipHash, now, config,
  };

  logField(c, 'memory_id', id);
  logField(c, 'type', 'memory');
  logField(c, 'state', initialState);
  if (hasSource) logField(c, 'source', normalizedSource);
  if (hasDerivedFrom) logField(c, 'derived_from', body.derived_from);

  // ── Draft: blocking D1 write (caller needs confirmation + warnings) ──
  if (isDraft) {
    await commitMemory(c.env, commitPayload);
    return c.json({
      success: true,
      id,
      status: 'draft',
      time_bound: timeBound || undefined,
      warnings: completenessWarnings,
    } satisfies ObserveResponse, 201);
  }

  // ── Sync mode: blocking full pipeline ──
  if (syncMode) {
    await commitMemory(c.env, commitPayload);

    logOperation(c, 'exposure', 'sync_check', { entity_id: id });

    await c.env.DB.prepare(`
      UPDATE memories
      SET exposure_check_status = 'processing', updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();

    try {
      const exposureP = hasSource
        ? checkExposures(c.env, id, body.content, contentEmbedding)
        : checkExposuresForNewThought(
            c.env, id, body.content,
            body.invalidates_if || [],
            body.confirms_if || [],
            timeBound
          );

      const surpriseP = computeSurprise(c.env, id, contentEmbedding).catch(() => null);

      const [exposureResult, surprise] = await Promise.all([exposureP, surpriseP]);

      const completedAt = Date.now();

      if (surprise != null) {
        await c.env.DB.prepare(`
          UPDATE memories
          SET exposure_check_status = 'completed', exposure_check_completed_at = ?,
              surprise = ?, updated_at = ?
          WHERE id = ?
        `).bind(completedAt, surprise, completedAt, id).run();
      } else {
        await c.env.DB.prepare(`
          UPDATE memories
          SET exposure_check_status = 'completed', exposure_check_completed_at = ?, updated_at = ?
          WHERE id = ?
        `).bind(completedAt, completedAt, id).run();
      }

      logField(c, 'violations', exposureResult.violations.length);
      logField(c, 'confirmations', exposureResult.confirmations.length);
      if (surprise != null) logField(c, 'surprise', surprise);

      return c.json({
        success: true,
        id,
        status: 'active',
        time_bound: timeBound || undefined,
        exposure_check: 'queued',
        exposure_result: exposureResult,
        surprise: surprise ?? undefined,
      } satisfies ObserveResponse, 201);
    } catch (error) {
      logError('sync_exposure_check_failed', error instanceof Error ? error : String(error));
    }
  }

  // ── Active path (common): optimistic return, defer writes to waitUntil ──
  logOperation(c, 'exposure', 'queued', { entity_id: id });

  const t5 = performance.now();
  console.log(`[observe response] id=${id} embedding=${(t2-t1).toFixed(0)}ms dedup=${(t3-t2).toFixed(0)}ms completeness=${(t5-t4).toFixed(0)}ms total=${(t5-t0).toFixed(0)}ms`);

  // Defer all writes to background
  const commitTask = commitMemory(c.env, commitPayload).catch(async (err) => {
    console.error(`[observe commit failed] id=${id}`, err instanceof Error ? err.message : err);
    // Enqueue for retry via dead letter path
    try {
      const retryJob: ObserveCommitJob = { type: 'observe:commit', ...commitPayload };
      await c.env.DETECTION_QUEUE.send(retryJob);
      console.log(`[observe commit queued for retry] id=${id}`);
    } catch (queueErr) {
      console.error(`[observe DLQ enqueue failed] id=${id}`, queueErr instanceof Error ? queueErr.message : queueErr);
    }
  });

  try {
    c.executionCtx.waitUntil(commitTask);
  } catch {
    // Test environment — no ExecutionContext available
    commitTask.catch(() => {});
  }

  return c.json({
    success: true,
    id,
    status: 'active',
    time_bound: timeBound || undefined,
    exposure_check: 'queued',
  } satisfies ObserveResponse, 201);
});

export default app;
