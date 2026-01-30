/**
 * Collisions Route - GET /api/collisions
 *
 * List memories that have been violated by observations.
 * In the new architecture, violations are stored as an array within memories.
 *
 * Query params:
 *   - limit: max collisions to return (default: 50)
 */

import { Hono } from 'hono';
import type { Env, MemoryRow, MemoryType, Violation } from '../../types/index.js';
import type { Config } from '../../lib/config.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export interface CollisionInfo {
  memoryId: string;
  memoryType: MemoryType;
  content: string;
  violation: Violation;
}

export interface CollisionsResponse {
  collisions: CollisionInfo[];
  total: number;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);

  // Get memories that have violations
  const result = await c.env.DB.prepare(`
    SELECT id, memory_type, content, violations
    FROM memories
    WHERE retracted = 0
    AND violations != '[]'
    ORDER BY updated_at DESC
    LIMIT ?
  `).bind(limit * 2).all<Pick<MemoryRow, 'id' | 'memory_type' | 'content' | 'violations'>>();

  const collisions: CollisionInfo[] = [];

  for (const row of result.results || []) {
    const violations: Violation[] = JSON.parse(row.violations || '[]');

    // Add each violation as a separate collision entry
    for (const violation of violations) {
      collisions.push({
        memoryId: row.id,
        memoryType: row.memory_type as MemoryType,
        content: row.content,
        violation,
      });
      if (collisions.length >= limit) break;
    }
    if (collisions.length >= limit) break;
  }

  // Sort by violation timestamp descending
  collisions.sort((a, b) => b.violation.timestamp - a.violation.timestamp);

  // Get total count of memories with violations
  const totalResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND violations != '[]'`
  ).first<{ count: number }>();

  const response: CollisionsResponse = {
    collisions: collisions.slice(0, limit),
    total: totalResult?.count || collisions.length,
  };

  return c.json(response);
});

export default app;
