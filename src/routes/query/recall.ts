/**
 * Recall Route - GET /api/recall/:id
 *
 * Retrieve a memory by ID with its connections and confidence stats.
 */

import { Hono } from 'hono';
import type {
  Env,
  MemoryEdge,
  RecallResponse,
} from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { recordAccess } from '../../services/access-service.js';
import { getConfidenceStats } from '../../services/confidence.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { recallMemory } from '../../usecases/recall-memory.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  agentId: string;
  memoryScope: string[];
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

  const recallResult = await recallMemory(c.env.DB, id);
  if (!recallResult) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  // Scope gate: only return if agent_id is in caller's scope
  const memoryScope = c.get('memoryScope');
  if (!memoryScope.includes(recallResult.row.agent_id)) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  const { memory, edges: edgeRows, connections } = recallResult;
  const stats = getConfidenceStats(memory);

  const edges: MemoryEdge[] = edgeRows.map(r => ({
    id: r.id,
    source_id: r.source_id,
    target_id: r.target_id,
    edge_type: r.edge_type as MemoryEdge['edge_type'],
    strength: r.strength,
    created_at: r.created_at,
  }));

  // Record access event for audit trail
  await recordAccess(c.env.DB, {
    entityId: id,
    entityType: getDisplayType(memory),
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
