/**
 * Graveyard Route - GET /api/graveyard
 *
 * Analyze patterns in violations across memories.
 * The "graveyard" is where violated thoughts go to teach us.
 *
 * Returns:
 *   - Common violated conditions
 *   - Sources that cause most violations
 *   - Patterns in what thoughts fail
 *
 * Query params:
 *   - group_by: 'condition' | 'source' | 'time_period' (default: condition)
 *   - limit: max patterns to return (default: 20)
 */

import { Hono } from 'hono';
import type {
  Env,
  MemoryRow,
  GraveyardResponse,
  ViolationPattern,
  Violation,
} from '../../types/index.js';
import type { Config } from '../../lib/config.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const groupBy = (c.req.query('group_by') || 'condition') as 'condition' | 'source' | 'time_period';
  const limit = parseInt(c.req.query('limit') || '20', 10);

  // Get all memories that have violations
  const result = await c.env.DB.prepare(
    `SELECT * FROM memories
     WHERE violations != '[]'
     ORDER BY updated_at DESC`
  ).all<MemoryRow>();

  // Collect all violations with their memory context
  interface ViolationWithContext {
    memoryId: string;
    memoryContent: string;
    violation: Violation;
  }

  const allViolations: ViolationWithContext[] = [];

  for (const row of result.results || []) {
    const violations: Violation[] = JSON.parse(row.violations || '[]');
    for (const violation of violations) {
      allViolations.push({
        memoryId: row.id,
        memoryContent: row.content,
        violation,
      });
    }
  }

  const totalViolations = allViolations.length;

  // Analyze patterns based on grouping
  const patterns: ViolationPattern[] = [];

  if (groupBy === 'condition') {
    // Group by violated condition
    const conditionMap = new Map<string, { count: number; examples: string[] }>();

    for (const v of allViolations) {
      const condition = v.violation.condition;
      const existing = conditionMap.get(condition);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 3) {
          existing.examples.push(v.memoryId);
        }
      } else {
        conditionMap.set(condition, { count: 1, examples: [v.memoryId] });
      }
    }

    // Sort by count and take top N
    const sorted = [...conditionMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, limit);

    for (const [condition, data] of sorted) {
      patterns.push({
        condition,
        count: data.count,
        example_ids: data.examples,
      });
    }
  } else if (groupBy === 'time_period') {
    // Group by month
    const periodMap = new Map<string, { count: number; examples: string[]; conditions: string[] }>();

    for (const v of allViolations) {
      const date = new Date(v.violation.timestamp);
      const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const existing = periodMap.get(period);
      if (existing) {
        existing.count++;
        if (existing.examples.length < 3) {
          existing.examples.push(v.memoryId);
        }
        if (!existing.conditions.includes(v.violation.condition)) {
          existing.conditions.push(v.violation.condition);
        }
      } else {
        periodMap.set(period, {
          count: 1,
          examples: [v.memoryId],
          conditions: [v.violation.condition],
        });
      }
    }

    const sorted = [...periodMap.entries()]
      .sort((a, b) => b[0].localeCompare(a[0])) // Most recent first
      .slice(0, limit);

    for (const [period, data] of sorted) {
      patterns.push({
        condition: `${period}: ${data.conditions.slice(0, 3).join(', ')}`,
        count: data.count,
        example_ids: data.examples,
      });
    }
  }

  // Always compute top conditions (regardless of grouping)
  const conditionCounts = new Map<string, number>();
  for (const v of allViolations) {
    const condition = v.violation.condition;
    conditionCounts.set(condition, (conditionCounts.get(condition) || 0) + 1);
  }
  const topConditions = [...conditionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([condition, count]) => ({ condition, count }));

  // Compute top sources (observations that caused most violations)
  const topSources = await computeTopSources(c.env.DB, allViolations.map(v => v.violation.obs_id));

  const response: GraveyardResponse = {
    patterns,
    total_violations: totalViolations,
    top_conditions: topConditions,
    top_sources: topSources,
  };

  return c.json(response);
});

/**
 * Compute which observation sources cause the most violations
 */
async function computeTopSources(
  db: D1Database,
  obsIds: string[]
): Promise<Array<{ source: string; count: number }>> {
  if (obsIds.length === 0) return [];

  // Deduplicate
  const uniqueIds = [...new Set(obsIds)];

  // Get sources for these observation IDs
  // Use IN clause with parameterized values
  const placeholders = uniqueIds.map(() => '?').join(',');
  const result = await db.prepare(
    `SELECT source, COUNT(*) as count FROM memories
     WHERE id IN (${placeholders})
     AND source IS NOT NULL
     GROUP BY source
     ORDER BY count DESC
     LIMIT 10`
  ).bind(...uniqueIds).all<{ source: string; count: number }>();

  return (result.results || []).map(row => ({
    source: row.source,
    count: row.count,
  }));
}

export default app;
