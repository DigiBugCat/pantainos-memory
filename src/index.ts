/**
 * Pantainos Memory - Cognitive Loop Architecture
 *
 * Knowledge system with two primitives:
 * - Observations (obs): intake from reality - facts from the world
 * - Thoughts: derived beliefs that can be tested (general or time-bound)
 *
 * Memories are weighted bets, not facts. Confidence = survival rate under test.
 * Queue processes exposure checking (violations + confirmations).
 *
 * MCP access is via external FastMCP proxy on fastmcp.cloud.
 */

import { createWorkerApp, type LoggingEnv } from './lib/shared/hono/index.js';
import { createStandaloneLogger, generateContextId } from './lib/shared/logging/index.js';
import { cors } from 'hono/cors';
import type { Env as BaseEnv } from './types/index.js';
import type { ExposureCheckJob, ExposureCheckStatus } from './lib/shared/types/index.js';
import { getConfig, type Config } from './lib/config.js';
// Route imports
import flowRoutes from './routes/flow/index.js';
import queryRoutes from './routes/query/index.js';
import tagsRoutes from './routes/tags.js';
import graphRoutes from './routes/graph.js';
import experimentsRoutes from './experiments/index.js';
import adminRoutes from './routes/admin.js';

// Services for inline processing (no workflows)
import { checkExposures, checkExposuresForNewThought } from './services/exposure-checker.js';
import {
  queueSignificantEvent,
  findInactiveSessions,
  claimEventsForDispatch,
  releaseClaimedEvents,
  findOverduePredictions,
} from './services/event-queue.js';
import {
  dispatchToResolver,
  type ViolationEvent,
  type ConfirmationEvent,
  type CascadeEvent,
  type OverduePredictionEvent,
} from './services/resolver.js';
import { computeSystemStats } from './jobs/compute-stats.js';
import { runFullGraphPropagation } from './services/propagation.js';
import { computeSurprise } from './services/surprise.js';
import { buildZoneHealth } from './services/zone-builder.js';
import type { ZoneHealthReport } from './services/zone-builder.js';
import { getStatsSummary } from './usecases/stats-summary.js';
import { commitMemory, type ObserveCommitJob } from './usecases/observe-memory.js';

// Extend Env with LoggingEnv for proper typing
type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  agentId: string;
  memoryScope: string[];
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = createWorkerApp<Env, Variables>({ serviceName: 'memory' });

// Global CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// Middleware to inject config into context
app.use('*', async (c, next) => {
  const config = getConfig(c.env as unknown as Record<string, string | undefined>);
  c.set('config', config);
  await next();
});

// Session ID middleware - extract from X-Session-Id header
app.use('*', async (c, next) => {
  const sessionId = c.req.header('X-Session-Id');
  c.set('sessionId', sessionId);
  await next();
});

// Agent scope middleware - extract X-Agent-Id and X-Memory-Scope headers
app.use('*', async (c, next) => {
  const rawAgentId = c.req.header('X-Agent-Id');
  const agentId = rawAgentId?.trim() || '_global';

  const rawScope = c.req.header('X-Memory-Scope');
  let scopeIds: string[];
  if (!rawScope) {
    // Default: agent-only scope
    scopeIds = [agentId];
  } else {
    const parts = rawScope.split(',').map(s => s.trim());
    scopeIds = [];
    if (parts.includes('agent')) scopeIds.push(agentId);
    if (parts.includes('global')) scopeIds.push('_global');
    if (scopeIds.length === 0) scopeIds = [agentId]; // fallback
  }

  c.set('agentId', agentId);
  c.set('memoryScope', scopeIds);
  await next();
});

// Actor context middleware - extract user-agent and IP hash for audit trail
app.use('*', async (c, next) => {
  const userAgent = c.req.header('User-Agent');
  c.set('userAgent', userAgent);

  // Hash client IP for privacy-safe tracking
  // CF-Connecting-IP is set by Cloudflare, X-Forwarded-For as fallback
  const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  if (clientIp) {
    // Simple hash for privacy - not reversible
    const encoder = new TextEncoder();
    const data = encoder.encode(clientIp + '-memory-salt');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const ipHash = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    c.set('ipHash', ipHash);
  } else {
    c.set('ipHash', undefined);
  }

  await next();
});

// ============================================
// NOTE: Authentication is handled by Cloudflare Access at the edge.
// Requests only reach this worker if already authenticated.
// ============================================

// ============================================
// Public System Endpoints
// ============================================

app.get('/', (c) => c.json({ name: 'memory', version: '2.0.0' }));

