/**
 * Reclassify to Observation Route - POST /api/flow/reclassify-to-observation/:id
 *
 * Converts an assumption to an observation.
 *
 * Validation:
 * - Memory must exist and be memory_type = 'assumption'
 * - Memory must be state = 'active' (can't convert violated/confirmed memories)
 * - Memory must not be retracted
 * - source is required
 *
 * Actions:
 * 1. Delete incoming derived_from edges (this memory was derived from others)
 * 2. Update memories table: set memory_type = 'obs', source, clear assumption fields
 * 3. Update embeddings via updateMemoryTypeEmbeddings
 * 4. Record version with changeType: 'reclassified_as_observation'
 */

import { Hono } from 'hono';
import type {
  ReclassifyToObservationRequest,
  ReclassifyToObservationResponse,
  ObservationSource,
} from '../../lib/shared/types/index.js';
import { logField, logOperation } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { updateMemoryTypeEmbeddings } from '../../services/embedding-tables.js';
import { recordVersion } from '../../services/history-service.js';
import { decrementCentrality } from '../../services/exposure-checker.js';

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

app.post('/:id', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');
  const memoryId = c.req.param('id');

  // Validate request
  let body: ReclassifyToObservationRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.source || !VALID_SOURCES.includes(body.source as typeof VALID_SOURCES[number])) {
    return c.json(
      { success: false, error: `source must be one of: ${VALID_SOURCES.join(', ')}` },
      400
    );
  }

  if (!body.reason || typeof body.reason !== 'string') {
    return c.json({ success: false, error: 'reason is required' }, 400);
  }

  // Get current memory state
  const memory = await c.env.DB.prepare(
    `SELECT id, memory_type, content, state, retracted FROM memories WHERE id = ?`
  ).bind(memoryId).first<{
    id: string;
    memory_type: string;
    content: string;
    state: string;
    retracted: number;
  }>();

  if (!memory) {
    return c.json({ success: false, error: `Memory not found: ${memoryId}` }, 404);
  }

  if (memory.memory_type !== 'assumption') {
    return c.json(
      { success: false, error: `Memory is already type '${memory.memory_type}', not 'assumption'` },
      400
    );
  }

  if (memory.state !== 'active') {
    return c.json(
      { success: false, error: `Cannot reclassify memory with state '${memory.state}'. Only 'active' memories can be reclassified.` },
      400
    );
  }

  if (memory.retracted === 1) {
    return c.json({ success: false, error: 'Cannot reclassify a retracted memory' }, 400);
  }

  const now = Date.now();

  // 1. Delete incoming derived_from edges (this memory was derived from others)
  // First, get the source IDs so we can decrement their centrality
  const incomingEdges = await c.env.DB.prepare(
    `SELECT source_id FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
  ).bind(memoryId).all<{ source_id: string }>();

  const edgesRemoved = incomingEdges.results?.length || 0;

  // Decrement centrality for each source
  for (const edge of incomingEdges.results || []) {
    await decrementCentrality(c.env.DB, edge.source_id);
  }

  // Delete the edges
  await c.env.DB.prepare(
    `DELETE FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
  ).bind(memoryId).run();

  // 2. Update memories table
  await c.env.DB.prepare(
    `UPDATE memories
     SET memory_type = 'obs',
         source = ?,
         assumes = NULL,
         invalidates_if = NULL,
         confirms_if = NULL,
         outcome_condition = NULL,
         resolves_by = NULL,
         updated_at = ?
     WHERE id = ?`
  ).bind(body.source, now, memoryId).run();

  // 3. Update embeddings
  await updateMemoryTypeEmbeddings(c.env, c.env.AI, config, {
    id: memoryId,
    content: memory.content,
    newType: 'obs',
    source: body.source,
    requestId,
  });

  // 4. Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: memoryId,
    entityType: 'obs',
    changeType: 'reclassified_as_observation',
    contentSnapshot: {
      id: memoryId,
      memory_type: 'obs',
      content: memory.content,
      source: body.source,
      previous_type: 'assumption',
      edges_removed: edgesRemoved,
    },
    changeReason: body.reason,
    changedFields: ['memory_type', 'source', 'assumes', 'invalidates_if', 'confirms_if', 'outcome_condition', 'resolves_by'],
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  logField(c, 'memory_id', memoryId);
  logField(c, 'previous_type', 'assumption');
  logField(c, 'new_type', 'obs');
  logField(c, 'edges_removed', edgesRemoved);
  logOperation(c, 'reclassify', 'to_observation', { entity_id: memoryId });

  const response: ReclassifyToObservationResponse = {
    success: true,
    memory_id: memoryId,
    previous_type: 'assumption',
    new_type: 'obs',
    source: body.source as ObservationSource,
    edges_removed: edgesRemoved,
  };

  return c.json(response, 200);
});

export default app;
