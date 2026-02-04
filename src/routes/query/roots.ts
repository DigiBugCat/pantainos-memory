/**
 * Roots Route - GET /api/roots/:id
 *
 * Trace any memory back to all root observations it derives from.
 * Uses recursive traversal of the edge DAG.
 */

import { Hono } from 'hono';
import type { Env, MemoryRow, EdgeRow, Memory } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { rowToMemory } from '../../lib/transforms.js';
import { getDisplayType, isObservation } from '../../lib/shared/types/index.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

/** Display type for memory entities */
type DisplayType = 'observation' | 'thought' | 'prediction';

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

  const memory = rowToMemory(row);

  // If this is already an observation, return it as its own root
  if (isObservation(memory)) {
    const response: RootsResponse = {
      memory: {
        id,
        type: 'observation',
        content: memory.content,
      },
      roots: [memory],
      pathDepth: 0,
    };
    return c.json(response);
  }

  // Trace up the edge DAG to find all roots (observations)
  const visited = new Set<string>();
  const roots: Memory[] = [];
  let maxDepth = 0;

  await traceToRoots(c.env.DB, id, 0, visited, roots, (depth) => {
    if (depth > maxDepth) maxDepth = depth;
  });

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

/**
 * Recursively trace up the edge DAG to find root observations.
 */
async function traceToRoots(
  db: D1Database,
  memoryId: string,
  depth: number,
  visited: Set<string>,
  roots: Memory[],
  updateMaxDepth: (depth: number) => void
): Promise<void> {
  if (visited.has(memoryId)) return;
  visited.add(memoryId);

  // Get what this memory is derived from
  const derivedFrom = await db.prepare(
    `SELECT source_id FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
  ).bind(memoryId).all<Pick<EdgeRow, 'source_id'>>();

  // If no parents, check if this is an observation (root)
  if (!derivedFrom.results || derivedFrom.results.length === 0) {
    // Check if this is an observation (source IS NOT NULL)
    const row = await db.prepare(
      `SELECT * FROM memories WHERE id = ? AND source IS NOT NULL AND retracted = 0`
    ).bind(memoryId).first<MemoryRow>();

    if (row && !roots.some(r => r.id === memoryId)) {
      roots.push(rowToMemory(row));
      updateMaxDepth(depth);
    }
    return;
  }

  // Trace up from each parent
  for (const parent of derivedFrom.results) {
    // Check if parent is an observation
    const parentRow = await db.prepare(
      `SELECT * FROM memories WHERE id = ? AND retracted = 0`
    ).bind(parent.source_id).first<MemoryRow>();

    if (!parentRow) continue;

    const parentMemory = rowToMemory(parentRow);
    if (isObservation(parentMemory)) {
      // It's an observation, so it's a root
      if (!roots.some(r => r.id === parent.source_id)) {
        roots.push(parentMemory);
        updateMaxDepth(depth + 1);
      }
    } else {
      // Continue tracing up
      await traceToRoots(db, parent.source_id, depth + 1, visited, roots, updateMaxDepth);
    }
  }
}

export default app;
