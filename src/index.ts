/**
 * Pantainos Memory v4 - Cognitive Loop Architecture
 *
 * Knowledge system with two primitives:
 * - Observations (obs): intake from reality - facts from the world
 * - Thoughts: derived beliefs that can be tested (general or time-bound)
 *
 * Memories are weighted bets, not facts. Confidence = survival rate under test.
 * Queue processes exposure checking (violations + confirmations).
 */

import { createWorkerApp, type LoggingEnv } from './lib/shared/hono/index.js';
import { createStandaloneLogger, generateContextId, logField } from './lib/shared/logging/index.js';
import { cors } from 'hono/cors';
import type { Env as BaseEnv } from './types/index.js';
import type { ExposureCheckJob, ExposureCheckStatus } from './lib/shared/types/index.js';
import { getConfig, type Config } from './lib/config.js';
import { authorizeHandler, tokenHandler, registerHandler, validateAccessToken } from '@pantainos/mcp-core';

// Route imports
import flowRoutes from './routes/flow/index.js';
import queryRoutes from './routes/query/index.js';
import tagsRoutes from './routes/tags.js';
import graphRoutes from './routes/graph.js';
import experimentsRoutes from './experiments/index.js';
import mcpRoutes from './routes/mcp.js';
import internalRoutes from './routes/internal.js';

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
import { buildZoneHealth } from './services/zone-builder.js';
import type { ZoneHealthReport } from './services/zone-builder.js';

// Extend Env with LoggingEnv for proper typing
type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = createWorkerApp<Env, Variables>({ serviceName: 'memory' });

// Global CORS for MCP/OAuth clients - must be applied to ALL routes
// This matches the reference implementation pattern
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
  exposeHeaders: ['Mcp-Session-Id'],
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

// Helper to get issuer URL (from env or derive from request)
const getIssuerUrl = (c: { env: Env; req: { url: string } }) =>
  c.env.ISSUER_URL || new URL(c.req.url).origin;

// Basic info / discovery endpoint (matches MCP OAuth reference)
app.get('/', (c) => {
  const issuer = getIssuerUrl(c);
  return c.json({
    name: 'memory',
    version: '2.0.0',
    description: 'Pantainos Memory API with OAuth authentication',
    endpoints: {
      mcp_http: `${issuer}/mcp`,
      oauth_metadata: `${issuer}/.well-known/oauth-authorization-server`,
      resource_metadata: `${issuer}/.well-known/oauth-protected-resource`,
      register: `${issuer}/register`,
      authorize: `${issuer}/authorize`,
      token: `${issuer}/token`,
      health: `${issuer}/health`,
    },
  });
});

// MCP Streamable HTTP transport at root (POST /)
// This is the newer MCP transport format used by Claude
app.options('/', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
  exposeHeaders: ['Mcp-Session-Id'],
}));

app.post('/', async (c) => {
  logField(c, 'transport', 'streamable_http');
  const tokenData = await validateAccessToken(c.req.raw, c.env);

  if (!tokenData) {
    logField(c, 'auth_result', 'no_token');
    const issuer = getIssuerUrl(c);
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  logField(c, 'auth_email', tokenData.email);

  // Forward to MCP handler
  const body = await c.req.text();

  let message;
  try {
    message = JSON.parse(body);
    logField(c, 'mcp_method', message.method);
    logField(c, 'mcp_id', message.id);
  } catch {
    logField(c, 'parse_error', true);
    return c.json({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
    }, 400);
  }

  // Import MCP handler dynamically to handle the message
  const { handleMCPMessage } = await import('./routes/mcp.js');
  const response = await handleMCPMessage(message, tokenData.email, c.env);

  if (!response) {
    logField(c, 'mcp_notification', true);
    return new Response(null, { status: 202 });
  }

  return c.json(response);
});

// ============================================
// OAuth 2.0 Endpoints (for MCP authentication)
// ============================================
// These endpoints enable mcp-remote OAuth flow with Cloudflare Access.
// The OAuth flow is backed by CF Access for identity verification.

// Permissive CORS for OAuth endpoints - MCP clients need this
const oauthCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
  exposeHeaders: ['Mcp-Session-Id'],
});

// Apply permissive CORS to OAuth and well-known endpoints
app.use('/.well-known/*', oauthCors);
app.use('/register', oauthCors);
app.use('/authorize', oauthCors);
app.use('/token', oauthCors);

// OAuth Authorization Server Metadata (RFC 8414)
app.get('/.well-known/oauth-authorization-server', (c) => {
  const issuer = getIssuerUrl(c);
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256', 'plain'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['mcp', 'openid', 'profile', 'email'],
  });
});

