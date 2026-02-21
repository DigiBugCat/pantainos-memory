/**
 * Resolve Route - POST /api/resolve
 *
 * Resolve any memory as correct, incorrect, superseded, or voided.
 * Triggers cascade propagation and cleans up condition vectors.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { LoggingEnv } from '../../lib/shared/hono/index.js';
import { generateId } from '../../lib/id.js';
import { recordVersion } from '../../services/history-service.js';
import { deleteConditionVectors } from '../../services/embedding-tables.js';
import { propagateResolution } from '../../services/cascade.js';

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
  const sessionId = c.get('sessionId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const memory_id = body.memory_id as string | undefined;
  const outcome = body.outcome as 'correct' | 'incorrect' | 'voided' | 'superseded' | undefined;
  const reason = body.reason as string | undefined;
  const replaced_by = body.replaced_by as string | undefined;
  const force = body.force as boolean | undefined ?? false;

  if (!memory_id) return c.json({ success: false, error: 'memory_id is required' }, 400);
  if (!outcome) return c.json({ success: false, error: 'outcome is required' }, 400);
  if (!['correct', 'incorrect', 'voided', 'superseded'].includes(outcome)) {
    return c.json({ success: false, error: 'outcome must be one of: correct, incorrect, voided, superseded' }, 400);
  }
  if (!reason) return c.json({ success: false, error: 'reason is required' }, 400);

  // Validate replaced_by
  if (replaced_by) {
    if (replaced_by === memory_id) {
      return c.json({ success: false, error: 'replaced_by cannot be the same as memory_id' }, 400);
    }
    const replacementRow = await c.env.DB.prepare(
      'SELECT id, retracted FROM memories WHERE id = ?'
    ).bind(replaced_by).first<{ id: string; retracted: number }>();
    if (!replacementRow) return c.json({ success: false, error: `Replacement memory not found: ${replaced_by}` }, 404);
    if (replacementRow.retracted) return c.json({ success: false, error: `Replacement memory is retracted: ${replaced_by}` }, 422);
  }

  // Fetch memory
  const row = await c.env.DB.prepare(
    'SELECT id, content, state, outcome, source, retracted, resolves_by, derived_from FROM memories WHERE id = ?'
  ).bind(memory_id).first<{ id: string; content: string; state: string; outcome: string | null; source: string | null; retracted: number; resolves_by: number | null; derived_from: string | null }>();

  if (!row) return c.json({ success: false, error: `Memory not found: ${memory_id}` }, 404);
  if (row.retracted) return c.json({ success: false, error: `Memory is retracted: ${memory_id}` }, 422);
  if (row.state === 'resolved' && !force) {
    return c.json({ success: false, error: `Memory is already resolved (outcome: ${row.outcome}). Pass force=true to re-resolve.` }, 409);
  }

  const oldState = row.state;
  const oldOutcome = row.outcome;
  const now = Date.now();

  // Update state
  await c.env.DB.prepare(
    `UPDATE memories SET state = 'resolved', outcome = ?, resolved_at = ?, updated_at = ? WHERE id = ?`
  ).bind(outcome, now, now, memory_id).run();

  // Create supersedes edge if replaced_by provided
  if (replaced_by) {
    const edgeId = generateId();
    await c.env.DB.prepare(
      `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
       VALUES (?, ?, ?, 'supersedes', 1.0, ?)`
    ).bind(edgeId, memory_id, replaced_by, now).run();
  }

  // Clean up condition vectors
  await deleteConditionVectors(c.env, memory_id).catch(() => {});

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: memory_id,
    entityType: 'memory',
    changeType: 'resolved',
    contentSnapshot: {
      old_state: oldState,
      old_outcome: oldOutcome,
      new_state: 'resolved',
      outcome,
      reason,
      replaced_by: replaced_by || undefined,
      force,
    },
    changeReason: reason,
    sessionId,
    requestId,
  });

  // Trigger cascade propagation
  let cascade_count = 0;
  let cascade_error: string | undefined;
  try {
    const cascadeOutcome = outcome === 'correct' ? 'correct'
      : (outcome === 'incorrect' || outcome === 'superseded') ? 'incorrect'
      : 'void';
    const cascadeResult = await propagateResolution(c.env, memory_id, cascadeOutcome, sessionId);
    cascade_count = cascadeResult.effects.length;
  } catch (err) {
    cascade_error = err instanceof Error ? err.message : String(err);
  }

  return c.json({
    success: true,
    memory_id,
    outcome,
    old_state: oldState,
    old_outcome: oldOutcome,
    replaced_by: replaced_by || undefined,
    cascade_count,
    cascade_error,
  });
});

export default app;