// Detailed health check with dependency status
app.get('/health', async (c) => {
  const checks: Record<string, { status: string; error?: string }> = {
    d1: { status: 'unknown' },
    vectorize: { status: 'unknown' },
    ai: { status: 'healthy' },
  };

  try {
    await c.env.DB.prepare('SELECT 1').first();
    checks.d1 = { status: 'healthy' };
  } catch (e) {
    checks.d1 = { status: 'unhealthy', error: (e as Error).message };
  }

  try {
    await c.env.MEMORY_VECTORS.describe();
    checks.vectorize = { status: 'healthy' };
  } catch (e) {
    checks.vectorize = { status: 'unhealthy', error: (e as Error).message };
  }

  const allHealthy = Object.values(checks).every(check => check.status === 'healthy');
  return c.json({
    status: allHealthy ? 'healthy' : 'degraded',
    checks,
  });
});

// ============================================
// Protected API Endpoints
// ============================================

// Config endpoint
app.get('/api/config', (c) => {
  const config = c.get('config');
  return c.json(config);
});

// Stats endpoint - v4 architecture
app.get('/api/stats', async (c) => {
  const summary = await getStatsSummary(c.env.DB);

  return c.json({
    memories: summary.memories,
    edges: summary.edges,
    robustness: summary.robustness,
    violated: summary.violated,
  });
});

// Event queue status endpoint (pending events for agentic dispatch)
app.get('/api/events/pending', async (c) => {
  // Get pending events grouped by session
  const pendingBySession = await c.env.DB.prepare(`
    SELECT session_id, event_type, COUNT(*) as count, MAX(created_at) as last_activity
    FROM memory_events
    WHERE dispatched = 0
    GROUP BY session_id, event_type
    ORDER BY last_activity DESC
  `).all<{ session_id: string; event_type: string; count: number; last_activity: number }>();

  // Get total counts
  const totals = await c.env.DB.prepare(`
    SELECT
      SUM(CASE WHEN dispatched = 0 THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN dispatched = 1 THEN 1 ELSE 0 END) as dispatched
    FROM memory_events
  `).first<{ pending: number; dispatched: number }>();

  return c.json({
    pending: totals?.pending || 0,
    dispatched: totals?.dispatched || 0,
    sessions: pendingBySession.results || [],
  });
});

// ============================================
// Mount API routes (v4 architecture)
// ============================================

// Flow routes (write path)
app.route('/api', flowRoutes);

// Query routes (read path)
app.route('/api', queryRoutes);

// Utility routes
app.route('/api/tags', tagsRoutes);
app.route('/api/graph', graphRoutes);

// Experiments (model/prompt evaluation framework)
app.route('/api/experiments', experimentsRoutes);

// Admin routes (CF Access handles authentication at the edge)
app.route('/api/admin', adminRoutes);

// ============================================
// Helper Functions (inlined from workflows)
// ============================================

/** Update exposure check status in D1 */
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

