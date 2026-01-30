/**
 * ExposureCheckWorkflow - Three-Table Bi-directional Architecture
 *
 * Cloudflare Workflow that processes exposure check jobs for new memories.
 * Supports bi-directional checking based on memory_type:
 *
 * For observations (memory_type = 'obs'):
 *   - Search INVALIDATES_VECTORS: Find predictions this obs might break
 *   - Search CONFIRMS_VECTORS: Find predictions this obs might confirm
 *   - LLM-judge each match
 *
 * For inferences/predictions (memory_type = 'infer' or 'pred'):
 *   - Search MEMORY_VECTORS (obs only): Find existing observations that might
 *     already violate this new memory's invalidates_if conditions
 *   - LLM-judge each match
 *
 * This ensures predictions are checked against existing observations immediately
 * upon creation, not just when new observations come in later.
 *
 * Steps:
 * 1. Run checkExposures (bi-directional, three-table search + LLM-judge)
 * 2. Queue significant events (violations, auto-confirmations) to memory_events
 */

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import type { ExposureCheckJob, ExposureCheckResult, ExposureCheckStatus } from '../lib/shared/types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import { checkExposures, checkExposuresForNewAssumption } from '../services/exposure-checker.js';
import { queueSignificantEvent } from '../services/event-queue.js';
import type { Env } from '../types/index.js';

/**
 * Update exposure check status in D1.
 */
async function updateExposureCheckStatus(
  db: D1Database,
  memoryId: string,
  status: ExposureCheckStatus
): Promise<void> {
  const updates: string[] = ['exposure_check_status = ?', 'updated_at = ?'];
  const values: (string | number)[] = [status, Date.now()];

  if (status === 'completed') {
    updates.push('exposure_check_completed_at = ?');
    values.push(Date.now());
  }

  values.push(memoryId);

  await db.prepare(`
    UPDATE memories
    SET ${updates.join(', ')}
    WHERE id = ?
  `).bind(...values).run();
}

export class ExposureCheckWorkflow extends WorkflowEntrypoint<Env, ExposureCheckJob> {
  async run(event: WorkflowEvent<ExposureCheckJob>, step: WorkflowStep) {
    const job = event.payload;
    const log = createStandaloneLogger({
      component: 'ExposureCheckWorkflow',
      requestId: job.request_id,
      baseContext: { session_id: job.session_id },
    });

    // Handle legacy job format (observation_id instead of memory_id)
    const legacyJob = job as any;
    const memoryId = job.memory_id || legacyJob.observation_id;
    const memoryType = job.memory_type || 'obs';
    const content = job.content || legacyJob.observation_content;

    log.info('starting_check', { memory_id: memoryId, memory_type: memoryType });

    // Step 0: Mark status as 'processing'
    await step.do('mark-processing', async () => {
      await updateExposureCheckStatus(this.env.DB, memoryId, 'processing');
    });

    let results: ExposureCheckResult;

    if (memoryType === 'obs') {
      // For observations: search INVALIDATES_VECTORS and CONFIRMS_VECTORS
      // to find assumptions this observation might break or confirm
      results = await step.do('check-exposures-for-obs', async () => {
        return await checkExposures(
          this.env,
          memoryId,
          content,
          job.embedding
        );
      });
    } else {
      // For assumptions: search MEMORY_VECTORS (obs only)
      // to find existing observations that might violate this
      // v4: Uses unified assumption type with time_bound flag
      const timeBound = job.time_bound ?? false;
      results = await step.do('check-exposures-for-assumption', async () => {
        return await checkExposuresForNewAssumption(
          this.env,
          memoryId,
          content,
          job.invalidates_if || [],
          job.confirms_if || [],
          timeBound
        );
      });
    }

    // Step 2: Queue significant events for agentic dispatch
    // Only violations and auto-confirmations - not simple confirmations
    const hasSignificantEvents =
      results.violations.length > 0 || results.autoConfirmed.length > 0;

    if (hasSignificantEvents) {
      await step.do('queue-events', async () => {
        // Queue violations
        for (const v of results.violations) {
          await queueSignificantEvent(this.env, {
            session_id: job.session_id,
            event_type: 'violation',
            memory_id: v.memory_id,
            violated_by: memoryType === 'obs' ? memoryId : v.memory_id,
            damage_level: v.damage_level,
            context: {
              condition: v.condition,
              confidence: v.confidence,
              condition_type: v.condition_type,
              // For bi-directional: note which direction the check was
              check_direction: memoryType === 'obs' ? 'obs_to_assumption' : 'assumption_to_obs',
              triggering_memory: memoryId,
            },
          });
        }

        // Queue auto-confirmations (predictions that were confirmed)
        for (const c of results.autoConfirmed) {
          await queueSignificantEvent(this.env, {
            session_id: job.session_id,
            event_type: 'prediction_confirmed',
            memory_id: c.memory_id,
            context: {
              condition: c.condition,
              confidence: c.confidence,
            },
          });
        }
      });
    }

    // Step 3: Mark status as 'completed'
    await step.do('mark-completed', async () => {
      await updateExposureCheckStatus(this.env.DB, memoryId, 'completed');
    });

    const summary = {
      status: 'complete' as const,
      memory_id: memoryId,
      memory_type: memoryType,
      violations: results.violations.length,
      confirmations: results.confirmations.length,
      autoConfirmed: results.autoConfirmed.length,
      eventsQueued: hasSignificantEvents,
    };

    log.info('check_complete', summary);

    return summary;
  }
}
