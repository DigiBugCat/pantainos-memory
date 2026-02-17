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
 * Flow (FAST - exposure checking queued for async processing):
 * 1. Validate request
 * 2. Store in D1 (memories table)
 * 3. Generate embedding (Workers AI) and store in vector tables
 * 4. Queue bi-directional exposure check job
 * 5. Return response immediately
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
import { normalizeSource, isNonEmptySource } from '../../lib/source.js';
import { generateAllEmbeddings } from '../../services/embedding-tables.js';
import { recordVersion } from '../../services/history-service.js';
import { checkExposures, checkExposuresForNewThought } from '../../services/exposure-checker.js';
import { TYPE_STARTING_CONFIDENCE } from '../../services/confidence.js';
import { getStartingConfidenceForSource } from '../../jobs/compute-stats.js';

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
  time_bound?: boolean;
  exposure_check: 'queued';
  exposure_result?: ExposureCheckResult;
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
  let normalizedSource: string | undefined;
  if (body.source !== undefined && body.source !== null) {
    if (typeof body.source !== 'string' || !isNonEmptySource(body.source)) {
      return c.json({ success: false, error: 'source must be a non-empty string when provided' }, 400);
    }
    normalizedSource = normalizeSource(body.source);
  }

  // Validate origin: at least one of source or derived_from required
  const hasSource = normalizedSource !== undefined;
  const hasDerivedFrom = body.derived_from !== undefined && body.derived_from !== null && body.derived_from.length > 0;

  if (!hasSource && !hasDerivedFrom) {
    return c.json(
      { success: false, error: 'Either "source" or "derived_from" is required' },
      400
    );
  }

  // Field-specific validation
  if (hasDerivedFrom) {
    // Validate derived_from existence
    const placeholders = body.derived_from!.map(() => '?').join(',');
    const sources = await c.env.DB.prepare(
      `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
    ).bind(...body.derived_from!).all<{ id: string }>();

    if (!sources.results || sources.results.length !== body.derived_from!.length) {
      const foundIds = new Set(sources.results?.map((r) => r.id) || []);
      const missing = body.derived_from!.filter((id) => !foundIds.has(id));
      return c.json(
        { success: false, error: `Source memories not found: ${missing.join(', ')}` },
        404
      );
    }
  }

  // Time-bound validation
  const timeBound = body.resolves_by !== undefined;
  if (timeBound && !body.outcome_condition) {
    return c.json(
      { success: false, error: 'outcome_condition is required when resolves_by is set' },
      400
    );
  }

  const now = Date.now();
  const id = generateId();

  const hasConditions = (body.invalidates_if && body.invalidates_if.length > 0) ||
    (body.confirms_if && body.confirms_if.length > 0);

  // ── Everything that CAN start immediately DOES start immediately ──
  // Nothing waits for anything it doesn't directly need.

  // Kick off embedding generation immediately — slowest operation, don't block on anything
  const embeddingsP = generateAllEmbeddings(c.env.AI, config, {
    content: body.content,
    invalidates_if: hasConditions ? body.invalidates_if : undefined,
    confirms_if: hasConditions ? body.confirms_if : undefined,
    requestId,
  });

  // Starting confidence + D1 insert flow independently from embeddings
  // Starting confidence feeds into the INSERT, so it must resolve first within this track
  const d1WriteP = (async () => {
    const startingConfidence = hasSource
      ? await getStartingConfidenceForSource(c.env.DB, normalizedSource!)
      : (timeBound ? TYPE_STARTING_CONFIDENCE.predict : TYPE_STARTING_CONFIDENCE.think);

    // Memory INSERT (edges + version flow from this, but embeddings don't wait)
    await c.env.DB.prepare(
      `INSERT INTO memories (
        id, content, source, source_url, derived_from,
        assumes, invalidates_if, confirms_if,
        outcome_condition, resolves_by,
        starting_confidence, confirmations, times_tested, contradictions,
        centrality, state, violations,
        retracted, tags, session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
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
      body.tags ? JSON.stringify(body.tags) : null,
      sessionId || null,
      now
    ).run();

    // After INSERT: edges (batched) and version recording flow independently
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
        starting_confidence: startingConfidence,
        confirmations: 0,
        times_tested: 0,
        contradictions: 0,
        centrality: 0,
        state: 'active',
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
    return startingConfidence;
  })();

  // Vectorize upserts flow as soon as embeddings resolve — don't wait for D1
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

  logField(c, 'memory_id', id);
  logField(c, 'type', 'memory');
  if (hasSource) logField(c, 'source', normalizedSource);
  if (hasDerivedFrom) logField(c, 'derived_from', body.derived_from);

  // Sync mode: need everything settled before exposure check
  if (syncMode) {
    const [embeddings] = await Promise.all([vectorizeP, d1WriteP]);
    logOperation(c, 'exposure', 'sync_check', { entity_id: id });

    await c.env.DB.prepare(`
      UPDATE memories
      SET exposure_check_status = 'processing', updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();

    try {
      let exposureResult: ExposureCheckResult;

      if (hasSource) {
        exposureResult = await checkExposures(c.env, id, body.content, embeddings.content);
      } else {
        exposureResult = await checkExposuresForNewThought(
          c.env, id, body.content,
          body.invalidates_if || [],
          body.confirms_if || [],
          timeBound
        );
      }

      const completedAt = Date.now();
      await c.env.DB.prepare(`
        UPDATE memories
        SET exposure_check_status = 'completed', exposure_check_completed_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(completedAt, completedAt, id).run();

      logField(c, 'violations', exposureResult.violations.length);
      logField(c, 'confirmations', exposureResult.confirmations.length);

      return c.json({
        success: true,
        id,
        time_bound: timeBound || undefined,
        exposure_check: 'queued',
        exposure_result: exposureResult,
      } satisfies ObserveResponse, 201);
    } catch (error) {
      logError('sync_exposure_check_failed', error instanceof Error ? error : String(error));
    }
  }

  // Async mode: queue send only needs embeddings — flows as soon as they're ready
  // D1 writes and vectorize upserts continue in parallel
  const embedding = (await embeddingsP).content;

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

  // Queue send, D1 writes, and vectorize upserts all settle together
  await Promise.all([
    c.env.DETECTION_QUEUE.send(exposureJob),
    d1WriteP,
    vectorizeP,
  ]);

  logOperation(c, 'exposure', 'queued', { entity_id: id });

  return c.json({
    success: true,
    id,
    time_bound: timeBound || undefined,
    exposure_check: 'queued',
  } satisfies ObserveResponse, 201);
});

export default app;
