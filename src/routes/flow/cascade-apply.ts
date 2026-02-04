/**
 * Cascade Apply Route - POST /api/cascade/apply
 *
 * Apply cascade effects to memories. This is how agents act on cascade events.
 *
 * Actions:
 *   - review: Acknowledge review of cascade effect (no confidence modification)
 *   - dismiss: Mark event processed without modifying memory
 *
 * Request body:
 *   - memory_id: Target memory ID (required)
 *   - action: 'review' | 'dismiss' (required)
 *   - event_id: The cascade event being processed (optional, marks as dispatched)
 *   - source_id: The source memory that triggered the cascade (optional)
 *   - reason: Why this action was taken (optional)
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { logField } from '../../lib/shared/logging/index.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export interface ApplyCascadeRequest {
  memory_id: string;
  action: 'review' | 'dismiss';
  event_id?: string;
  source_id?: string;
  reason?: string;
}

export interface ApplyCascadeResponse {
  success: true;
  memory_id: string;
  action: string;
  event_dismissed?: boolean;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /api/cascade/apply
 * Apply a cascade effect to a memory.
 */
app.post('/apply', async (c) => {
  let body: ApplyCascadeRequest;
  try {
    body = await c.req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      logField(c, 'json_parse_warning', error instanceof Error ? error.message : 'unknown');
    }
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.memory_id || typeof body.memory_id !== 'string') {
    return c.json({ success: false, error: 'memory_id is required' }, 400);
  }

  if (!body.action || !['review', 'dismiss'].includes(body.action)) {
    return c.json({ success: false, error: 'action must be one of: review, dismiss' }, 400);
  }

  const now = Date.now();

  // Verify memory exists
  const row = await c.env.DB.prepare(`
    SELECT id FROM memories WHERE id = ? AND retracted = 0
  `).bind(body.memory_id).first<{ id: string }>();

  if (!row) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  // Both review and dismiss just mark the event as processed
  // Confidence is fully derived from exposure checker — no manual modification
  if (body.event_id) {
    await c.env.DB.prepare(`
      UPDATE memory_events
      SET dispatched = 1, dispatched_at = ?
      WHERE id = ?
    `).bind(now, body.event_id).run();
  }

  // For review: update last_cascade_at to track that this was reviewed
  if (body.action === 'review') {
    await c.env.DB.prepare(`
      UPDATE memories SET last_cascade_at = ?, updated_at = ? WHERE id = ?
    `).bind(now, now, body.memory_id).run();
  }

  return c.json({
    success: true,
    memory_id: body.memory_id,
    action: body.action,
    event_dismissed: !!body.event_id,
  } as ApplyCascadeResponse);
});

export default app;