/** Process exposure check for a single job — bidirectional for all memories */
async function processExposureCheck(
  env: Env,
  job: ExposureCheckJob,
  log: ReturnType<typeof createStandaloneLogger>
): Promise<void> {
  const memoryId = job.memory_id;
  const content = job.content;

  log.info('processing_exposure_check', { memory_id: memoryId, bidirectional: true });

  // Mark as processing
  await updateExposureCheckStatus(env.DB, memoryId, 'processing');

  // Run BOTH check directions + surprise concurrently — all independent
  const timeBound = job.time_bound ?? false;
  const [obsResults, thoughtResults, surprise] = await Promise.all([
    // Direction 1: Check if this memory's content violates existing thoughts' conditions
    checkExposures(env, memoryId, content, job.embedding),
    // Direction 2: Check if this memory's own conditions are violated by existing content
    checkExposuresForNewThought(
      env, memoryId, content,
      job.invalidates_if || [],
      job.confirms_if || [],
      timeBound
    ),
    // Predictive coding: compute surprise (prediction error) from neighbor similarity
    computeSurprise(env, memoryId, job.embedding).catch(err => {
      log.warn('surprise_computation_failed', {
        memory_id: memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null as number | null;
    }),
  ]);

  // Store surprise score (independent D1 write, no conflict with exposure writes)
  if (surprise != null) {
    await env.DB.prepare(
      'UPDATE memories SET surprise = ?, updated_at = ? WHERE id = ?'
    ).bind(surprise, Date.now(), memoryId).run();

    log.info('surprise_stored', { memory_id: memoryId, surprise });
  }

  // Merge results, deduplicating by memory_id
  const seenViolations = new Set<string>();
  const allViolations = [...obsResults.violations, ...thoughtResults.violations].filter(v => {
    if (seenViolations.has(v.memory_id)) return false;
    seenViolations.add(v.memory_id);
    return true;
  });

  const seenConfirmations = new Set<string>();
  const allConfirmations = [...obsResults.confirmations, ...thoughtResults.confirmations].filter(c => {
    if (seenConfirmations.has(c.memory_id)) return false;
    seenConfirmations.add(c.memory_id);
    return true;
  });

  // Auto-confirmations only come from checkExposures (obs direction)
  const allAutoConfirmed = obsResults.autoConfirmed;

  // Queue significant events
  const hasSignificantEvents = allViolations.length > 0 || allAutoConfirmed.length > 0;

  if (hasSignificantEvents) {
    // Each violation and confirmation flows through zone health + event queueing concurrently
    const eventTasks: Promise<void>[] = [];

    for (const v of allViolations) {
      eventTasks.push((async () => {
        let zoneHealth: ZoneHealthReport | undefined;
        try {
          zoneHealth = await buildZoneHealth(env.DB, v.memory_id, { maxDepth: 2, maxSize: 20 });
        } catch (err) {
          log.warn('zone_health_check_failed', {
            memory_id: v.memory_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await queueSignificantEvent(env, {
          session_id: job.session_id,
          event_type: 'violation',
          memory_id: v.memory_id,
          violated_by: memoryId,
          damage_level: v.damage_level,
          context: {
            condition: v.condition,
            confidence: v.confidence,
            condition_type: v.condition_type,
            check_direction: 'bidirectional',
            triggering_memory: memoryId,
            zone_health: zoneHealth,
          },
        });
      })());
    }

    for (const c of allAutoConfirmed) {
      eventTasks.push(queueSignificantEvent(env, {
        session_id: job.session_id,
        event_type: 'prediction_confirmed',
        memory_id: c.memory_id,
        context: {
          condition: c.condition,
          confidence: c.confidence,
        },
      }));
    }

    await Promise.all(eventTasks);
  }

  // Mark as completed
  await updateExposureCheckStatus(env.DB, memoryId, 'completed');

  log.info('exposure_check_complete', {
    memory_id: memoryId,
    violations: allViolations.length,
    confirmations: allConfirmations.length,
    auto_confirmed: allAutoConfirmed.length,
    obs_direction_violations: obsResults.violations.length,
    thought_direction_violations: thoughtResults.violations.length,
  });
}

/** Dispatch events for an inactive session */
async function dispatchSessionEvents(
  env: Env,
  sessionId: string,
  log: ReturnType<typeof createStandaloneLogger>
): Promise<void> {
  const claimId = `claim-${crypto.randomUUID().slice(0, 8)}`;

  // Claim events atomically BEFORE dispatching. This marks them as dispatched=1
  // so the next cron tick won't pick them up while we're still processing.
  const events = await claimEventsForDispatch(env, sessionId, claimId);

  if (events.length === 0) {
    return;
  }

  log.info('events_claimed', {
    session_id: sessionId,
    claim_id: claimId,
    event_count: events.length,
  });

  // Safe JSON.parse wrapper — malformed context must not kill the entire batch
  const safeParseContext = (raw: string | null | undefined): Record<string, unknown> => {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      log.warn('bad_event_context', { raw: String(raw).slice(0, 200) });
      return {};
    }
  };

  // Group events by type
  const violations: ViolationEvent[] = events
    .filter((e) => e.event_type === 'violation')
    .map((e) => ({
      id: e.id,
      memory_id: e.memory_id,
      violated_by: e.violated_by,
      damage_level: e.damage_level,
      context: safeParseContext(e.context),
    }));

  const confirmations: ConfirmationEvent[] = events
    .filter((e) => e.event_type === 'prediction_confirmed')
    .map((e) => ({
      id: e.id,
      memory_id: e.memory_id,
      context: safeParseContext(e.context),
    }));

  const cascades: CascadeEvent[] = events
    .filter((e) => e.event_type.includes(':cascade_'))
    .map((e) => {
      const context = safeParseContext(e.context);
      return {
        id: e.id,
        memory_id: e.memory_id,
        cascade_type: 'review' as const,
        memory_type: 'thought' as const,
        context: {
          reason: (context.reason as string) || '',
          source_id: (context.source_id as string) || '',
          source_outcome: (context.source_outcome as 'correct' | 'incorrect' | 'void') || 'void',
          edge_type: (context.edge_type as string) || '',
          suggested_action: (context.suggested_action as string) || 'review',
        },
      };
    });

  const overduePredictions: OverduePredictionEvent[] = events
    .filter((e) => e.event_type === 'thought:pending_resolution')
    .map((e) => {
      const context = safeParseContext(e.context);
      return {
        id: e.id,
        memory_id: e.memory_id,
        context: {
          content: (context.content as string) || '',
          outcome_condition: (context.outcome_condition as string) || null,
          resolves_by: (context.resolves_by as number) || 0,
          invalidates_if: context.invalidates_if as string[] | undefined,
          confirms_if: context.confirms_if as string[] | undefined,
        },
      };
    });

  // Build separate payloads for parallel dispatch:
  // - One batch for violations + cascades + confirmations (related context)
  // - One issue per overdue prediction (independent, can resolve in parallel)
  const dispatches: { payload: Parameters<typeof dispatchToResolver>[1]; eventIds: string[] }[] = [];

  // Batch violations/cascades/confirmations together (if any)
  const coreEvents = [...violations, ...confirmations, ...cascades];
  if (coreEvents.length > 0) {
    const batchId = `batch-${crypto.randomUUID().slice(0, 8)}`;
    dispatches.push({
      payload: {
        batchId,
        sessionId,
        violations,
        confirmations,
        cascades,
        overduePredictions: [],
        summary: {
          violationCount: violations.length,
          confirmationCount: confirmations.length,
          cascadeCount: cascades.length,
          overduePredictionCount: 0,
          affectedMemories: [...new Set(coreEvents.map((e) => e.memory_id))],
        },
      },
      eventIds: coreEvents.map((e) => e.id),
    });
  }

  // Separate issue per overdue prediction (parallel resolution)
  for (const prediction of overduePredictions) {
    const batchId = `batch-${crypto.randomUUID().slice(0, 8)}`;
    dispatches.push({
      payload: {
        batchId,
        sessionId,
        violations: [],
        confirmations: [],
        cascades: [],
        overduePredictions: [prediction],
        summary: {
          violationCount: 0,
          confirmationCount: 0,
          cascadeCount: 0,
          overduePredictionCount: 1,
          affectedMemories: [prediction.memory_id],
        },
      },
      eventIds: [prediction.id],
    });
  }

  // Dispatch all in parallel. Events are already claimed (dispatched=1),
  // so we only need to release on failure.
  const results = await Promise.allSettled(
    dispatches.map(async ({ payload, eventIds }) => {
      try {
        await dispatchToResolver(env, payload);
        // Update workflow_id to the actual batch ID (claim used a placeholder)
        // Events are already marked dispatched=1 from the claim step
        return payload.batchId;
      } catch (error) {
        // Release failed events back to pending so next cron tick can retry
        try {
          await releaseClaimedEvents(env, eventIds);
        } catch (releaseError) {
          log.error('release_claimed_events_failed', {
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
            event_ids: eventIds,
          });
        }
        throw error;
      }
    })
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  const claimedEventCount = events.length;
  const attemptedDispatchEventCount = dispatches.reduce((sum, d) => sum + d.eventIds.length, 0);
  const dispatchedEventCount = dispatches
    .filter((_, idx) => results[idx]?.status === 'fulfilled')
    .reduce((sum, d) => sum + d.eventIds.length, 0);
  const releasedEventCount = dispatches
    .filter((_, idx) => results[idx]?.status === 'rejected')
    .reduce((sum, d) => sum + d.eventIds.length, 0);
  const failed = results.filter((r) => r.status === 'rejected');

  for (const f of failed) {
    if (f.status === 'rejected') {
      log.error('dispatch_failed', {
        session_id: sessionId,
        error: f.reason instanceof Error ? f.reason.message : String(f.reason),
      });
    }
  }

  log.info('session_dispatch_complete', {
    session_id: sessionId,
    dispatches_total: dispatches.length,
    dispatches_succeeded: succeeded,
    dispatches_failed: failed.length,
    event_count: events.length,
    claimed_event_count: claimedEventCount,
    attempted_dispatch_event_count: attemptedDispatchEventCount,
    dispatched_event_count: dispatchedEventCount,
    released_event_count: releasedEventCount,
    claim_dispatch_mismatch: claimedEventCount !== attemptedDispatchEventCount,
    violations: violations.length,
    confirmations: confirmations.length,
    cascades: cascades.length,
    overdue_predictions: overduePredictions.length,
  });
}

// ============================================
// Inactivity timeout for session dispatch
// ============================================
const INACTIVITY_TIMEOUT_MS = 30_000;

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,

  // Scheduled handler for cron triggers
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const log = createStandaloneLogger({
      component: 'ScheduledHandler',
      requestId: generateContextId('cron'),
    });

    log.info('scheduled_event', {
      cron: event.cron,
      scheduled_time: new Date(event.scheduledTime).toISOString(),
    });

    // Every minute: Find inactive sessions and dispatch their events
    if (event.cron === '* * * * *') {
      try {
        const inactiveSessions = await findInactiveSessions(env, INACTIVITY_TIMEOUT_MS);

        if (inactiveSessions.length === 0) {
          log.info('no_inactive_sessions');
          return;
        }

        log.info('found_inactive_sessions', { count: inactiveSessions.length });

        // Dispatch events for all inactive sessions in parallel
        const sessionResults = await Promise.allSettled(
          inactiveSessions.map((session) =>
            dispatchSessionEvents(env, session.session_id, log)
          )
        );

        for (let i = 0; i < sessionResults.length; i++) {
          const result = sessionResults[i];
          if (result.status === 'rejected') {
            log.error('session_dispatch_failed', {
              session_id: inactiveSessions[i].session_id,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        }
      } catch (error) {
        log.error('inactivity_check_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Daily at 3:00 AM UTC: Compute system stats for confidence model
    if (event.cron === '0 3 * * *') {
      log.info('daily_stats_computation_triggered', {
        scheduled_time: new Date(event.scheduledTime).toISOString(),
      });

      try {
        const result = await computeSystemStats(env, `cron-${event.scheduledTime}`);
        log.info('daily_stats_computation_complete', {
          max_times_tested: result.maxTimesTested,
          median_times_tested: result.medianTimesTested,
          source_count: Object.keys(result.sourceTrackRecords).length,
          total_memories: result.totalMemories,
        });
      } catch (error) {
        log.error('daily_stats_computation_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Full-graph confidence propagation (Phase B-beta)
      try {
        const propagation = await runFullGraphPropagation(env, `cron-${event.scheduledTime}`);
        log.info('daily_propagation_complete', {
          components: propagation.components_processed,
          updated: propagation.total_updated,
          max_delta: Math.round(propagation.max_delta * 1000) / 1000,
          duration_ms: propagation.duration_ms,
        });
      } catch (error) {
        log.error('daily_propagation_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Find overdue predictions and dispatch for resolution
      try {
        const overdue = await findOverduePredictions(env);
        if (overdue.length > 0) {
          log.info('overdue_predictions_found', { count: overdue.length });

          for (const prediction of overdue) {
            await queueSignificantEvent(env, {
              event_type: 'thought:pending_resolution',
              memory_id: prediction.id,
              context: {
                content: prediction.content,
                outcome_condition: prediction.outcome_condition,
                resolves_by: prediction.resolves_by,
                invalidates_if: prediction.invalidates_if ? JSON.parse(prediction.invalidates_if) : undefined,
                confirms_if: prediction.confirms_if ? JSON.parse(prediction.confirms_if) : undefined,
              },
            });
          }

          log.info('overdue_predictions_queued', { count: overdue.length });
        }
      } catch (error) {
        log.error('overdue_prediction_dispatch_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },

  // Queue consumer for async exposure checks + commit retries
  async queue(
    batch: MessageBatch<ExposureCheckJob | ObserveCommitJob>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const log = createStandaloneLogger({
      component: 'QueueHandler',
      requestId: generateContextId('queue'),
    });

    log.info('queue_batch_received', {
      queue: batch.queue,
      message_count: batch.messages.length,
    });

    for (const message of batch.messages) {
      const job = message.body;

      try {
        // Dispatch by message type
        if ('type' in job && job.type === 'observe:commit') {
          // Retry a failed observe commit (idempotent)
          log.info('commit_retry_processing', { memory_id: job.id });
          await commitMemory(env, job);
          log.info('commit_retry_succeeded', { memory_id: job.id });
          message.ack();
        } else {
          // Existing exposure check path
          await processExposureCheck(env, job as ExposureCheckJob, log);
          message.ack();
        }
      } catch (error) {
        const memoryId = 'type' in job && job.type === 'observe:commit' ? job.id : (job as ExposureCheckJob).memory_id;
        log.error('queue_message_failed', {
          memory_id: memoryId,
          message_type: 'type' in job ? job.type : 'exposure_check',
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Retry the message (up to max retries configured on queue → then DLQ)
        message.retry();
      }
    }
  },
};
