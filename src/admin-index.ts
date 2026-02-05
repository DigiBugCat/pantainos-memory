/**
 * Pantainos Memory Admin Worker
 *
 * Admin-only MCP server for maintenance and diagnostics.
 * - CF Access enforced (admin users only)
 * - MCP OAuth handles the protocol auth flow
 * - Shares D1/Vectorize bindings with API and MCP workers
 */

import { createWorkerApp, type LoggingEnv } from './lib/shared/hono/index.js';
import { logField } from './lib/shared/logging/index.js';
import { cors } from 'hono/cors';
import type { Env as BaseEnv } from './types/index.js';
import { getConfig, type Config } from './lib/config.js';
import { authorizeHandler, tokenHandler, registerHandler, validateAccessToken } from '@pantainos/mcp-core';

// Route imports
import adminMcpRoutes from './routes/admin-mcp.js';

// Extend Env with LoggingEnv for proper typing
type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
  cfAccessEmail: string | undefined;
};

const app = createWorkerApp<Env, Variables>({ serviceName: 'memory-admin' });

// Global CORS for MCP/OAuth clients
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

// Session ID middleware
app.use('*', async (c, next) => {
  const sessionId = c.req.header('X-Session-Id');
  c.set('sessionId', sessionId);
  await next();
});

// CF Access identity extraction middleware
app.use('*', async (c, next) => {
  const cfAccessJwt = c.req.header('Cf-Access-Jwt-Assertion');
  if (cfAccessJwt) {
    try {
      const parts = cfAccessJwt.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        c.set('cfAccessEmail', payload.email);
        logField(c, 'cf_access_email', payload.email);
      }
    } catch {
      // JWT decode failed - not critical
    }
  }
  await next();
});

// Actor context middleware
app.use('*', async (c, next) => {
  const userAgent = c.req.header('User-Agent');
  c.set('userAgent', userAgent);

  const clientIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  if (clientIp) {
    const encoder = new TextEncoder();
    const data = encoder.encode(clientIp + '-memory-admin-salt');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const ipHash = hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    c.set('ipHash', ipHash);
  } else {
    c.set('ipHash', undefined);
  }

  await next();
});

// Helper to get issuer URL
const getIssuerUrl = (c: { env: Env; req: { url: string } }) =>
  c.env.ISSUER_URL || new URL(c.req.url).origin;

// ============================================
// Root - Discovery/Info
// ============================================

app.get('/', (c) => {
  const issuer = getIssuerUrl(c);
  return c.json({
    name: 'memory-admin',
    version: '1.0.0',
    description: 'Pantainos Memory Admin MCP Server',
    endpoints: {
      mcp_http: `${issuer}/mcp`,
      oauth_metadata: `${issuer}/.well-known/oauth-authorization-server`,
      resource_metadata: `${issuer}/.well-known/oauth-protected-resource`,
      register: `${issuer}/register`,
      authorize: `${issuer}/authorize`,
      token: `${issuer}/token`,
    },
  });
});

// ============================================
// OAuth 2.0 Endpoints
// ============================================

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

app.get('/authorize', async (c) => {
  logField(c, 'oauth_flow', 'authorization');
  return authorizeHandler(c.req.raw, c.env);
});

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

// ============================================
// Health Check
// ============================================

app.get('/health', async (c) => {
  const checks: Record<string, { status: string; error?: string }> = {
    d1: { status: 'unknown' },
    vectorize: { status: 'unknown' },
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
// MCP Routes (OAuth protected, no service token fallback)
// ============================================

app.use('/mcp/*', async (c, next) => {
  const tokenData = await validateAccessToken(c.req.raw, c.env);

  if (tokenData) {
    logField(c, 'auth_method', 'oauth');
    logField(c, 'auth_email', tokenData.email);
    await next();
    return;
  }

  // No service token fallback for admin — OAuth only
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

app.route('/mcp', adminMcpRoutes);

// Export for Cloudflare Workers
export default {
  fetch: app.fetch,
};
