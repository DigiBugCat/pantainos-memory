/**
 * Event Queue Service
 *
 * Queues significant memory events for batched agentic dispatch.
 * Only violations and prediction resolutions are queued - simple confirmations
 * are recorded in D1 but don't trigger agentic processing.
 *
 * Events accumulate by session_id. When a session goes quiet (30s inactivity),
 * the InactivityCron workflow triggers SessionDispatchWorkflow to batch dispatch
 * all pending events for that session to the resolver.
 */

import type { Env } from '../types/index.js';
import { createLazyLogger } from '../lib/lazy-logger.js';

const getLog = createLazyLogger('EventQueue');

export type SignificantEventType =
  | 'violation'
  | 'thought_confirmed'
  | 'thought_resolved'
  // Overdue prediction resolution (the only event type the resolver still processes)
  | 'thought:pending_resolution'
  // Legacy event types (kept for DB backward compat — no longer queued)
  | 'thought:cascade_review'
  | 'thought:evidence_validated'
  | 'thought:evidence_invalidated'
  | 'prediction_confirmed'
  | 'prediction_resolved'
  | 'assumption_confirmed'
  | 'assumption_resolved'
  | 'prediction:cascade_review'
  | 'assumption:cascade_review'
  | 'prediction:evidence_validated'
  | 'prediction:evidence_invalidated'
  | 'assumption:evidence_validated'
  | 'assumption:evidence_invalidated';

export interface SignificantEvent {
  session_id?: string;
  event_type: SignificantEventType;
  memory_id: string;
  violated_by?: string;
  damage_level?: 'core' | 'peripheral';
  context?: Record<string, unknown>;
}

/**
 * Queue a significant event for batched agentic dispatch.
 *
 * Events are stored in D1 and dispatched when the session becomes inactive
 * (30s no activity). The InactivityCron workflow handles dispatch triggering.
 *
 * @param env - Worker environment with D1 binding
 * @param event - The significant event to queue
 */
