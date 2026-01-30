/**
 * Assume Route - POST /api/assume
 *
 * Create a unified assumption (replaces /infer and /predict).
 *
 * Assumptions are compressed beliefs derived from observations/other assumptions.
 * The presence of optional fields determines behavior:
 * - Without resolves_by → general assumption (was: inference)
 * - With resolves_by → time-bound assumption (was: prediction)
 *
 * Flow (Three-Table Architecture):
 * 1. Validate request
 * 2. Verify derived_from sources exist
 * 3. Store in D1 (memories table with memory_type = 'assumption', state = 'active')
 * 4. Create derivation edges
 * 5. Increment centrality of sources
 * 6. Store embeddings (three-table):
 *    - Content → MEMORY_VECTORS
 *    - invalidates_if conditions → INVALIDATES_VECTORS
 *    - confirms_if conditions → CONFIRMS_VECTORS (time-bound only)
 * 7. Queue bi-directional exposure check (find existing obs that might violate)
 * 8. Return response
 */

import { Hono } from 'hono';
import type { AssumptionRequest, AssumptionResponse, ExposureCheckJob, ExposureCheckResult } from '../../lib/shared/types/index.js';
import { logField, logOperation, logError } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateId } from '../../lib/id.js';
import { storeAssumptionEmbeddings } from '../../services/embedding-tables.js';
import { recordVersion } from '../../services/history-service.js';
import { incrementCentrality, checkExposuresForNewAssumption } from '../../services/exposure-checker.js';

