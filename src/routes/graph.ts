/**
 * Graph Route - GET /api/graph
 *
 * Get full knowledge graph (all memories and edges).
 * Used by graph viewer for initial dashboard load.
 *
 * v4: Queries unified memories table and edges table.
 */

import { Hono } from 'hono';
import type { Env, EntityType } from '../types/index.js';

const app = new Hono<{ Bindings: Env }>();

interface GraphEntity {
  id: string;
  content: string;
  type: EntityType;
  tags: string[];
  created_at: number;
  source?: string;
  state?: string;
  exposures: number;
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
  const [
    memories,
    edges,
    edgeCounts,
    accessCounts,
  ] = await Promise.all([
    // All active memories
    c.env.DB.prepare(`
      SELECT id, content, memory_type as type, source, state, tags,
             exposures, confirmations, created_at
      FROM memories
      WHERE retracted = 0
      ORDER BY created_at DESC
      LIMIT 1000
    `).all<{
      id: string;
      content: string;
      type: string;
      source: string | null;
      state: string;
      tags: string | null;
      exposures: number;
      confirmations: number;
      created_at: number;
    }>(),

    // All edges
    c.env.DB.prepare(`
      SELECT source_id, target_id, strength
      FROM edges
    `).all<GraphEdge>(),

    // Edge count per entity (outgoing edges)
    c.env.DB.prepare(`
      SELECT source_id as entity_id, COUNT(*) as count
      FROM edges
      GROUP BY source_id
    `).all<{ entity_id: string; count: number }>(),

    // Access count per entity
    c.env.DB.prepare(`
      SELECT entity_id, COUNT(*) as count
      FROM access_events
      GROUP BY entity_id
    `).all<{ entity_id: string; count: number }>(),
  ]);

  // Build lookup maps for counts
  const edgeCountMap = new Map<string, number>();
  for (const row of edgeCounts.results || []) {
    edgeCountMap.set(row.entity_id, row.count);
  }

  const accessCountMap = new Map<string, number>();
  for (const row of accessCounts.results || []) {
    accessCountMap.set(row.entity_id, row.count);
  }

  // Build entities with counts
  const entities: GraphEntity[] = (memories.results || []).map(row => ({
    id: row.id,
    content: row.content,
    type: row.type as EntityType,
    source: row.source || undefined,
    state: row.state,
    tags: row.tags ? JSON.parse(row.tags) : [],
    exposures: row.exposures,
    confirmations: row.confirmations,
    created_at: row.created_at,
    edge_count: edgeCountMap.get(row.id) || 0,
    access_count: accessCountMap.get(row.id) || 0,
  }));

  return c.json({
    memories: entities,
    edges: edges.results || [],
    stats: {
      total_memories: entities.length,
      total_edges: edges.results?.length || 0,
    },
  });
});

export default app;
