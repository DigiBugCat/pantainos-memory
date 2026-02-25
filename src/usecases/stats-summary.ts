export interface StatsSummary {
  memories: {
    observation: number;
    thought: number;
    prediction: number;
    total: number;
  };
  edges: number;
  robustness: Record<string, number>;
  violated: number;
}

export async function getStatsSummary(db: D1Database): Promise<StatsSummary> {
  const [obsCount, thoughtCount, predictionCount, edgeCount, robustnessStats, violatedCount] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NOT NULL`
    ).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NULL AND derived_from IS NOT NULL AND resolves_by IS NULL`
    ).first<{ count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NULL AND resolves_by IS NOT NULL`
    ).first<{ count: number }>(),
    db.prepare(
      'SELECT COUNT(*) as count FROM edges'
    ).first<{ count: number }>(),
    db.prepare(`
      SELECT
        CASE
          WHEN times_tested < 3 THEN 'untested'
          WHEN times_tested < 10 THEN 'brittle'
          WHEN CAST(confirmations AS REAL) / CASE WHEN times_tested = 0 THEN 1 ELSE times_tested END >= 0.7 THEN 'robust'
          ELSE 'tested'
        END as robustness,
        COUNT(*) as count
      FROM memories
      WHERE retracted = 0
      GROUP BY robustness
    `).all<{ robustness: string; count: number }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE json_array_length(violations) > 0`
    ).first<{ count: number }>(),
  ]);

  const memories = {
    observation: obsCount?.count || 0,
    thought: thoughtCount?.count || 0,
    prediction: predictionCount?.count || 0,
    total: (obsCount?.count || 0) + (thoughtCount?.count || 0) + (predictionCount?.count || 0),
  };

  return {
    memories,
    edges: edgeCount?.count || 0,
    robustness: Object.fromEntries(
      (robustnessStats.results || []).map((r) => [r.robustness, r.count])
    ),
    violated: violatedCount?.count || 0,
  };
}
