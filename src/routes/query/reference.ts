/**
 * Reference Route - GET /api/reference/:id
 *
 * Traverse the edge graph from a memory.
 * Returns connected memories following the DAG.
 */

import { Hono } from 'hono';
import type { Env, EdgeRow, MemoryRow, MemoryType, EdgeType } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { rowToMemory } from '../../lib/transforms.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

interface GraphNode {
  id: string;
  type: MemoryType;
  content: string;
  depth: number;
}

interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  strength: number;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:id', async (c) => {
  const id = c.req.param('id');
  const maxDepth = parseInt(c.req.query('depth') || '2', 10);
  const direction = c.req.query('direction') || 'both'; // 'up', 'down', 'both'

  if (!id) {
    return c.json({ success: false, error: 'id is required' }, 400);
  }

  const nodes: Map<string, GraphNode> = new Map();
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();

  // Start from the given memory
  const rootRow = await c.env.DB.prepare(
    `SELECT * FROM memories WHERE id = ?`
  ).bind(id).first<MemoryRow>();

  if (!rootRow) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  const rootMemory = rowToMemory(rootRow);

  nodes.set(id, {
    id,
    type: rootMemory.memory_type,
    content: rootMemory.content,
    depth: 0,
  });

  // Traverse the graph
  await traverse(c.env.DB, id, 0, maxDepth, direction, nodes, edges, visited);

  return c.json({
    success: true,
    root: id,
    nodes: Array.from(nodes.values()),
    edges,
  });
});

async function traverse(
  db: D1Database,
  memoryId: string,
  currentDepth: number,
  maxDepth: number,
  direction: string,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  visited: Set<string>
): Promise<void> {
  if (currentDepth >= maxDepth || visited.has(memoryId)) {
    return;
  }
  visited.add(memoryId);

  // Traverse up (what this memory is derived from)
  if (direction === 'up' || direction === 'both') {
    const derivedFrom = await db.prepare(
      `SELECT * FROM edges WHERE target_id = ?`
    ).bind(memoryId).all<EdgeRow>();

    for (const row of derivedFrom.results || []) {
      if (!nodes.has(row.source_id)) {
        const sourceRow = await db.prepare(
          `SELECT * FROM memories WHERE id = ? AND retracted = 0`
        ).bind(row.source_id).first<MemoryRow>();

        if (sourceRow) {
          const sourceMemory = rowToMemory(sourceRow);
          nodes.set(row.source_id, {
            id: row.source_id,
            type: sourceMemory.memory_type,
            content: sourceMemory.content,
            depth: currentDepth + 1,
          });
        }
      }

      edges.push({
        source: row.source_id,
        target: memoryId,
        type: row.edge_type as EdgeType,
        strength: row.strength,
      });

      await traverse(db, row.source_id, currentDepth + 1, maxDepth, 'up', nodes, edges, visited);
    }
  }

  // Traverse down (what derives from this memory)
  if (direction === 'down' || direction === 'both') {
    const derivesTo = await db.prepare(
      `SELECT * FROM edges WHERE source_id = ?`
    ).bind(memoryId).all<EdgeRow>();

    for (const row of derivesTo.results || []) {
      if (!nodes.has(row.target_id)) {
        const targetRow = await db.prepare(
          `SELECT * FROM memories WHERE id = ? AND retracted = 0`
        ).bind(row.target_id).first<MemoryRow>();

        if (targetRow) {
          const targetMemory = rowToMemory(targetRow);
          nodes.set(row.target_id, {
            id: row.target_id,
            type: targetMemory.memory_type,
            content: targetMemory.content,
            depth: currentDepth + 1,
          });
        }
      }

      edges.push({
        source: memoryId,
        target: row.target_id,
        type: row.edge_type as EdgeType,
        strength: row.strength,
      });

      await traverse(db, row.target_id, currentDepth + 1, maxDepth, 'down', nodes, edges, visited);
    }
  }
}

export default app;
