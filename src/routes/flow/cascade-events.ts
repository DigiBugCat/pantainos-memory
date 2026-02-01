/**
 * Cascade Events Route - GET /api/cascade/events
 *
 * Returns pending cascade events with context for agent processing.
 * Cascade events are queued when a memory is resolved (correct/incorrect)
 * and need to be applied to related memories.
 *
 * Event types:
 *   - thought:cascade_boost - Derived thought should be boosted
 *   - thought:cascade_damage - Derived thought should be damaged
 *   - thought:cascade_review - Derived thought needs manual review
 *   - prediction:cascade_boost - Derived prediction should be boosted
 *   - prediction:cascade_damage - Derived prediction should be damaged
 *   - prediction:cascade_review - Derived prediction needs manual review
 *
 * Query params:
 *   - session_id: Filter by session (optional)
 *   - limit: Max events to return (default: 50)
 *   - include_context: Include source memory details (default: true)
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export interface CascadeEventRow {
  id: string;
  session_id: string;
  event_type: string;
  memory_id: string;
  violated_by: string | null;
  damage_level: string | null;
  context: string;
  created_at: number;
}

export interface CascadeEventWithContext {
  id: string;
  session_id: string;
  event_type: string;
  target_memory: {
    id: string;
    type: 'observation' | 'thought' | 'prediction';
    content: string;
    state: string;
    confidence: number;
    times_tested: number;
  };
  source_memory?: {
    id: string;
    type: 'observation' | 'thought' | 'prediction';
    content: string;
    outcome: string | null;
  };
  reason: string;
  suggested_action: 'boost' | 'damage' | 'review';
  created_at: number;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/cascade/events
 * List pending cascade events that need agent action.
 */
app.get('/events', async (c) => {
  const sessionId = c.req.query('session_id');
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const includeContext = c.req.query('include_context') !== 'false';

  // Cascade event types (downstream cascade + upstream evidence propagation)
  const cascadeTypes = [
    'thought:cascade_boost',
    'thought:cascade_damage',
    'thought:cascade_review',
    'prediction:cascade_boost',
    'prediction:cascade_damage',
    'prediction:cascade_review',
    // Upward propagation events
    'thought:evidence_validated',
    'thought:evidence_invalidated',
    'prediction:evidence_validated',
    'prediction:evidence_invalidated',
  ];

  // Build query
  let query = `
    SELECT id, session_id, event_type, memory_id, violated_by, damage_level, context, created_at
    FROM memory_events
    WHERE dispatched = 0
      AND event_type IN (${cascadeTypes.map(() => '?').join(',')})
  `;
  const params: (string | number)[] = [...cascadeTypes];

  if (sessionId) {
    query += ' AND session_id = ?';
    params.push(sessionId);
  }

  query += ' ORDER BY created_at ASC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(query).bind(...params).all<CascadeEventRow>();
  const events = result.results || [];

  if (!includeContext || events.length === 0) {
    return c.json({
      events: events.map((e) => ({
        id: e.id,
        session_id: e.session_id,
        event_type: e.event_type,
        memory_id: e.memory_id,
        context: JSON.parse(e.context || '{}'),
        created_at: e.created_at,
      })),
      total: events.length,
    });
  }

  // Enrich with memory context
  const enrichedEvents: CascadeEventWithContext[] = [];

  for (const event of events) {
    const context = JSON.parse(event.context || '{}');

    // Get target memory
    const targetMemory = await c.env.DB.prepare(`
      SELECT id, source, derived_from, resolves_by, content, state, confirmations, times_tested
      FROM memories
      WHERE id = ? AND retracted = 0
    `).bind(event.memory_id).first<{
      id: string;
      source: string | null;
      derived_from: string | null;
      resolves_by: number | null;
      content: string;
      state: string;
      confirmations: number;
      times_tested: number;
    }>();

    if (!targetMemory) continue;

    const confidence = targetMemory.confirmations / Math.max(targetMemory.times_tested, 1);

    // Derive type from field presence
    const getDisplayType = (m: { source: string | null; derived_from: string | null; resolves_by: number | null }): 'observation' | 'thought' | 'prediction' => {
      if (m.source != null) return 'observation';
      if (m.resolves_by != null) return 'prediction';
      return 'thought';
    };

    // Get source memory if available
    let sourceMemory: CascadeEventWithContext['source_memory'];
    if (context.source_id) {
      const source = await c.env.DB.prepare(`
        SELECT id, source, derived_from, resolves_by, content, outcome
        FROM memories
        WHERE id = ? AND retracted = 0
      `).bind(context.source_id).first<{
        id: string;
        source: string | null;
        derived_from: string | null;
        resolves_by: number | null;
        content: string;
        outcome: string | null;
      }>();

      if (source) {
        sourceMemory = {
          id: source.id,
          type: getDisplayType(source),
          content: source.content,
          outcome: source.outcome,
        };
      }
    }

    // Determine suggested action from event type
    let suggested_action: 'boost' | 'damage' | 'review' = 'review';
    if (event.event_type.includes('boost')) {
      suggested_action = 'boost';
    } else if (event.event_type.includes('damage')) {
      suggested_action = 'damage';
    }

    enrichedEvents.push({
      id: event.id,
      session_id: event.session_id,
      event_type: event.event_type,
      target_memory: {
        id: targetMemory.id,
        type: getDisplayType(targetMemory),
        content: targetMemory.content,
        state: targetMemory.state,
        confidence,
        times_tested: targetMemory.times_tested,
      },
      source_memory: sourceMemory,
      reason: context.reason || 'cascade_propagation',
      suggested_action,
      created_at: event.created_at,
    });
  }

  return c.json({
    events: enrichedEvents,
    total: enrichedEvents.length,
  });
});

export default app;