export async function queueSignificantEvent(env: Env, event: SignificantEvent): Promise<void> {
  const sessionId = event.session_id || 'default';
  const eventId = `evt-${crypto.randomUUID().slice(0, 12)}`;

  await env.DB.prepare(`
    INSERT INTO memory_events (
      id, session_id, event_type, memory_id,
      violated_by, damage_level, context, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    eventId,
    sessionId,
    event.event_type,
    event.memory_id,
    event.violated_by || null,
    event.damage_level || null,
    JSON.stringify(event.context || {}),
    Date.now()
  ).run();

  getLog().debug('event_queued', {
    event_type: event.event_type,
    memory_id: event.memory_id,
    session_id: sessionId,
  });
}

/**
 * Get pending events for a session.
 * Used by SessionDispatchWorkflow to fetch events before dispatch.
 */
export async function getPendingEvents(env: Env, sessionId: string): Promise<{
  id: string;
  session_id: string;
  event_type: string;
  memory_id: string;
  violated_by: string | null;
  damage_level: string | null;
  context: string;
  created_at: number;
}[]> {
  const result = await env.DB.prepare(`
    SELECT id, session_id, event_type, memory_id, violated_by, damage_level, context, created_at
    FROM memory_events
    WHERE session_id = ? AND dispatched = 0
    ORDER BY created_at
  `).bind(sessionId).all();

  return result.results as {
    id: string;
    session_id: string;
    event_type: string;
    memory_id: string;
    violated_by: string | null;
    damage_level: string | null;
    context: string;
    created_at: number;
  }[];
}

/**
 * Mark events as dispatched.
 * Called by SessionDispatchWorkflow after successful dispatch.
 */
export async function markEventsDispatched(
  env: Env,
  eventIds: string[],
  workflowId: string
): Promise<void> {
  if (eventIds.length === 0) return;

  const placeholders = eventIds.map(() => '?').join(',');
  await env.DB.prepare(`
    UPDATE memory_events
    SET dispatched = 1, dispatched_at = ?, workflow_id = ?
    WHERE id IN (${placeholders})
  `).bind(Date.now(), workflowId, ...eventIds).run();

  getLog().info('events_dispatched', { event_count: eventIds.length });
}

/**
 * Atomically claim events for dispatch by marking them dispatched=1 before
 * the actual dispatch call. This prevents the next cron tick from picking up
 * the same events while dispatch is in-flight.
 *
 * Returns the full event rows that were claimed (only those still undispatched).
 * On dispatch failure, call releaseClaimedEvents to roll back.
 */
export async function claimEventsForDispatch(
  env: Env,
  sessionId: string,
  workflowId: string
): Promise<{
  id: string;
  session_id: string;
  event_type: string;
  memory_id: string;
  violated_by: string | null;
  damage_level: string | null;
  context: string;
  created_at: number;
}[]> {
  const now = Date.now();

  // Claim first, then read only what this claim actually owns.
  // This avoids select-then-update races between concurrent schedulers.
  const claimResult = await env.DB.prepare(`
    UPDATE memory_events
    SET dispatched = 1, dispatched_at = ?, workflow_id = ?
    WHERE session_id = ? AND dispatched = 0
  `).bind(now, workflowId, sessionId).run();

  const changed = claimResult.meta.changes ?? 0;
  if (changed === 0) {
    return [];
  }

  const claimed = await env.DB.prepare(`
    SELECT id, session_id, event_type, memory_id, violated_by, damage_level, context, created_at
    FROM memory_events
    WHERE session_id = ? AND workflow_id = ? AND dispatched = 1
    ORDER BY created_at
  `).bind(sessionId, workflowId).all<{
    id: string;
    session_id: string;
    event_type: string;
    memory_id: string;
    violated_by: string | null;
    damage_level: string | null;
    context: string;
    created_at: number;
  }>();

  const events = claimed.results || [];
  getLog().info('events_claimed', {
    session_id: sessionId,
    event_count: events.length,
    claimed_changes: changed,
  });

  return events;
}

/**
 * Release previously claimed events back to pending state on dispatch failure.
 * This allows the next cron tick to retry them.
 */
export async function releaseClaimedEvents(
  env: Env,
  eventIds: string[]
): Promise<void> {
  if (eventIds.length === 0) return;

  const placeholders = eventIds.map(() => '?').join(',');
  await env.DB.prepare(`
    UPDATE memory_events
    SET dispatched = 0, dispatched_at = NULL, workflow_id = NULL
    WHERE id IN (${placeholders})
  `).bind(...eventIds).run();

  getLog().warn('events_released', { event_count: eventIds.length });
}

/**
 * Find overdue predictions that haven't been dispatched yet.
 * Used by the daily cron to queue pending_resolution events.
 */
export async function findOverduePredictions(env: Env): Promise<{
  id: string;
  content: string;
  outcome_condition: string | null;
  resolves_by: number;
  invalidates_if: string | null;
  confirms_if: string | null;
}[]> {
  const now = Math.floor(Date.now() / 1000);

  const result = await env.DB.prepare(`
    SELECT m.id, m.content, m.outcome_condition, m.resolves_by, m.invalidates_if, m.confirms_if
    FROM memories m
    WHERE m.resolves_by IS NOT NULL
      AND m.resolves_by < ?
      AND m.state = 'active'
      AND m.retracted = 0
      AND m.id NOT IN (
        SELECT me.memory_id FROM memory_events me
        WHERE me.event_type = 'thought:pending_resolution'
      )
  `).bind(now).all<{
    id: string;
    content: string;
    outcome_condition: string | null;
    resolves_by: number;
    invalidates_if: string | null;
    confirms_if: string | null;
  }>();

  return result.results || [];
}

/**
 * Find sessions with pending events that have been inactive.
 * Used by InactivityCron to trigger dispatch workflows.
 */
export async function findInactiveSessions(
  env: Env,
  inactivityThresholdMs: number = 30_000
): Promise<{ session_id: string; event_count: number; last_activity: number }[]> {
  const cutoff = Date.now() - inactivityThresholdMs;

  const result = await env.DB.prepare(`
    SELECT session_id, COUNT(*) as event_count, MAX(created_at) as last_activity
    FROM memory_events
    WHERE dispatched = 0
    GROUP BY session_id
    HAVING MAX(created_at) < ?
  `).bind(cutoff).all();

  const sessions = result.results as { session_id: string; event_count: number; last_activity: number }[];

  getLog().debug('inactive_sessions_found', { session_count: sessions.length });

  return sessions;
}
