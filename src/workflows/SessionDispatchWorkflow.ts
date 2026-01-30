/**
 * SessionDispatchWorkflow
 *
 * Cloudflare Workflow that batches and dispatches significant events for a session
 * to the configured resolver (GitHub Actions, webhook, etc).
 *
 * Triggered by InactivityCron when a session has been quiet for 30+ seconds.
 * This ensures all related events are batched together, giving the agentic
 * resolver complete context about what happened in the session.
 *
 * Steps:
 * 1. Fetch all pending events for the session from D1
 * 2. Group events by type (violations, confirmations)
 * 3. Dispatch to resolver with full context
 * 4. Mark events as dispatched
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import {
  getPendingEvents,
  markEventsDispatched,
} from '../services/event-queue.js';
import {
  dispatchToResolver,
  type ViolationEvent,
  type ConfirmationEvent,
  type CascadeEvent,
} from '../services/resolver.js';
import type { Env } from '../types/index.js';

interface DispatchParams {
  sessionId: string;
}

export class SessionDispatchWorkflow extends WorkflowEntrypoint<Env, DispatchParams> {
  async run(event: WorkflowEvent<DispatchParams>, step: WorkflowStep) {
    const { sessionId } = event.payload;
    const log = createStandaloneLogger({
      component: 'SessionDispatchWorkflow',
      baseContext: { session_id: sessionId },
    });

    log.info('starting_dispatch');

    // Step 1: Fetch all pending events for this session
    const events = await step.do('fetch-events', async () => {
      return await getPendingEvents(this.env, sessionId);
    });

    if (events.length === 0) {
      log.info('no_pending_events');
      return { status: 'empty', sessionId };
    }

    // Step 2: Group events by type
    const violations: ViolationEvent[] = events
      .filter((e) => e.event_type === 'violation')
      .map((e) => ({
        id: e.id,
        memory_id: e.memory_id,
        violated_by: e.violated_by,
        damage_level: e.damage_level,
        context: JSON.parse(e.context || '{}'),
      }));

    const confirmations: ConfirmationEvent[] = events
      .filter((e) => e.event_type === 'prediction_confirmed')
      .map((e) => ({
        id: e.id,
        memory_id: e.memory_id,
        context: JSON.parse(e.context || '{}'),
      }));

    // Cascade events (assumption:cascade_*, legacy: inference:cascade_*, prediction:cascade_*)
    // v4: All cascade events use 'assumption' type
    const cascades: CascadeEvent[] = events
      .filter((e) => e.event_type.includes(':cascade_'))
      .map((e) => {
        const context = JSON.parse(e.context || '{}');
        const [memType, cascadeAction] = e.event_type.split(':cascade_');
        return {
          id: e.id,
          memory_id: e.memory_id,
          cascade_type: cascadeAction as 'review' | 'boost' | 'damage',
          // v4: Unified assumption type (handle legacy events too)
          memory_type: 'assumption' as const,
          context: {
            reason: context.reason || '',
            source_id: context.source_id || '',
            source_outcome: context.source_outcome || 'void',
            edge_type: context.edge_type || '',
            suggested_action: context.suggested_action || 'review',
          },
        };
      });

    const batchId = `batch-${crypto.randomUUID().slice(0, 8)}`;

    // Step 3: Dispatch to resolver (with retries)
    await step.do(
      'dispatch-resolver',
      {
        retries: {
          limit: 3,
          delay: '5 seconds',
          backoff: 'exponential',
        },
      },
      async () => {
        await dispatchToResolver(this.env, {
          batchId,
          sessionId,
          violations,
          confirmations,
          cascades,
          summary: {
            violationCount: violations.length,
            confirmationCount: confirmations.length,
            cascadeCount: cascades.length,
            affectedMemories: [...new Set(events.map((e) => e.memory_id))],
          },
        });
      }
    );

    // Step 4: Mark events as dispatched
    // Use batchId as the workflow identifier for tracking
    await step.do('mark-dispatched', async () => {
      const eventIds = events.map((e) => e.id);
      await markEventsDispatched(this.env, eventIds, batchId);
    });

    const summary = {
      status: 'dispatched' as const,
      sessionId,
      batchId,
      eventCount: events.length,
      violations: violations.length,
      confirmations: confirmations.length,
      cascades: cascades.length,
    };

    log.info('dispatch_complete', summary);

    return summary;
  }
}
