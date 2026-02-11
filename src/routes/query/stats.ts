/**
 * Stats Route - GET /api/stats
 *
 * System-wide statistics including:
 *   - Memory counts by type
 *   - Exposure check status distribution
 *   - Cascade event counts
 *   - Robustness tier distribution
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { ExposureCheckStatus, Robustness } from '../../lib/shared/types/index.js';
import { getRobustnessThresholds } from '../../services/confidence.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export interface StatsResponse {
  // Memory counts by type
  memory_counts: {
    total: number;
    obs: number;
    thought: number;
    /** Time-bound thoughts (have resolves_by) */
    time_bound: number;
    /** General thoughts (no resolves_by) */
    general: number;
    retracted: number;
  };
  // Exposure check status distribution
  exposure_status: Record<ExposureCheckStatus, number>;
  // Robustness tier distribution (for thoughts only)
  robustness_tiers: Record<Robustness, number>;
  // State distribution (for thoughts)
  state_distribution: {
    active: number;
    confirmed: number;
    violated: number;
    expired: number;
    retracted: number;
  };
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const config = c.get('config');
  const thresholds = getRobustnessThresholds(config);

  // Memory counts by type (using field presence)
  const memoryCounts = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN source IS NOT NULL AND retracted = 0 THEN 1 ELSE 0 END) as obs,
      SUM(CASE WHEN source IS NULL AND derived_from IS NOT NULL AND retracted = 0 THEN 1 ELSE 0 END) as thought,
      SUM(CASE WHEN source IS NULL AND resolves_by IS NOT NULL AND retracted = 0 THEN 1 ELSE 0 END) as time_bound,
      SUM(CASE WHEN source IS NULL AND derived_from IS NOT NULL AND resolves_by IS NULL AND retracted = 0 THEN 1 ELSE 0 END) as general,
      SUM(CASE WHEN retracted = 1 THEN 1 ELSE 0 END) as retracted
    FROM memories
  `).first<{
    total: number;
    obs: number;
    thought: number;
    time_bound: number;
    general: number;
    retracted: number;
  }>();

  // Exposure check status distribution
  const exposureStatus = await c.env.DB.prepare(`
    SELECT
      exposure_check_status,
      COUNT(*) as count
    FROM memories
    WHERE retracted = 0
    GROUP BY exposure_check_status
  `).all<{ exposure_check_status: string | null; count: number }>();

  const exposureStatusMap: Record<ExposureCheckStatus, number> = {
    pending: 0,
    processing: 0,
    completed: 0,
    skipped: 0,
  };
  for (const row of exposureStatus.results || []) {
    const status = (row.exposure_check_status || 'pending') as ExposureCheckStatus;
    exposureStatusMap[status] = row.count;
  }

  // Robustness tier distribution (for thoughts only)
  // Uses configurable thresholds
  const robustnessTiers = await c.env.DB.prepare(`
    SELECT
      CASE
        WHEN times_tested < ? THEN 'untested'
        WHEN times_tested < ? THEN 'brittle'
        WHEN (CAST(confirmations AS REAL) / CASE WHEN times_tested = 0 THEN 1 ELSE times_tested END) >= ? THEN 'robust'
        ELSE 'tested'
      END as tier,
      COUNT(*) as count
    FROM memories
    WHERE retracted = 0
      AND source IS NULL
      AND derived_from IS NOT NULL
    GROUP BY tier
  `).bind(
    thresholds.UNTESTED_MAX_TIMES_TESTED,
    thresholds.BRITTLE_MAX_TIMES_TESTED,
    thresholds.ROBUST_MIN_CONFIDENCE
  ).all<{ tier: string; count: number }>();

  const robustnessMap: Record<Robustness, number> = {
    untested: 0,
    brittle: 0,
    tested: 0,
    robust: 0,
  };
  for (const row of robustnessTiers.results || []) {
    robustnessMap[row.tier as Robustness] = row.count;
  }

  // State distribution (for thoughts)
  const stateDistribution = await c.env.DB.prepare(`
    SELECT
      state,
      COUNT(*) as count
    FROM memories
    WHERE source IS NULL
      AND derived_from IS NOT NULL
    GROUP BY state
  `).all<{ state: string; count: number }>();

  const stateMap: StatsResponse['state_distribution'] = {
    active: 0,
    confirmed: 0,
    violated: 0,
    expired: 0,
    retracted: 0,
  };
  for (const row of stateDistribution.results || []) {
    if (row.state in stateMap) {
      stateMap[row.state as keyof typeof stateMap] = row.count;
    }
  }

  const response: StatsResponse = {
    memory_counts: {
      total: memoryCounts?.total || 0,
      obs: memoryCounts?.obs || 0,
      thought: memoryCounts?.thought || 0,
      time_bound: memoryCounts?.time_bound || 0,
      general: memoryCounts?.general || 0,
      retracted: memoryCounts?.retracted || 0,
    },
    exposure_status: exposureStatusMap,
    robustness_tiers: robustnessMap,
    state_distribution: stateMap,
  };

  return c.json(response);
});

export default app;
