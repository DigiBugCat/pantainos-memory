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

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
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

  // Trace up the edge DAG to find all roots (memories with no parents)
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
 * Recursively trace up the edge DAG to find root memories (no parents).
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

  // If no parents, this is a root
  if (!derivedFrom.results || derivedFrom.results.length === 0) {
    const row = await db.prepare(
      `SELECT * FROM memories WHERE id = ? AND retracted = 0`
    ).bind(memoryId).first<MemoryRow>();

    if (row && !roots.some(r => r.id === memoryId)) {
      roots.push(rowToMemory(row));
      updateMaxDepth(depth);
    }
    return;
  }

  // Trace up from each parent
  for (const parent of derivedFrom.results) {
    await traceToRoots(db, parent.source_id, depth + 1, visited, roots, updateMaxDepth);
  }
}

export default app;
