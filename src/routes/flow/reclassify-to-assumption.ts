/**
 * Reclassify to Assumption Route - POST /api/flow/reclassify-to-assumption/:id
 *
 * Converts an observation to an assumption.
 *
 * Validation:
 * - Memory must exist and be memory_type = 'obs'
 * - Memory must not be retracted
 * - All derived_from IDs must exist and not be retracted
 * - If resolves_by set, outcome_condition required
 * - No circular dependencies (derived_from can't include self)
 *
 * Actions:
 * 1. Create derived_from edges to source memories
 * 2. Increment centrality of source memories
 * 3. Update memories table: set memory_type = 'assumption', clear source, add assumption fields
 * 4. Update embeddings via updateMemoryTypeEmbeddings
 * 5. Record version with changeType: 'reclassified_as_assumption'
 */

import { Hono } from 'hono';
import type {
  ReclassifyToAssumptionRequest,
  ReclassifyToAssumptionResponse,
} from '../../lib/shared/types/index.js';
import { logField, logOperation } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateId } from '../../lib/id.js';
import { updateMemoryTypeEmbeddings } from '../../services/embedding-tables.js';
import { recordVersion } from '../../services/history-service.js';
import { incrementCentrality } from '../../services/exposure-checker.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/:id', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');
  const memoryId = c.req.param('id');

  // Validate request
  let body: ReclassifyToAssumptionRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.derived_from || !Array.isArray(body.derived_from) || body.derived_from.length === 0) {
    return c.json({ success: false, error: 'derived_from is required and must be a non-empty array' }, 400);
  }

  if (!body.reason || typeof body.reason !== 'string') {
    return c.json({ success: false, error: 'reason is required' }, 400);
  }

  // Check for self-reference
  if (body.derived_from.includes(memoryId)) {
    return c.json({ success: false, error: 'derived_from cannot include the memory being reclassified' }, 400);
  }

  // Time-bound validation
  const timeBound = body.resolves_by !== undefined;
  if (timeBound && (!body.outcome_condition || typeof body.outcome_condition !== 'string')) {
    return c.json({ success: false, error: 'outcome_condition is required for time-bound assumptions (when resolves_by is set)' }, 400);
  }

  // Get current memory state
  const memory = await c.env.DB.prepare(
    `SELECT id, memory_type, content, retracted FROM memories WHERE id = ?`
  ).bind(memoryId).first<{
    id: string;
    memory_type: string;
    content: string;
    retracted: number;
  }>();

  if (!memory) {
    return c.json({ success: false, error: `Memory not found: ${memoryId}` }, 404);
  }

  if (memory.memory_type !== 'obs') {
    return c.json(
      { success: false, error: `Memory is already type '${memory.memory_type}', not 'obs'` },
      400
    );
  }

  if (memory.retracted === 1) {
    return c.json({ success: false, error: 'Cannot reclassify a retracted memory' }, 400);
  }

  // Verify all source IDs exist and are not retracted
  const sourceIds = body.derived_from;
  const placeholders = sourceIds.map(() => '?').join(',');
  const sources = await c.env.DB.prepare(
    `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
  ).bind(...sourceIds).all<{ id: string }>();

  if (!sources.results || sources.results.length !== sourceIds.length) {
    const foundIds = new Set(sources.results?.map((r) => r.id) || []);
    const missing = sourceIds.filter((id) => !foundIds.has(id));
    return c.json(
      { success: false, error: `Source memories not found or retracted: ${missing.join(', ')}` },
      404
    );
  }

  // Check for circular dependencies - verify none of the sources depend on this memory
  // This is a simplified check - we look one level deep
  const dependencyCheck = await c.env.DB.prepare(
    `SELECT target_id FROM edges
     WHERE source_id = ? AND edge_type = 'derived_from'
     AND target_id IN (${placeholders})`
  ).bind(memoryId, ...sourceIds).all<{ target_id: string }>();

  if (dependencyCheck.results && dependencyCheck.results.length > 0) {
    const circular = dependencyCheck.results.map(r => r.target_id);
    return c.json(
      { success: false, error: `Circular dependency detected: ${circular.join(', ')} already depend on this memory` },
      400
    );
  }

  const now = Date.now();

  // 1. Create derived_from edges and increment centrality
  let edgesCreated = 0;
  for (const sourceId of sourceIds) {
    const edgeId = generateId('edge');
    await c.env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
       VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
    ).bind(edgeId, sourceId, memoryId, now).run();

    await incrementCentrality(c.env.DB, sourceId);
    edgesCreated++;
  }

  // 2. Update memories table
  await c.env.DB.prepare(
    `UPDATE memories
     SET memory_type = 'assumption',
         source = NULL,
         invalidates_if = ?,
         confirms_if = ?,
         outcome_condition = ?,
         resolves_by = ?,
         updated_at = ?
     WHERE id = ?`
  ).bind(
    body.invalidates_if ? JSON.stringify(body.invalidates_if) : null,
    body.confirms_if ? JSON.stringify(body.confirms_if) : null,
    body.outcome_condition || null,
    body.resolves_by || null,
    now,
    memoryId
  ).run();

  // 3. Update embeddings
  await updateMemoryTypeEmbeddings(c.env, c.env.AI, config, {
    id: memoryId,
    content: memory.content,
    newType: 'assumption',
    invalidates_if: body.invalidates_if,
    confirms_if: body.confirms_if,
    resolves_by: body.resolves_by,
    requestId,
  });

  // 4. Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: memoryId,
    entityType: 'assumption',
    changeType: 'reclassified_as_assumption',
    contentSnapshot: {
      id: memoryId,
      memory_type: 'assumption',
      content: memory.content,
      derived_from: sourceIds,
      invalidates_if: body.invalidates_if,
      confirms_if: body.confirms_if,
      outcome_condition: body.outcome_condition,
      resolves_by: body.resolves_by,
      previous_type: 'obs',
      edges_created: edgesCreated,
      time_bound: timeBound,
    },
    changeReason: body.reason,
    changedFields: ['memory_type', 'source', 'invalidates_if', 'confirms_if', 'outcome_condition', 'resolves_by'],
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  logField(c, 'memory_id', memoryId);
  logField(c, 'previous_type', 'obs');
  logField(c, 'new_type', 'assumption');
  logField(c, 'edges_created', edgesCreated);
  logField(c, 'time_bound', timeBound);
  logOperation(c, 'reclassify', 'to_assumption', { entity_id: memoryId });

  const response: ReclassifyToAssumptionResponse = {
    success: true,
    memory_id: memoryId,
    previous_type: 'obs',
    new_type: 'assumption',
    derived_from: sourceIds,
    time_bound: timeBound,
    edges_created: edgesCreated,
  };

  return c.json(response, 200);
});

export default app;