/** Extended response type for sync mode */
interface AssumptionResponseWithSync extends AssumptionResponse {
  exposure_result?: ExposureCheckResult;
}

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');

  // Check for sync mode
  const syncMode = c.req.query('sync') === 'true';

  // Validate request
  let body: AssumptionRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.content || typeof body.content !== 'string') {
    return c.json({ success: false, error: 'content is required' }, 400);
  }

  if (!body.derived_from || !Array.isArray(body.derived_from) || body.derived_from.length === 0) {
    return c.json({ success: false, error: 'derived_from is required and must be a non-empty array' }, 400);
  }

  // Determine if this is a time-bound assumption
  const timeBound = body.resolves_by !== undefined;

  // Time-bound specific validations
  if (timeBound) {
    if (!body.outcome_condition || typeof body.outcome_condition !== 'string') {
      return c.json({ success: false, error: 'outcome_condition is required for time-bound assumptions' }, 400);
    }
    if (typeof body.resolves_by !== 'number') {
      return c.json({ success: false, error: 'resolves_by must be a Unix timestamp' }, 400);
    }
  }

  // Verify all source IDs exist
  const sourceIds = body.derived_from;
  const placeholders = sourceIds.map(() => '?').join(',');
  const sources = await c.env.DB.prepare(
    `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
  )
    .bind(...sourceIds)
    .all<{ id: string }>();

  if (!sources.results || sources.results.length !== sourceIds.length) {
    const foundIds = new Set(sources.results?.map((r) => r.id) || []);
    const missing = sourceIds.filter((id) => !foundIds.has(id));
    return c.json(
      { success: false, error: `Source memories not found: ${missing.join(', ')}` },
      404
    );
  }

  const now = Date.now();
  // ID prefix: time-bound (pred_) vs general (infer_) - preserves ID semantics
  const id = generateId(timeBound ? 'pred' : 'infer');

  // Store in D1 (unified memories table)
  await c.env.DB.prepare(
    `INSERT INTO memories (
      id, memory_type, content,
      assumes, invalidates_if, confirms_if,
      outcome_condition, resolves_by,
      confirmations, exposures, centrality, state, violations,
      retracted, tags, session_id, created_at
    ) VALUES (?, 'assumption', ?, ?, ?, ?, ?, ?, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
  ).bind(
    id,
    body.content,
    body.assumes ? JSON.stringify(body.assumes) : null,
    body.invalidates_if ? JSON.stringify(body.invalidates_if) : null,
    body.confirms_if ? JSON.stringify(body.confirms_if) : null,
    body.outcome_condition || null,
    body.resolves_by || null,
    body.tags ? JSON.stringify(body.tags) : null,
    sessionId || null,
    now
  ).run();

  // Create derivation edges and increment centrality of sources
  for (const sourceId of sourceIds) {
    const edgeId = generateId('edge');
    await c.env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
       VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
    ).bind(edgeId, sourceId, id, now).run();

    // Increment centrality of the source (it now has one more dependent)
    await incrementCentrality(c.env.DB, sourceId);
  }

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: id,
    entityType: 'assumption',
    changeType: 'created',
    contentSnapshot: {
      id,
      memory_type: 'assumption',
      content: body.content,
      assumes: body.assumes,
      invalidates_if: body.invalidates_if,
      confirms_if: body.confirms_if,
      outcome_condition: body.outcome_condition,
      resolves_by: body.resolves_by,
      tags: body.tags,
      derived_from: sourceIds,
      confirmations: 0,
      exposures: 0,
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
  });

  // Store embeddings in three tables
  const { embedding } = await storeAssumptionEmbeddings(c.env, c.env.AI, config, {
    id,
    content: body.content,
    invalidates_if: body.invalidates_if,
    confirms_if: body.confirms_if,
    assumes: body.assumes,
    resolves_by: body.resolves_by,
    requestId,
  });

  // Exposure checking: sync or async mode
  const hasConditions = (body.invalidates_if && body.invalidates_if.length > 0) ||
    (timeBound && body.confirms_if && body.confirms_if.length > 0);

  logField(c, 'memory_id', id);
  logField(c, 'time_bound', timeBound);
  logField(c, 'derived_from', sourceIds);

  if (hasConditions) {
    if (syncMode) {
      // Sync mode: run exposure check inline
      logOperation(c, 'exposure', 'sync_check', { entity_id: id });

      await c.env.DB.prepare(`
        UPDATE memories
        SET exposure_check_status = 'processing', updated_at = ?
        WHERE id = ?
      `).bind(now, id).run();

      try {
        const exposureResult = await checkExposuresForNewAssumption(
          c.env, id, body.content, body.invalidates_if || [], body.confirms_if || [], timeBound
        );

        const completedAt = Date.now();
        await c.env.DB.prepare(`
          UPDATE memories
          SET exposure_check_status = 'completed', exposure_check_completed_at = ?, updated_at = ?
          WHERE id = ?
        `).bind(completedAt, completedAt, id).run();

        logField(c, 'violations', exposureResult.violations.length);
        if (timeBound) {
          logField(c, 'resolves_by', new Date(body.resolves_by!).toISOString());
        }

        return c.json({
          success: true,
          id,
          time_bound: timeBound,
          exposure_result: exposureResult,
        } as AssumptionResponseWithSync, 201);
      } catch (error) {
        logError('sync_exposure_check_failed', error instanceof Error ? error : String(error));
      }
    } else {
      // Async mode: queue bi-directional exposure check
      const exposureJob: ExposureCheckJob = {
        memory_id: id,
        memory_type: 'assumption',
        content: body.content,
        embedding,
        session_id: sessionId,
        request_id: requestId,
        timestamp: now,
        invalidates_if: body.invalidates_if,
        confirms_if: body.confirms_if,
        time_bound: timeBound,
      };

      await c.env.DETECTION_QUEUE.send(exposureJob);
      logOperation(c, 'exposure', 'queued', { entity_id: id });
    }
  } else {
    // No conditions, mark as skipped
    await c.env.DB.prepare(`
      UPDATE memories
      SET exposure_check_status = 'skipped', updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();
    logField(c, 'exposure_check', 'skipped');
  }

  if (timeBound) {
    logField(c, 'resolves_by', new Date(body.resolves_by!).toISOString());
  }

  const response: AssumptionResponse = {
    success: true,
    id,
    time_bound: timeBound,
  };

  return c.json(response, 201);
});

export default app;
