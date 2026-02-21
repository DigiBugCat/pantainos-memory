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
 * 4. Store in D1 (memories table)
 * 5. If active: generate embeddings, upsert to vectorize, queue exposure check
 * 6. If draft: D1 only, return ID + warnings (call with override: true to commit)
 *
 * Query params:
 * - sync=true: Run exposure check synchronously and return results in response
 *   (useful for testing, not recommended for production)
 *
 * Three-Table Architecture:
 * - Content embeddings stored in MEMORY_VECTORS
 * - invalidates_if conditions stored in INVALIDATES_VECTORS
 * - confirms_if conditions stored in CONFIRMS_VECTORS
 */

import { Hono } from 'hono';
import type {
  MemoryRequest,
  ExposureCheckJob,
  ExposureCheckResult,
} from '../../lib/shared/types/index.js';
import { logField, logOperation, logError } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateId } from '../../lib/id.js';
import { generateEmbedding, checkDuplicate, checkDuplicateWithLLM } from '../../lib/embeddings.js';
import { recordVersion } from '../../services/history-service.js';
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
  const contentEmbedding = await generateEmbedding(c.env.AI, body.content, config, requestId);

  // Duplicate detection (two-phase: vector similarity → optional LLM) — always blocks
  const dupCheck = await checkDuplicate(c.env, contentEmbedding, requestId);
  if (dupCheck.id && dupCheck.similarity >= config.dedupThreshold) {
    const existing = await c.env.DB.prepare(
      `SELECT content FROM memories WHERE id = ?`
    ).bind(dupCheck.id).first<{ content: string }>();
    return c.json({
      success: false,
      error: `Duplicate detected (${Math.round(dupCheck.similarity * 100)}% match)`,
      duplicate_id: dupCheck.id,
      duplicate_content: existing?.content || null,
    }, 409);
  } else if (dupCheck.id && dupCheck.similarity >= config.dedupLowerThreshold) {
    const existing = await c.env.DB.prepare(
      `SELECT content FROM memories WHERE id = ?`
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

  // Completeness check (advisory — saves as draft if warnings)
  let completenessWarnings: ObserveResponse['warnings'];
  const completeness = await checkMemoryCompleteness(c.env, c.env.AI, config, {
    content: body.content,
    has_source: hasSource,
    has_derived_from: hasDerivedFrom,
    has_invalidates_if: Boolean(body.invalidates_if?.length),
    has_confirms_if: Boolean(body.confirms_if?.length),
    has_resolves_by: timeBound,
    atomic_override: body.atomic_override,
    requestId,
  });
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

  // ── D1 insert (always runs — draft or active) ──
  const startingConfidence = hasSource
    ? await getStartingConfidenceForSource(c.env.DB, normalizedSource!)
    : (timeBound ? TYPE_STARTING_CONFIDENCE.predict : TYPE_STARTING_CONFIDENCE.think);

  const obsidianSources = body.obsidian_sources;
  await c.env.DB.prepare(
    `INSERT INTO memories (
      id, content, source, source_url, derived_from,
      assumes, invalidates_if, confirms_if,
      outcome_condition, resolves_by,
      starting_confidence, confirmations, times_tested, contradictions,
      centrality, state, violations,
      retracted, tags, obsidian_sources, session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, '[]', 0, ?, ?, ?, ?)`
  ).bind(
    id,
    body.content,
    hasSource ? normalizedSource : null,
    body.source_url || null,
    hasDerivedFrom ? JSON.stringify(body.derived_from) : null,
    body.assumes ? JSON.stringify(body.assumes) : null,
    body.invalidates_if ? JSON.stringify(body.invalidates_if) : null,
    body.confirms_if ? JSON.stringify(body.confirms_if) : null,
    body.outcome_condition || null,
    body.resolves_by || null,
    startingConfidence,
    initialState,
    body.tags ? JSON.stringify(body.tags) : null,
    obsidianSources ? JSON.stringify(obsidianSources) : null,
    sessionId || null,
    now
  ).run();

  // Edges + version recording (always, regardless of draft/active)
  const postInsertTasks: Promise<unknown>[] = [];

  if (hasDerivedFrom) {
    const edgeStmts = body.derived_from!.map(sourceId =>
      c.env.DB.prepare(
        `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
         VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
      ).bind(generateId(), sourceId, id, now)
    );
    const centralityStmts = body.derived_from!.map(sourceId =>
      c.env.DB.prepare(
        `UPDATE memories SET centrality = centrality + 1, updated_at = ? WHERE id = ?`
      ).bind(now, sourceId)
    );
    postInsertTasks.push(c.env.DB.batch([...edgeStmts, ...centralityStmts]));
  }

  postInsertTasks.push(recordVersion(c.env.DB, {
    entityId: id,
    entityType: 'memory',
    changeType: 'created',
    contentSnapshot: {
      id,
      content: body.content,
      source: hasSource ? normalizedSource : undefined,
      source_url: body.source_url || undefined,
      derived_from: hasDerivedFrom ? body.derived_from : undefined,
      assumes: body.assumes,
      invalidates_if: body.invalidates_if,
      confirms_if: body.confirms_if,
      outcome_condition: body.outcome_condition,
      resolves_by: body.resolves_by,
      tags: body.tags,
      obsidian_sources: obsidianSources,
      starting_confidence: startingConfidence,
      confirmations: 0,
      times_tested: 0,
      contradictions: 0,
      centrality: 0,
      state: initialState,
      violations: [],
      retracted: false,
      time_bound: timeBound,
    },
    sessionId,
    requestId,
    userAgent,
    ipHash,
  }));

  await Promise.all(postInsertTasks);

  logField(c, 'memory_id', id);
  logField(c, 'type', 'memory');
  logField(c, 'state', initialState);
  if (hasSource) logField(c, 'source', normalizedSource);
  if (hasDerivedFrom) logField(c, 'derived_from', body.derived_from);

  // ── Draft: D1 only, no vectorize or exposure check ──
  if (isDraft) {
    return c.json({
      success: true,
      id,
      status: 'draft',
      time_bound: timeBound || undefined,
      warnings: completenessWarnings,
    } satisfies ObserveResponse, 201);
  }

  // ── Active: full pipeline (vectorize + exposure check) ──

  // Generate condition embeddings (content embedding already computed above for dedup)
  const embeddingsP = (async () => {
    const conditionTasks: Promise<number[]>[] = [];
    for (const condition of (hasConditions ? body.invalidates_if : undefined) ?? []) {
      conditionTasks.push(generateEmbedding(c.env.AI, condition, config, requestId));
    }
    for (const condition of (hasConditions ? body.confirms_if : undefined) ?? []) {
      conditionTasks.push(generateEmbedding(c.env.AI, condition, config, requestId));
    }
    const condResults = await Promise.all(conditionTasks);
    const invCount = (hasConditions ? body.invalidates_if?.length : 0) ?? 0;
    return {
      content: contentEmbedding,
      invalidates: condResults.slice(0, invCount),
      confirms: condResults.slice(invCount),
    };
  })();

  // Vectorize upserts
  const vectorizeP = (async () => {
    const embeddings = await embeddingsP;

    const contentMetadata = hasSource
      ? { type: 'obs', source: normalizedSource, has_invalidates_if: Boolean(hasConditions && body.invalidates_if?.length), has_confirms_if: Boolean(hasConditions && body.confirms_if?.length) }
      : { type: 'thought', has_invalidates_if: Boolean(body.invalidates_if?.length), has_assumes: Boolean(body.assumes?.length), has_confirms_if: Boolean(body.confirms_if?.length), has_outcome: timeBound, resolves_by: body.resolves_by, time_bound: timeBound };

    const upserts: Promise<unknown>[] = [
      c.env.MEMORY_VECTORS.upsert([{ id, values: embeddings.content, metadata: contentMetadata as any }]),
    ];

    if (embeddings.invalidates.length > 0 && body.invalidates_if) {
      const condVectors = body.invalidates_if.map((condition, index) => ({
        id: `${id}:inv:${index}`,
        values: embeddings.invalidates[index],
        metadata: { memory_id: id, condition_index: index, condition_text: condition, time_bound: !hasSource && timeBound } as any,
      }));
      upserts.push(c.env.INVALIDATES_VECTORS.upsert(condVectors));
    }

    if (embeddings.confirms.length > 0 && body.confirms_if) {
      const condVectors = body.confirms_if.map((condition, index) => ({
        id: `${id}:conf:${index}`,
        values: embeddings.confirms[index],
        metadata: { memory_id: id, condition_index: index, condition_text: condition, time_bound: !hasSource && timeBound } as any,
      }));
      upserts.push(c.env.CONFIRMS_VECTORS.upsert(condVectors));
    }

    await Promise.all(upserts);
    return embeddings;
  })();

  // Sync mode: need everything settled before exposure check
  if (syncMode) {
    const embeddings = await vectorizeP;
    logOperation(c, 'exposure', 'sync_check', { entity_id: id });

    await c.env.DB.prepare(`
      UPDATE memories
      SET exposure_check_status = 'processing', updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();

    try {
      const exposureP = hasSource
        ? checkExposures(c.env, id, body.content, embeddings.content)
        : checkExposuresForNewThought(
            c.env, id, body.content,
            body.invalidates_if || [],
            body.confirms_if || [],
            timeBound
          );

      const surpriseP = computeSurprise(c.env, id, embeddings.content).catch(() => null);

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

  // Async mode: persist vectors, then enqueue exposure
  const embeddings = await vectorizeP;
  const embedding = embeddings.content;

  const exposureJob: ExposureCheckJob = {
    memory_id: id,
    is_observation: hasSource,
    content: body.content,
    embedding,
    session_id: sessionId,
    request_id: requestId,
    timestamp: now,
    invalidates_if: hasConditions ? body.invalidates_if : undefined,
    confirms_if: hasConditions ? body.confirms_if : undefined,
    time_bound: timeBound,
  };

  try {
    await c.env.DETECTION_QUEUE.send(exposureJob);
  } catch (error) {
    const failedAt = Date.now();
    logError(
      'observe_queue_enqueue_failed',
      error instanceof Error ? error : String(error),
      {
        memory_id: id,
        session_id: sessionId,
        request_id: requestId,
      }
    );

    await c.env.DB.prepare(`
      UPDATE memories
      SET exposure_check_status = 'pending', updated_at = ?
      WHERE id = ?
    `).bind(failedAt, id).run();

    throw error;
  }

  logOperation(c, 'exposure', 'queued', { entity_id: id });

  return c.json({
    success: true,
    id,
    status: 'active',
    time_bound: timeBound || undefined,
    exposure_check: 'queued',
  } satisfies ObserveResponse, 201);
});

export default app;
