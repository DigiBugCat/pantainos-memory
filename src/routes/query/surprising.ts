/**
 * Surprising Route - GET /api/surprising
 *
 * Find memories with the highest surprise scores.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { LoggingEnv } from '../../lib/shared/hono/index.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { findMostSurprising } from '../../services/surprise.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10', 10);
  const minSurprise = parseFloat(c.req.query('min_surprise') || '0.3');

  const results = await findMostSurprising(c.env, limit, minSurprise);

  return c.json({
    success: true,
    count: results.length,
    results: results.map(r => ({
      id: r.memory.id,
      content: r.memory.content,
      type: getDisplayType(r.memory),
      surprise: r.surprise,
      structural_depth: r.structural_depth,
      stale: r.stale,
    })),
  });
});

export default app;
