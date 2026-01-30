/**
 * Recall Route - GET /api/recall/:id
 *
 * Retrieve a memory by ID with its connections and confidence stats.
 */

import { Hono } from 'hono';
import type {
  Env,
  MemoryRow,
  EdgeRow,
  MemoryEdge,
  Memory,
  RecallResponse,
} from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { recordAccess } from '../../services/access-service.js';
import { rowToMemory } from '../../lib/transforms.js';
import { getConfidenceStats } from '../../services/confidence.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:id', async (c) => {
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');

  const id = c.req.param('id');

  if (!id) {
    return c.json({ success: false, error: 'id is required' }, 400);
  }

  // Fetch memory from unified table
  const row = await c.env.DB.prepare(
    `SELECT * FROM memories WHERE id = ?`
  ).bind(id).first<MemoryRow>();

  if (!row) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  const memory = rowToMemory(row);
  const stats = getConfidenceStats(memory);

  // Get edges (what this memory is derived from and what derives from it)
  const edgeRows = await c.env.DB.prepare(
    `SELECT * FROM edges WHERE source_id = ? OR target_id = ?`
  ).bind(id, id).all<EdgeRow>();

  const edges: MemoryEdge[] = (edgeRows.results || []).map(r => ({
    id: r.id,
    source_id: r.source_id,
    target_id: r.target_id,
    edge_type: r.edge_type as MemoryEdge['edge_type'],
    strength: r.strength,
    created_at: r.created_at,
  }));

  // Fetch connected memories
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source_id !== id) connectedIds.add(edge.source_id);
    if (edge.target_id !== id) connectedIds.add(edge.target_id);
  }

  const connections: Memory[] = [];
  for (const connectedId of connectedIds) {
    const connectedRow = await c.env.DB.prepare(
      `SELECT * FROM memories WHERE id = ? AND retracted = 0`
    ).bind(connectedId).first<MemoryRow>();
    if (connectedRow) {
      connections.push(rowToMemory(connectedRow));
    }
  }

  // Record access event for audit trail
  await recordAccess(c.env.DB, {
    entityId: id,
    entityType: memory.memory_type,
    accessType: 'recall',
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  const response: RecallResponse = {
    memory,
    stats,
    edges,
    connections,
  };

  return c.json(response);
});

export default app;
