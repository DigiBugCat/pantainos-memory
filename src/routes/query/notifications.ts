/**
 * Notifications Route - GET /api/notifications/pending
 *
 * Returns unread notifications and marks them as read atomically.
 * Used by the FastMCP proxy to prepend notifications to tool responses.
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

type NotificationRow = {
  id: string;
  type: string;
  memory_id: string;
  content: string;
  context: string | null;
  created_at: number;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '5', 10);

  const unread = await c.env.DB.prepare(
    `SELECT id, type, memory_id, content, context, created_at
     FROM notifications
     WHERE read = 0
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(limit).all<NotificationRow>();

  const notifications = unread.results ?? [];

  if (notifications.length === 0) {
    return c.json({ success: true, count: 0, notifications: [] });
  }

  // Mark as read
  const ids = notifications.map(n => n.id);
  const placeholders = ids.map(() => '?').join(',');
  await c.env.DB.prepare(
    `UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`
  ).bind(...ids).run();

  return c.json({
    success: true,
    count: notifications.length,
    notifications: notifications.map(n => ({
      id: n.id,
      type: n.type,
      memory_id: n.memory_id,
      content: n.content,
      context: n.context ? JSON.parse(n.context) : null,
      created_at: n.created_at,
    })),
  });
});

export default app;
