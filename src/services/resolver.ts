/**
 * Resolver Service
 *
 * Generic dispatch endpoint for session batches. Supports multiple resolver
 * backends:
 * - 'github': Dispatch to GitHub Actions via repository_dispatch
 * - 'webhook': POST to a configured webhook URL
 * - 'none': No-op (for testing or when resolver is disabled)
 *
 * The resolver receives batched events for a session and triggers agentic
 * processing to reason about violations and their implications.
 */

import type { Env } from '../types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';

// Lazy logger - avoids crypto in global scope
let _log: ReturnType<typeof createStandaloneLogger> | null = null;
function getLog() {
  if (!_log) {
    _log = createStandaloneLogger({
      component: 'ResolverService',
      requestId: 'resolver-init',
    });
  }
  return _log;
}

export interface ViolationEvent {
  id: string;
  memory_id: string;
  violated_by: string | null;
  damage_level: string | null;
  context: Record<string, unknown>;
}

export interface ConfirmationEvent {
  id: string;
  memory_id: string;
  context: Record<string, unknown>;
}

export interface CascadeEvent {
  id: string;
  memory_id: string;
  cascade_type: 'review' | 'boost' | 'damage';
  // v4: Unified assumption type (time_bound indicates pred-like behavior)
  memory_type: 'assumption';
  context: {
    reason: string;
    source_id: string;
    source_outcome: 'correct' | 'incorrect' | 'void';
    edge_type: string;
    suggested_action: string;
  };
}

export interface ResolverPayload {
  batchId: string;
  sessionId: string;
  violations: ViolationEvent[];
  confirmations: ConfirmationEvent[];
  cascades: CascadeEvent[];
  summary: {
    violationCount: number;
    confirmationCount: number;
    cascadeCount: number;
    affectedMemories: string[];
  };
}

export type ResolverType = 'github' | 'webhook' | 'none';

/**
 * Dispatch to GitHub via repository_dispatch event.
 * Inlined from @cassandra/shared to avoid external dependency.
 */
async function dispatchToGitHub(params: {
  owner: string;
  repo: string;
  token: string;
  eventType: string;
  clientPayload: Record<string, unknown>;
}): Promise<void> {
  const { owner, repo, token, eventType, clientPayload } = params;
  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'pantainos-memory',
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: clientPayload,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} - ${text}`);
  }
}

/**
 * Dispatch session batch to the configured resolver.
 *
 * The resolver backend is configured via RESOLVER_TYPE env var:
 * - 'github' (default): Uses repository_dispatch to trigger GitHub Actions
 * - 'webhook': POSTs to RESOLVER_WEBHOOK_URL with bearer token auth
 * - 'none': Logs and returns (for testing)
 *
 * @param env - Worker environment with resolver configuration
 * @param payload - The session batch payload
 * @throws Error if resolver type is unknown or required config is missing
 */
export async function dispatchToResolver(env: Env, payload: ResolverPayload): Promise<void> {
  const resolverType = (env.RESOLVER_TYPE || 'github') as ResolverType;

  getLog().info('dispatching', {
    batch_id: payload.batchId,
    resolver_type: resolverType,
    session_id: payload.sessionId,
    violations: payload.summary.violationCount,
    confirmations: payload.summary.confirmationCount,
  });

  switch (resolverType) {
    case 'github':
      await dispatchViaGitHub(env, payload);
      break;

    case 'webhook':
      await dispatchViaWebhook(env, payload);
      break;

    case 'none':
      getLog().debug('dispatch_disabled', { batch_id: payload.batchId });
      break;

    default:
      throw new Error(`Unknown resolver type: ${resolverType}`);
  }
}

/**
 * Dispatch via GitHub Actions repository_dispatch.
 */
async function dispatchViaGitHub(env: Env, payload: ResolverPayload): Promise<void> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
    throw new Error('GitHub resolver requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO');
  }

  await dispatchToGitHub({
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    eventType: 'memory:session-batch',
    clientPayload: payload as unknown as Record<string, unknown>,
  });

  getLog().info('github_dispatched', { owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO });
}

/**
 * Dispatch via webhook POST.
 */
async function dispatchViaWebhook(env: Env, payload: ResolverPayload): Promise<void> {
  if (!env.RESOLVER_WEBHOOK_URL) {
    throw new Error('Webhook resolver requires RESOLVER_WEBHOOK_URL');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (env.RESOLVER_WEBHOOK_TOKEN) {
    headers['Authorization'] = `Bearer ${env.RESOLVER_WEBHOOK_TOKEN}`;
  }

  const response = await fetch(env.RESOLVER_WEBHOOK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Webhook dispatch failed: ${response.status} - ${text}`);
  }

  getLog().info('webhook_dispatched', { url: env.RESOLVER_WEBHOOK_URL });
}
