/**
 * Refresh Stats Route - POST /api/refresh-stats
 *
 * Manually trigger system statistics recomputation.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { LoggingEnv } from '../../lib/shared/hono/index.js';
import { computeSystemStats, getSystemStatsSummary } from '../../jobs/compute-stats.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const requestId = c.get('requestId');

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body is fine
  }

  const summaryOnly = body.summary_only === true;

  if (summaryOnly) {
    const summary = await getSystemStatsSummary(c.env.DB);
    return c.json({
      success: true,
      summary_only: true,
      last_updated: summary.last_updated ? new Date(summary.last_updated).toISOString() : null,
      max_times_tested: summary.max_times_tested ?? null,
      median_times_tested: summary.median_times_tested ?? null,
      source_track_records: summary.source_track_records,
    });
  }

  const result = await computeSystemStats(c.env, requestId);

  return c.json({
    success: true,
    max_times_tested: result.maxTimesTested,
    median_times_tested: result.medianTimesTested,
    total_memories: result.totalMemories,
    source_track_records: result.sourceTrackRecords,
  });
});

export default app;
