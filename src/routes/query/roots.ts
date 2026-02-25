/**
 * Roots Route - GET /api/roots/:id
 *
 * Trace any memory back to all root memories it derives from.
 * Uses recursive traversal of the edge DAG.
 */

import { Hono } from 'hono';
import type { Env, MemoryRow, EdgeRow, Memory } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { rowToMemory } from '../../lib/transforms.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { fetchEdgesByTargetIds, fetchMemoriesByIds } from '../../lib/sql-utils.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  agentId: string;
  memoryScope: string[];
};

/** Display type for memory entities */
type DisplayType = 'memory';

export interface RootsResponse {
  memory: {
    id: string;
    type: DisplayType;
    content: string;
  };
  roots: Memory[];
  pathDepth: number;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:id', async (c) => {
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

  // Scope gate on entry point
  const memoryScope = c.get('memoryScope');
  if (!memoryScope.includes(row.agent_id)) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  const memory = rowToMemory(row);

  // If this memory has no derivation chain, it's already a root
  if (!memory.derived_from || memory.derived_from.length === 0) {
    const response: RootsResponse = {
      memory: {
        id,
        type: getDisplayType(memory),
        content: memory.content,
      },
      roots: [memory],
      pathDepth: 0,
    };
    return c.json(response);
  }

  // Trace up the edge DAG to find all roots with batched layer fetches.
  const visited = new Set<string>([id]);
  const nodeDepth = new Map<string, number>([[id, 0]]);
  const rootIds = new Set<string>();
  let frontier = [id];

  while (frontier.length > 0) {
    const derivedFrom = await fetchEdgesByTargetIds<Pick<EdgeRow, 'source_id' | 'target_id' | 'edge_type'>>(
      c.env.DB,
      frontier,
      ['derived_from']
    );

    const parentMap = new Map<string, string[]>();
    for (const edge of derivedFrom) {
      const parents = parentMap.get(edge.target_id) || [];
      parents.push(edge.source_id);
      parentMap.set(edge.target_id, parents);
    }

    const nextFrontier: string[] = [];
    for (const childId of frontier) {
      const parents = parentMap.get(childId) || [];
      if (parents.length === 0) {
        rootIds.add(childId);
      } else {
        const childDepth = nodeDepth.get(childId) || 0;
        for (const parentId of parents) {
          if (visited.has(parentId)) continue;
          visited.add(parentId);
          nodeDepth.set(parentId, childDepth + 1);
          nextFrontier.push(parentId);
        }
      }
    }

    frontier = nextFrontier;
  }

  const rootRows = await fetchMemoriesByIds<MemoryRow>(c.env.DB, [...rootIds], {
    includeRetracted: false,
  });
  const roots: Memory[] = rootRows.map((r) => rowToMemory(r));
  const maxDepth = roots.reduce((acc, r) => Math.max(acc, nodeDepth.get(r.id) || 0), 0);

  const response: RootsResponse = {
    memory: {
      id,
      type: getDisplayType(memory),
      content: memory.content,
    },
    roots,
    pathDepth: maxDepth,
  };

  return c.json(response);
});

export default app;
