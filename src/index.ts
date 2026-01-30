/**
 * Pantainos Memory v4 - Cognitive Loop Architecture
 *
 * Knowledge system with two primitives:
 * - Observations (obs): intake from reality - facts from the world
 * - Assumptions: derived beliefs that can be tested (general or time-bound)
 *
 * Memories are weighted bets, not facts. Confidence = survival rate under test.
 * Queue processes exposure checking (violations + confirmations).
 */

import { createWorkerApp, type LoggingEnv } from './lib/shared/hono/index.js';
import { createStandaloneLogger, generateContextId } from './lib/shared/logging/index.js';
import { cors } from 'hono/cors';
import type { Env as BaseEnv } from './types/index.js';
import type { ExposureCheckJob } from './lib/shared/types/index.js';
import { getConfig, type Config } from './lib/config.js';

// Route imports
import flowRoutes from './routes/flow/index.js';
import queryRoutes from './routes/query/index.js';
import tagsRoutes from './routes/tags.js';
import graphRoutes from './routes/graph.js';
import experimentsRoutes from './experiments/index.js';
import internalRoutes from './routes/internal.js';

// Workflow exports (observable event processing)
export { ExposureCheckWorkflow } from './workflows/ExposureCheckWorkflow.js';
export { SessionDispatchWorkflow } from './workflows/SessionDispatchWorkflow.js';
export { InactivityCron } from './workflows/InactivityCron.js';

// Extend Env with LoggingEnv for proper typing
type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = createWorkerApp<Env, Variables>({ serviceName: 'pantainos-memory' });

// CORS for API clients
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'X-Request-Id'],
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
    const data = encoder.encode(clientIp + '-pantainos-memory-salt');
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
// SECURITY: This worker has no built-in authentication.
// For production, protect with Cloudflare Access:
//   1. Create Access Application for this worker's domain
//   2. Create Service Token for machine-to-machine access (e.g., n8n)
//   3. Clients must send CF-Access-Client-Id and CF-Access-Client-Secret headers
// See: https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
// ============================================

// ============================================
// Public System Endpoints
// ============================================

// Basic info / discovery endpoint
app.get('/', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    name: 'pantainos-memory',
    version: '2.0.0',
    description: 'Pantainos Memory - Zettelkasten Knowledge Graph',
    endpoints: {
      health: `${baseUrl}/health`,
      api: `${baseUrl}/api`,
      internal: `${baseUrl}/internal`,
    },
  });
});

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
// API Endpoints
// ============================================

// Config endpoint
app.get('/api/config', (c) => {
  const config = c.get('config');
  return c.json(config);
});

// Stats endpoint - v4 architecture
app.get('/api/stats', async (c) => {
  // Count memories by type
  const memoryCounts = await c.env.DB.prepare(
    `SELECT memory_type, COUNT(*) as count FROM memories WHERE retracted = 0 GROUP BY memory_type`
  ).all<{ memory_type: string; count: number }>();

  const counts = Object.fromEntries(
    (memoryCounts.results || []).map(r => [r.memory_type, r.count])
  );

  // Count edges
  const edgeCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM edges'
  ).first<{ count: number }>();

  // Get robustness stats (exposures distribution)
  const robustnessStats = await c.env.DB.prepare(`
    SELECT
      CASE
        WHEN exposures < 3 THEN 'untested'
        WHEN exposures < 10 THEN 'brittle'
        WHEN CAST(confirmations AS REAL) / CASE WHEN exposures = 0 THEN 1 ELSE exposures END >= 0.7 THEN 'robust'
        ELSE 'tested'
      END as robustness,
      COUNT(*) as count
    FROM memories
    WHERE retracted = 0
    GROUP BY robustness
  `).all<{ robustness: string; count: number }>();

  // Get violation count
  const violatedCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE json_array_length(violations) > 0`
  ).first<{ count: number }>();

  return c.json({
    memories: {
      obs: counts.obs || 0,
      assumption: counts.assumption || 0,
      total: (counts.obs || 0) + (counts.assumption || 0),
    },
    edges: edgeCount?.count || 0,
    robustness: Object.fromEntries(
      (robustnessStats.results || []).map(r => [r.robustness, r.count])
    ),
    violated: violatedCount?.count || 0,
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

// Internal routes (called via service binding from n8n)
// No authentication required - service bindings are trusted internal connections
app.use('/internal/*', async (c, next) => {
  // Inject config and requestId for internal routes
  const config = c.get('config');
  c.set('config', config);
  c.set('requestId', c.req.header('X-Request-Id') || `internal-${Date.now()}`);
  await next();
});
app.route('/internal', internalRoutes);

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

    // Every minute: Trigger InactivityCron to find sessions with 30s+ inactivity
    if (event.cron === '* * * * *') {
      try {
        await env.INACTIVITY_CRON.create({
          id: `inactivity-${event.scheduledTime}`,
          params: { triggeredAt: event.scheduledTime },
        });
        log.info('inactivity_cron_triggered', {
          scheduled_time: new Date(event.scheduledTime).toISOString(),
        });
      } catch (error) {
        log.error('inactivity_cron_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Daily at 3:00 AM UTC: Maintenance tasks
    if (event.cron === '0 3 * * *') {
      log.info('daily_maintenance_triggered', {
        scheduled_time: new Date(event.scheduledTime).toISOString(),
      });
    }
  },

  // Queue consumer for async exposure check jobs
  // Triggers ExposureCheckWorkflow for each job (observable via CF dashboard)
  async queue(
    batch: MessageBatch<ExposureCheckJob>,
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
        // Trigger workflow instead of processing inline
        // This gives us full observability in CF dashboard
        await env.EXPOSURE_CHECK.create({
          id: `exposure-${job.memory_id}-${Date.now()}`,
          params: job,
        });

        message.ack();

        log.info('exposure_workflow_triggered', {
          memory_id: job.memory_id,
          memory_type: job.memory_type,
          request_id: job.request_id,
          session_id: job.session_id,
        });
      } catch (error) {
        log.error('exposure_workflow_trigger_failed', {
          memory_id: job.memory_id,
          memory_type: job.memory_type,
          request_id: job.request_id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Retry the message (up to max retries configured on queue)
        message.retry();
      }
    }
  },
};
