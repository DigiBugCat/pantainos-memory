/**
 * Reference Route - GET /api/reference/:id
 *
 * Traverse the edge graph from a memory.
 * Returns connected memories following the DAG.
 */

import { Hono } from 'hono';
import type { Env, EdgeRow, MemoryRow, EdgeType } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { rowToMemory } from '../../lib/transforms.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { fetchEdgesBySourceIds, fetchEdgesByTargetIds, fetchMemoriesByIds } from '../../lib/sql-utils.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  agentId: string;
  memoryScope: string[];
};

/** Display type for memory entities */
type DisplayType = 'memory';

interface GraphNode {
  id: string;
  type: DisplayType;
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
  const visited = new Set<string>([id]);

  // Start from the given memory
  const rootRow = await c.env.DB.prepare(
    `SELECT * FROM memories WHERE id = ?`
  ).bind(id).first<MemoryRow>();

  if (!rootRow) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  // Scope gate on root entry point
  const memoryScope = c.get('memoryScope');
  if (!memoryScope.includes(rootRow.agent_id)) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  const rootMemory = rowToMemory(rootRow);

  nodes.set(id, {
    id,
    type: getDisplayType(rootMemory),
    content: rootMemory.content,
    depth: 0,
  });

  // Traverse the graph layer-by-layer with batched DB fetches.
  let frontier = [id];
  let depth = 0;
  const edgeSeen = new Set<string>();

  while (frontier.length > 0 && depth < maxDepth) {
    const [incoming, outgoing] = await Promise.all([
      (direction === 'up' || direction === 'both')
        ? fetchEdgesByTargetIds<EdgeRow>(c.env.DB, frontier)
        : Promise.resolve([] as EdgeRow[]),
      (direction === 'down' || direction === 'both')
        ? fetchEdgesBySourceIds<EdgeRow>(c.env.DB, frontier)
        : Promise.resolve([] as EdgeRow[]),
    ]);

    const nextIds: string[] = [];

    for (const row of incoming) {
      const key = `${row.source_id}:${row.target_id}:${row.edge_type}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({
          source: row.source_id,
          target: row.target_id,
          type: row.edge_type as EdgeType,
          strength: row.strength,
        });
      }
      if (!visited.has(row.source_id)) {
        nextIds.push(row.source_id);
      }
    }

    for (const row of outgoing) {
      const key = `${row.source_id}:${row.target_id}:${row.edge_type}`;
      if (!edgeSeen.has(key)) {
        edgeSeen.add(key);
        edges.push({
          source: row.source_id,
          target: row.target_id,
          type: row.edge_type as EdgeType,
          strength: row.strength,
        });
      }
      if (!visited.has(row.target_id)) {
        nextIds.push(row.target_id);
      }
    }

    const uniqueNextIds = [...new Set(nextIds)];
    if (uniqueNextIds.length === 0) break;

    const nextRows = await fetchMemoriesByIds<MemoryRow>(c.env.DB, uniqueNextIds, {
      includeRetracted: false,
    });

    for (const row of nextRows) {
      if (!nodes.has(row.id)) {
        const mem = rowToMemory(row);
        nodes.set(row.id, {
          id: row.id,
          type: getDisplayType(mem),
          content: mem.content,
          depth: depth + 1,
        });
      }
    }

    for (const nextId of uniqueNextIds) {
      visited.add(nextId);
    }

    frontier = uniqueNextIds;
    depth += 1;
  }

  return c.json({
    success: true,
    root: id,
    nodes: Array.from(nodes.values()),
    edges,
  });
});

export default app;
