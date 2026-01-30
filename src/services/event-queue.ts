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

export type SignificantEventType =
  | 'violation'
  | 'assumption_confirmed'
  | 'assumption_resolved'
  | 'assumption:cascade_review'
  | 'assumption:cascade_boost'
  | 'assumption:cascade_damage'
  // Upward propagation events (evidence validated/invalidated in upstream memories)
  | 'assumption:evidence_validated'
  | 'assumption:evidence_invalidated'
  // Legacy event types (for migration compatibility)
  | 'prediction_confirmed'
  | 'prediction_resolved'
  | 'inference:cascade_review'
  | 'inference:cascade_boost'
  | 'inference:cascade_damage'
  | 'prediction:cascade_review'
  | 'prediction:cascade_boost'
  | 'prediction:cascade_damage'
  | 'inference:evidence_validated'
  | 'inference:evidence_invalidated'
  | 'prediction:evidence_validated'
  | 'prediction:evidence_invalidated';

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

  return result.results as { session_id: string; event_count: number; last_activity: number }[];
}
