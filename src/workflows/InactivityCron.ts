/**
 * InactivityCron Workflow
 *
 * Cloudflare Workflow that finds sessions with pending events that have been
 * inactive for 30+ seconds and triggers SessionDispatchWorkflow for each.
 *
 * Triggered by the worker's scheduled handler (cron: "* * * * *" = every minute).
 *
 * This workflow provides observability into the batch discovery process:
 * - How many sessions were found
 * - Which sessions were dispatched
 * - Any errors in triggering dispatch workflows
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { createStandaloneLogger, generateContextId } from '../lib/shared/logging/index.js';
import { findInactiveSessions } from '../services/event-queue.js';
import type { Env } from '../types/index.js';

/** Inactivity threshold before triggering dispatch (30 seconds) */
const INACTIVITY_TIMEOUT_MS = 30_000;

interface CronParams {
  triggeredAt: number;
}

export class InactivityCron extends WorkflowEntrypoint<Env, CronParams> {
  async run(event: WorkflowEvent<CronParams>, step: WorkflowStep) {
    const { triggeredAt } = event.payload;
    const log = createStandaloneLogger({
      component: 'InactivityCron',
      requestId: generateContextId('cron'),
    });

    log.info('starting', { triggered_at: new Date(triggeredAt).toISOString() });

    // Step 1: Find sessions that have been inactive for 30+ seconds
    const inactiveSessions = await step.do('find-inactive-sessions', async () => {
      return await findInactiveSessions(this.env, INACTIVITY_TIMEOUT_MS);
    });

    if (inactiveSessions.length === 0) {
      log.info('no_inactive_sessions');
      return {
        status: 'no_sessions',
        triggeredAt,
        sessionsFound: 0,
      };
    }

    log.info('found_inactive_sessions', { count: inactiveSessions.length });

    // Step 2: Trigger SessionDispatchWorkflow for each inactive session
    const dispatched: string[] = [];
    const failed: { sessionId: string; error: string }[] = [];

    for (const session of inactiveSessions) {
      try {
        await step.do(`trigger-dispatch-${session.session_id}`, async () => {
          await this.env.SESSION_DISPATCH.create({
            id: `session-${session.session_id}-${Date.now()}`,
            params: { sessionId: session.session_id },
          });
        });
        dispatched.push(session.session_id);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        log.error('dispatch_trigger_failed', {
          session_id: session.session_id,
          error: errorMessage,
        });
        failed.push({ sessionId: session.session_id, error: errorMessage });
      }
    }

    const summary = {
      status: 'complete' as const,
      triggeredAt,
      sessionsFound: inactiveSessions.length,
      dispatched: dispatched.length,
      failed: failed.length,
      sessions: inactiveSessions.map((s) => ({
        sessionId: s.session_id,
        eventCount: s.event_count,
        lastActivity: s.last_activity,
      })),
    };

    log.info('complete', summary);

    return summary;
  }
}
