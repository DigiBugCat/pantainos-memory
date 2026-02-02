/**
 * Brittle Route - GET /api/brittle
 *
 * List memories that are high-confidence but have low exposure.
 * These are memories that "look good" but haven't been tested much -
 * they need more exposure to validate their reliability.
 *
 * Query params:
 *   - max_times_tested: upper bound for times_tested (default: 10)
 *   - min_confidence: minimum confidence ratio (default: 0.7)
 *   - limit: max results (default: 50)
 */

import { Hono } from 'hono';
import type { Env, MemoryRow, BrittleResponse } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { rowToMemory } from '../../lib/transforms.js';
import { getConfidenceStats, getEffectiveConfidence } from '../../services/confidence.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const maxExposures = parseInt(c.req.query('max_times_tested') || '10', 10);
  const minConfidence = parseFloat(c.req.query('min_confidence') || '0.7');
  const limit = parseInt(c.req.query('limit') || '50', 10);

  // Get memories with:
  // - times_tested > 0 (has been tested at least once)
  // - times_tested <= maxExposures (not tested much)
  // - confirmations/times_tested >= minConfidence (high confidence)
  // Exclude retracted memories and observations (which don't have invalidates_if)
  const query = `
    SELECT * FROM memories
    WHERE retracted = 0
    AND times_tested > 0
    AND times_tested <= ?
    AND CAST(confirmations AS REAL) / times_tested >= ?
    ORDER BY
      (CAST(confirmations AS REAL) / times_tested) DESC,
      times_tested ASC
    LIMIT ?
  `;

  const result = await c.env.DB.prepare(query)
    .bind(maxExposures, minConfidence, limit)
    .all<MemoryRow>();

  const memories: BrittleResponse['memories'] = [];

  for (const row of result.results || []) {
    const memory = rowToMemory(row);
    const stats = getConfidenceStats(memory);
    const confidence = getEffectiveConfidence(memory);

    // Determine reason for brittleness
    let reason: string;
    if (memory.times_tested === 1) {
      reason = 'Only tested once - needs more exposure';
    } else if (memory.times_tested < 5) {
      reason = `Few tests (${memory.times_tested}) - confidence may be overstated`;
    } else {
      reason = `Limited testing (${memory.times_tested} times_tested) for ${Math.round(confidence * 100)}% confidence`;
    }

    memories.push({
      memory,
      stats,
      reason,
    });
  }

  // Get total count of brittle memories
  const totalResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories
     WHERE retracted = 0
     AND times_tested > 0
     AND times_tested <= ?
     AND CAST(confirmations AS REAL) / times_tested >= ?`
  ).bind(maxExposures, minConfidence).first<{ count: number }>();

  const response: BrittleResponse = {
    memories,
    total: totalResult?.count || memories.length,
  };

  return c.json(response);
});

export default app;
