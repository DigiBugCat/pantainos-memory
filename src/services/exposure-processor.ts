/**
 * Exposure Processor - Cognitive Loop Architecture (v3)
 *
 * @deprecated This module is deprecated. Use ExposureCheckWorkflow instead.
 *
 * The queue consumer now triggers ExposureCheckWorkflow which:
 * 1. Runs checkExposures() for violation/confirmation detection
 * 2. Queues significant events (violations, auto-confirmations) to memory_events table
 * 3. Provides full observability via Cloudflare Workflows dashboard
 *
 * This file is kept for reference during migration but should not be used.
 */

import type { Env } from '../types/index.js';
import type { ExposureCheckJob } from '../lib/shared/types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import { checkExposures } from './exposure-checker.js';
import { queueSignificantEvent } from './event-queue.js';

// Lazy logger - avoids crypto in global scope (deprecated module)
let _log: ReturnType<typeof createStandaloneLogger> | null = null;
function getLog() {
  if (!_log) {
    _log = createStandaloneLogger({
      component: 'ExposureProcessor',
      requestId: 'exposure-proc-init',
    });
  }
  return _log;
}

/**
 * Process an exposure check job from the queue.
 *
 * @deprecated Use ExposureCheckWorkflow instead. This function is kept for
 * reference but is no longer called by the queue consumer.
 */
export async function processExposureJob(
  job: ExposureCheckJob,
  env: Env
): Promise<void> {
  getLog().warn('deprecated_call', {
    memory_id: job.memory_id,
    memory_type: job.memory_type,
    request_id: job.request_id,
    message: 'processExposureJob is deprecated. The queue consumer now triggers ExposureCheckWorkflow.',
  });

  // Run exposure checking (violations + confirmations + auto-confirms)
  const result = await checkExposures(
    env,
    job.memory_id,
    job.content,
    job.embedding
  );

  // Queue significant events to memory_events table (new workflow approach)
  // Only violations and auto-confirmations - not simple confirmations

  for (const violation of result.violations) {
    await queueSignificantEvent(env, {
      session_id: job.session_id,
      event_type: 'violation',
      memory_id: violation.memory_id,
      violated_by: job.memory_id,
      damage_level: violation.damage_level,
      context: {
        condition: violation.condition,
        condition_type: violation.condition_type,
        confidence: violation.confidence,
      },
    });
  }

  for (const autoConfirmed of result.autoConfirmed) {
    await queueSignificantEvent(env, {
      session_id: job.session_id,
      event_type: 'prediction_confirmed',
      memory_id: autoConfirmed.memory_id,
      context: {
        condition: autoConfirmed.condition,
        confidence: autoConfirmed.confidence,
      },
    });
  }

  getLog().info('check_complete', {
    memory_id: job.memory_id,
    violations: result.violations.length,
    confirmations: result.confirmations.length,
    auto_confirmed: result.autoConfirmed.length,
  });
}
