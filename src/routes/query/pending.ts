/**
 * Pending Route - GET /api/pending
 *
 * List predictions past their resolves_by deadline that haven't been tested much.
 * These are predictions that need resolution.
 *
 * Query params:
 *   - overdue: if 'true', only return overdue predictions (default: false)
 *   - limit: max predictions to return (default: 50)
 */

import { Hono } from 'hono';
import type { Env, MemoryRow, PendingResponse } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { rowToMemory } from '../../lib/transforms.js';
import { getConfidenceStats } from '../../services/confidence.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const overdueOnly = c.req.query('overdue') === 'true';
  const limit = parseInt(c.req.query('limit') || '50', 10);

  const now = Date.now();

  // Get predictions from unified memories table
  // Predictions are memories with resolves_by IS NOT NULL
  let query: string;
  let params: (number | string)[];

  if (overdueOnly) {
    query = `
      SELECT * FROM memories
      WHERE resolves_by IS NOT NULL
      AND retracted = 0
      AND resolves_by < ?
      ORDER BY resolves_by ASC
      LIMIT ?
    `;
    params = [now, limit];
  } else {
    query = `
      SELECT * FROM memories
      WHERE resolves_by IS NOT NULL
      AND retracted = 0
      ORDER BY resolves_by ASC
      LIMIT ?
    `;
    params = [limit];
  }

  const result = await c.env.DB.prepare(query).bind(...params).all<MemoryRow>();

  const predictions: PendingResponse['predictions'] = [];

  for (const row of result.results || []) {
    const memory = rowToMemory(row);
    const stats = getConfidenceStats(memory);
    const daysOverdue = memory.resolves_by
      ? Math.max(0, Math.floor((now - memory.resolves_by) / (24 * 60 * 60 * 1000)))
      : 0;

    predictions.push({
      memory,
      stats,
      days_overdue: daysOverdue,
    });
  }

  // Get total count of predictions
  const totalResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE resolves_by IS NOT NULL AND retracted = 0`
  ).first<{ count: number }>();

  const response: PendingResponse = {
    predictions,
    total: totalResult?.count || predictions.length,
  };

  return c.json(response);
});

export default app;
