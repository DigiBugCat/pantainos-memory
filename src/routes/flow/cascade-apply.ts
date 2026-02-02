/**
 * Cascade Apply Route - POST /api/cascade/apply
 *
 * Apply cascade effects to memories. This is how agents act on cascade events.
 *
 * Actions:
 *   - boost: Increment confirmations + times_tested + cascade_boosts
 *   - damage: Increment times_tested + cascade_damages (lowers confidence)
 *   - dismiss: Mark event processed without modifying memory
 *
 * Request body:
 *   - memory_id: Target memory ID (required)
 *   - action: 'boost' | 'damage' | 'dismiss' (required)
 *   - event_id: The cascade event being processed (optional, marks as dispatched)
 *   - source_id: The source memory that triggered the cascade (optional)
 *   - reason: Why this action was taken (optional)
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { MemoryRow, Violation } from '../../lib/shared/types/index.js';
import { logField } from '../../lib/shared/logging/index.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export interface ApplyCascadeRequest {
  memory_id: string;
  action: 'boost' | 'damage' | 'dismiss';
  event_id?: string;
  source_id?: string;
  reason?: string;
}

export interface ApplyCascadeResponse {
  success: true;
  memory_id: string;
  action: string;
  previous: {
    confirmations: number;
    times_tested: number;
    cascade_boosts: number;
    cascade_damages: number;
    confidence: number;
  };
  current: {
    confirmations: number;
    times_tested: number;
    cascade_boosts: number;
    cascade_damages: number;
    confidence: number;
  };
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

  if (!body.action || !['boost', 'damage', 'dismiss'].includes(body.action)) {
    return c.json({ success: false, error: 'action must be one of: boost, damage, dismiss' }, 400);
  }

  const now = Date.now();

  // Get current memory state
  const row = await c.env.DB.prepare(`
    SELECT id, content, confirmations, times_tested, centrality, state, violations,
           cascade_boosts, cascade_damages, last_cascade_at,
           source, derived_from, assumes, invalidates_if, confirms_if, outcome_condition, resolves_by,
           starting_confidence, contradictions,
           retracted, retracted_at, retraction_reason,
           exposure_check_status, exposure_check_completed_at,
           tags, session_id, created_at, updated_at
    FROM memories
    WHERE id = ? AND retracted = 0
  `).bind(body.memory_id).first<MemoryRow>();

  if (!row) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  const previous = {
    confirmations: row.confirmations,
    times_tested: row.times_tested,
    cascade_boosts: row.cascade_boosts || 0,
    cascade_damages: row.cascade_damages || 0,
    confidence: row.confirmations / Math.max(row.times_tested, 1),
  };

  // Handle dismiss action - just mark event as processed
  if (body.action === 'dismiss') {
    if (body.event_id) {
      await c.env.DB.prepare(`
        UPDATE memory_events
        SET dispatched = 1, dispatched_at = ?
        WHERE id = ?
      `).bind(now, body.event_id).run();
    }

    return c.json({
      success: true,
      memory_id: body.memory_id,
      action: 'dismiss',
      previous,
      current: previous,
      event_dismissed: !!body.event_id,
    } as ApplyCascadeResponse);
  }

  // Apply boost or damage
  let updateQuery: string;
  if (body.action === 'boost') {
    // Boost: increment confirmations, times_tested, cascade_boosts
    updateQuery = `
      UPDATE memories
      SET confirmations = confirmations + 1,
          times_tested = times_tested + 1,
          cascade_boosts = cascade_boosts + 1,
          last_cascade_at = ?,
          updated_at = ?
      WHERE id = ?
    `;
  } else {
    // Damage: increment times_tested, cascade_damages (no confirmation increment)
    updateQuery = `
      UPDATE memories
      SET times_tested = times_tested + 1,
          cascade_damages = cascade_damages + 1,
          last_cascade_at = ?,
          updated_at = ?
      WHERE id = ?
    `;
  }

  await c.env.DB.prepare(updateQuery).bind(now, now, body.memory_id).run();

  // If damage with source_id, also record a violation
  if (body.action === 'damage' && body.source_id) {
    const violations: Violation[] = JSON.parse(row.violations || '[]');
    violations.push({
      condition: body.reason || 'cascade_damage',
      timestamp: now,
      obs_id: body.source_id,
      damage_level: 'peripheral', // Cascade damages are always peripheral
      source_type: 'cascade',
      cascade_source_id: body.source_id,
    });

    await c.env.DB.prepare(`
      UPDATE memories
      SET violations = ?
      WHERE id = ?
    `).bind(JSON.stringify(violations), body.memory_id).run();
  }

  // Mark event as dispatched if provided
  if (body.event_id) {
    await c.env.DB.prepare(`
      UPDATE memory_events
      SET dispatched = 1, dispatched_at = ?
      WHERE id = ?
    `).bind(now, body.event_id).run();
  }

  // Get updated state
  const updatedRow = await c.env.DB.prepare(`
    SELECT confirmations, times_tested, cascade_boosts, cascade_damages
    FROM memories
    WHERE id = ?
  `).bind(body.memory_id).first<{
    confirmations: number;
    times_tested: number;
    cascade_boosts: number;
    cascade_damages: number;
  }>();

  const current = {
    confirmations: updatedRow?.confirmations || previous.confirmations,
    times_tested: updatedRow?.times_tested || previous.times_tested,
    cascade_boosts: updatedRow?.cascade_boosts || previous.cascade_boosts,
    cascade_damages: updatedRow?.cascade_damages || previous.cascade_damages,
    confidence: (updatedRow?.confirmations || 0) / Math.max(updatedRow?.times_tested || 1, 1),
  };

  return c.json({
    success: true,
    memory_id: body.memory_id,
    action: body.action,
    previous,
    current,
    event_dismissed: !!body.event_id,
  } as ApplyCascadeResponse);
});

export default app;
