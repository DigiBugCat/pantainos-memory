/**
 * History Route - GET /api/history/:entityId
 *
 * Get version history for an entity.
 * Shows content changes over time.
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { getHistory, getVersion } from '../../services/history-service.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/history/:entityId
 * Get version history for an entity
 */
app.get('/:entityId', async (c) => {
  const entityId = c.req.param('entityId');
  const limit = parseInt(c.req.query('limit') || '20', 10);

  if (!entityId) {
    return c.json({ success: false, error: 'entityId is required' }, 400);
  }

  const history = await getHistory(c.env.DB, entityId, limit);

  if (!history) {
    return c.json({ success: false, error: 'No history found for entity' }, 404);
  }

  return c.json({
    success: true,
    ...history,
  });
});

/**
 * GET /api/history/:entityId/version/:versionNumber
 * Get a specific version of an entity
 */
app.get('/:entityId/version/:versionNumber', async (c) => {
  const entityId = c.req.param('entityId');
  const versionNumber = parseInt(c.req.param('versionNumber') || '0', 10);

  if (!entityId) {
    return c.json({ success: false, error: 'entityId is required' }, 400);
  }

  if (versionNumber <= 0) {
    return c.json({ success: false, error: 'versionNumber must be a positive integer' }, 400);
  }

  const version = await getVersion(c.env.DB, entityId, versionNumber);

  if (!version) {
    return c.json({ success: false, error: 'Version not found' }, 404);
  }

  return c.json({
    success: true,
    version,
  });
});

export default app;