// OAuth Protected Resource Metadata (RFC 9728)
app.get('/.well-known/oauth-protected-resource', (c) => {
  const issuer = getIssuerUrl(c);
  logField(c, 'oauth_issuer', issuer);
  return c.json({
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
});

// Dynamic Client Registration (RFC 7591)
app.post('/register', async (c) => {
  logField(c, 'oauth_flow', 'client_registration');
  const body = await c.req.text();
  const newReq = new Request(c.req.url, {
    method: 'POST',
    headers: c.req.raw.headers,
    body: body,
  });
  return registerHandler(newReq, c.env);
});

// OAuth Authorization endpoint
app.get('/authorize', async (c) => {
  logField(c, 'oauth_flow', 'authorization');
  return authorizeHandler(c.req.raw, c.env);
});

// OAuth Token endpoint
app.post('/token', async (c) => {
  logField(c, 'oauth_flow', 'token_exchange');
  const body = await c.req.text();
  const newReq = new Request(c.req.url, {
    method: 'POST',
    headers: c.req.raw.headers,
    body: body,
  });
  return tokenHandler(newReq, c.env);
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
// Protected API Endpoints
// ============================================

// Config endpoint
app.get('/api/config', (c) => {
  const config = c.get('config');
  return c.json(config);
});

// Stats endpoint - v4 architecture
app.get('/api/stats', async (c) => {
  // Count memories by type using field presence
  const obsCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NOT NULL`
  ).first<{ count: number }>();

  const thoughtCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NULL AND derived_from IS NOT NULL AND resolves_by IS NULL`
  ).first<{ count: number }>();

  const predictionCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NULL AND resolves_by IS NOT NULL`
  ).first<{ count: number }>();

  const counts = {
    observation: obsCount?.count || 0,
    thought: thoughtCount?.count || 0,
    prediction: predictionCount?.count || 0,
  };

  // Count edges
  const edgeCount = await c.env.DB.prepare(
    'SELECT COUNT(*) as count FROM edges'
  ).first<{ count: number }>();

  // Get robustness stats (times_tested distribution)
  const robustnessStats = await c.env.DB.prepare(`
    SELECT
      CASE
        WHEN times_tested < 3 THEN 'untested'
        WHEN times_tested < 10 THEN 'brittle'
        WHEN CAST(confirmations AS REAL) / CASE WHEN times_tested = 0 THEN 1 ELSE times_tested END >= 0.7 THEN 'robust'
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
      observation: counts.observation,
      thought: counts.thought,
      prediction: counts.prediction,
      total: counts.observation + counts.thought + counts.prediction,
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

// Internal routes (called by MCP workers via service binding)
// No authentication required - service bindings are trusted internal connections
app.use('/internal/*', async (c, next) => {
  // Inject config and requestId for internal routes
  const config = c.get('config');
  c.set('config', config);
  c.set('requestId', c.req.header('X-Request-Id') || `internal-${Date.now()}`);
  await next();
});
app.route('/internal', internalRoutes);

// MCP routes (Model Context Protocol for Claude Code integration)
// Protected by OAuth token validation or CF Access service token

// MCP-specific CORS - must be permissive for OAuth clients
const mcpCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
  exposeHeaders: ['Mcp-Session-Id'],
});
app.use('/mcp/*', mcpCors);

// MCP auth middleware
app.use('/mcp/*', async (c, next) => {
  // Check for OAuth token first
  const tokenData = await validateAccessToken(c.req.raw, c.env);

  if (tokenData) {
    // Valid OAuth token - proceed
    logField(c, 'auth_method', 'oauth');
    logField(c, 'auth_email', tokenData.email);
    await next();
    return;
  }

  // Fallback to CF Access service token (CF-Access-Client-Id header)
  // CF Access validates the token at the edge before reaching the worker
  const serviceTokenId = c.req.header('CF-Access-Client-Id');
  if (serviceTokenId) {
    logField(c, 'auth_method', 'cf_access_service_token');
    await next();
    return;
  }

  // No valid authentication - return 401 with OAuth discovery hint
  const issuer = getIssuerUrl(c);
  logField(c, 'auth_result', 'unauthorized');
  return new Response('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`,
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    },
  });
});
app.route('/mcp', mcpRoutes);

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

  // Run BOTH check directions for ALL memories (no is_observation branching)
  // Direction 1: Check if this memory's content violates existing thoughts' conditions
  const obsResults = await checkExposures(env, memoryId, content, job.embedding);

  // Direction 2: Check if this memory's own conditions are violated by existing content
  const timeBound = job.time_bound ?? false;
  const thoughtResults = await checkExposuresForNewThought(
    env,
    memoryId,
    content,
    job.invalidates_if || [],
    job.confirms_if || [],
    timeBound
  );

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
    for (const v of allViolations) {
      // Post-shock zone health check (non-blocking best-effort)
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
    }

    for (const c of allAutoConfirmed) {
      await queueSignificantEvent(env, {
        session_id: job.session_id,
        event_type: 'prediction_confirmed',
        memory_id: c.memory_id,
        context: {
          condition: c.condition,
          confidence: c.confidence,
        },
      });
    }
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

  // Queue consumer for async exposure check jobs (inline processing)
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
        // Process exposure check inline (no workflow)
        await processExposureCheck(env, job, log);
        message.ack();
      } catch (error) {
        log.error('exposure_check_failed', {
          memory_id: job.memory_id,
          is_observation: job.is_observation,
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
