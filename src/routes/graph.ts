/**
 * Graph Route - GET /api/graph
 *
 * Get full knowledge graph (all memories and edges).
 * Used by graph viewer for initial dashboard load.
 *
 * v4: Queries unified memories table and edges table.
 */

import { Hono } from 'hono';
import type { Env } from '../types/index.js';
import { fetchEdgesBySourceIds, queryInChunks } from '../lib/sql-utils.js';

type Variables = {
  agentId: string;
  memoryScope: string[];
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Display type for graph nodes */
type DisplayType = 'memory';

interface GraphEntity {
  id: string;
  content: string;
  type: DisplayType;
  tags: string[];
  created_at: number;
  source?: string;
  state?: string;
  times_tested: number;
  confirmations: number;
  edge_count: number;
  access_count: number;
}

interface GraphEdge {
  source_id: string;
  target_id: string;
  strength: number;
}

/**
 * GET /api/graph - Get full graph (all entities and edges)
 * Used by graph viewer for initial dashboard load
 */
app.get('/', async (c) => {
  const scopeIds = c.get('memoryScope');
  const scopePlaceholders = scopeIds.map(() => '?').join(',');

  // All active memories in scope - derive type from field presence
  const memories = await c.env.DB.prepare(`
      SELECT id, content,
             CASE
               WHEN source IS NOT NULL THEN 'observation'
               WHEN resolves_by IS NOT NULL THEN 'prediction'
               WHEN derived_from IS NOT NULL THEN 'thought'
               ELSE 'observation'
             END as type,
             source, state, tags,
             times_tested, confirmations, created_at
      FROM memories
      WHERE retracted = 0 AND agent_id IN (${scopePlaceholders})
      ORDER BY created_at DESC
      LIMIT 1000
    `).bind(...scopeIds).all<{
    id: string;
    content: string;
    type: DisplayType;
    source: string | null;
    state: string;
    tags: string | null;
    times_tested: number;
    confirmations: number;
    created_at: number;
  }>();

  const memoryIds = (memories.results || []).map((m) => m.id);
  const memoryIdSet = new Set(memoryIds);
  const [edgesRaw, accessCounts] = await Promise.all([
    fetchEdgesBySourceIds<GraphEdge>(c.env.DB, memoryIds),
    queryInChunks<{ entity_id: string; count: number }>(
      c.env.DB,
      (placeholders) => `
        SELECT entity_id, COUNT(*) as count
        FROM access_events
        WHERE entity_id IN (${placeholders})
        GROUP BY entity_id
      `,
      memoryIds,
      [],
      [],
      1
    ),
  ]);
  const edges = edgesRaw.filter((edge) => memoryIdSet.has(edge.target_id));

  // Build lookup maps for counts
  const edgeCountMap = new Map<string, number>();
  for (const edge of edges) {
    edgeCountMap.set(edge.source_id, (edgeCountMap.get(edge.source_id) || 0) + 1);
  }

  const accessCountMap = new Map<string, number>();
  for (const row of accessCounts) {
    accessCountMap.set(row.entity_id, row.count);
  }

  // Build entities with counts
  const entities: GraphEntity[] = (memories.results || []).map(row => ({
    id: row.id,
    content: row.content,
    type: row.type,
    source: row.source || undefined,
    state: row.state,
    tags: row.tags ? JSON.parse(row.tags) : [],
    times_tested: row.times_tested,
    confirmations: row.confirmations,
    created_at: row.created_at,
    edge_count: edgeCountMap.get(row.id) || 0,
    access_count: accessCountMap.get(row.id) || 0,
  }));

  return c.json({
    memories: entities,
    edges,
    stats: {
      total_memories: entities.length,
      total_edges: edges.length,
    },
  });
});

export default app;
