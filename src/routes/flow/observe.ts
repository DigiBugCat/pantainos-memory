/**
 * Observe Route - POST /api/observe
 *
 * Create an observation (intake from reality). Observations:
 * - Are facts from the world (tools, market data, news, human input)
 * - Are root nodes in the derivation graph
 * - Can trigger exposure checks (test inferences/predictions)
 * - Can be retracted if discovered to be incorrect
 *
 * Flow (FAST - exposure checking queued for async processing):
 * 1. Validate request
 * 2. Store in D1 (memories table with memory_type = 'obs')
 * 3. Generate embedding (Workers AI) and store in MEMORY_VECTORS
 * 4. Queue bi-directional exposure check job
 * 5. Return response immediately
 *
 * Query params:
 * - sync=true: Run exposure check synchronously and return results in response
 *   (useful for testing, not recommended for production)
 *
 * Three-Table Architecture:
 * - Observation embeddings stored in MEMORY_VECTORS
 * - Exposure check searches INVALIDATES_VECTORS and CONFIRMS_VECTORS
 *   to find predictions this observation might break or confirm
 *
 * Queue Consumer (separate worker invocation via ExposureCheckWorkflow):
 * - Search invalidates_if conditions matching this observation
 * - Search confirms_if conditions matching this observation
 * - LLM-judge each match
 * - Update confidence metrics and state
 */

import { Hono } from 'hono';
import type {
  ObserveRequest,
  ObserveResponse,
  ExposureCheckJob,
  ExposureCheckResult,
} from '../../lib/shared/types/index.js';
import { logField, logOperation, logError } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateId } from '../../lib/id.js';
import { storeObservationEmbeddings } from '../../services/embedding-tables.js';
import { recordVersion } from '../../services/history-service.js';
import { checkExposures } from '../../services/exposure-checker.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Valid observation sources */
const VALID_SOURCES = ['market', 'news', 'earnings', 'email', 'human', 'tool'] as const;

/** Extended response type for sync mode */
interface ObserveResponseWithSync extends ObserveResponse {
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
  let body: ObserveRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.content || typeof body.content !== 'string') {
    return c.json({ success: false, error: 'content is required' }, 400);
  }

  if (!body.source || !VALID_SOURCES.includes(body.source as typeof VALID_SOURCES[number])) {
    return c.json(
      { success: false, error: `source must be one of: ${VALID_SOURCES.join(', ')}` },
      400
    );
  }

  const now = Date.now();
  const id = generateId('obs');

  // Store in D1 (unified memories table)
  // Note: state defaults to 'active' for new memories
  await c.env.DB.prepare(
    `INSERT INTO memories (
      id, memory_type, content, source,
      confirmations, exposures, centrality, state, violations,
      retracted, tags, session_id, created_at
    ) VALUES (?, 'obs', ?, ?, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
  ).bind(
    id,
    body.content,
    body.source,
    body.tags ? JSON.stringify(body.tags) : null,
    sessionId || null,
    now
  ).run();

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: id,
    entityType: 'obs',
    changeType: 'created',
    contentSnapshot: {
      id,
      memory_type: 'obs',
      content: body.content,
      source: body.source,
      tags: body.tags,
      confirmations: 0,
      exposures: 0,
      centrality: 0,
      state: 'active',
      violations: [],
      retracted: false,
    },
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  // Generate embedding and store in MEMORY_VECTORS (three-table architecture)
  const { embedding } = await storeObservationEmbeddings(c.env, c.env.AI, config, {
    id,
    content: body.content,
    source: body.source,
    requestId,
  });

  logField(c, 'memory_id', id);
  logField(c, 'source', body.source);

  // Sync mode: run exposure check inline and return results
  if (syncMode) {
    logOperation(c, 'exposure', 'sync_check', { entity_id: id });

    // Mark as processing
    await c.env.DB.prepare(`
      UPDATE memories
      SET exposure_check_status = 'processing', updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();

    try {
      // Run exposure check synchronously
      const exposureResult = await checkExposures(c.env, id, body.content, embedding);

      // Mark as completed
      const completedAt = Date.now();
      await c.env.DB.prepare(`
        UPDATE memories
        SET exposure_check_status = 'completed', exposure_check_completed_at = ?, updated_at = ?
        WHERE id = ?
      `).bind(completedAt, completedAt, id).run();

      logField(c, 'violations', exposureResult.violations.length);
      logField(c, 'confirmations', exposureResult.confirmations.length);

      const response: ObserveResponseWithSync = {
        success: true,
        id,
        exposure_check: 'queued', // For API compatibility
        exposure_result: exposureResult,
      };

      return c.json(response, 201);
    } catch (error) {
      logError('sync_exposure_check_failed', error instanceof Error ? error : String(error));

      // Still return success but note the failure
      const response: ObserveResponseWithSync = {
        success: true,
        id,
        exposure_check: 'queued',
      };

      return c.json(response, 201);
    }
  }

  // Async mode: queue bi-directional exposure check job
  // The workflow will search INVALIDATES_VECTORS and CONFIRMS_VECTORS
  // to find predictions this observation might break or confirm
  const exposureJob: ExposureCheckJob = {
    memory_id: id,
    memory_type: 'obs',
    content: body.content,
    embedding,
    session_id: sessionId,
    request_id: requestId,
    timestamp: now,
  };

  await c.env.DETECTION_QUEUE.send(exposureJob);
  logOperation(c, 'exposure', 'queued', { entity_id: id });

  // Return immediately - exposure checking runs in separate worker invocation
  const response: ObserveResponse = {
    success: true,
    id,
    exposure_check: 'queued',
  };

  return c.json(response, 201);
});

export default app;
