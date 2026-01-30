/**
 * Access Log Route - GET /api/access-log/:entityId
 *
 * Get access audit trail for an entity.
 * Shows who accessed what and when.
 */

import { Hono } from 'hono';
import type { Env, AccessType } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { getAccessLog, queryAccessEvents } from '../../services/access-service.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/access-log/:entityId
 * Get access log for an entity
 */
app.get('/:entityId', async (c) => {
  const entityId = c.req.param('entityId');
  const limit = parseInt(c.req.query('limit') || '20', 10);

  if (!entityId) {
    return c.json({ success: false, error: 'entityId is required' }, 400);
  }

  const accessLog = await getAccessLog(c.env.DB, entityId, limit);

  if (!accessLog) {
    return c.json({ success: false, error: 'No access log found for entity' }, 404);
  }

  return c.json({
    success: true,
    ...accessLog,
  });
});

/**
 * GET /api/access-log
 * Query access events with filters
 */
app.get('/', async (c) => {
  const entityId = c.req.query('entityId');
  const sessionId = c.req.query('sessionId');
  const accessType = c.req.query('accessType') as AccessType | undefined;
  const limit = parseInt(c.req.query('limit') || '50', 10);

  const events = await queryAccessEvents(c.env.DB, {
    entityId,
    sessionId,
    accessType,
    limit,
  });

  return c.json({
    success: true,
    events,
    total: events.length,
  });
});

export default app;
