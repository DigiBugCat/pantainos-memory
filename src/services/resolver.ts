/**
 * Resolver Service
 *
 * Generic dispatch endpoint for session batches. Supports resolver backends:
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
  cascade_type: 'review';
  memory_type: 'thought';
  context: {
    reason: string;
    source_id: string;
    source_outcome: 'correct' | 'incorrect' | 'void';
    edge_type: string;
    suggested_action: string;
  };
}

export interface OverduePredictionEvent {
  id: string;
  memory_id: string;
  context: {
    content: string;
    outcome_condition: string | null;
    resolves_by: number;
    invalidates_if?: string[];
    confirms_if?: string[];
  };
}

export interface ResolverPayload {
  batchId: string;
  sessionId: string;
  violations: ViolationEvent[];
  confirmations: ConfirmationEvent[];
  cascades: CascadeEvent[];
  overduePredictions: OverduePredictionEvent[];
  summary: {
    violationCount: number;
    confirmationCount: number;
    cascadeCount: number;
    overduePredictionCount: number;
    affectedMemories: string[];
  };
}

export type ResolverType = 'webhook' | 'github' | 'none';

/**
 * Dispatch session batch to the configured resolver.
 *
 * The resolver backend is configured via RESOLVER_TYPE env var:
 * - 'webhook': POSTs to RESOLVER_WEBHOOK_URL with bearer token auth
 * - 'none' (default): Logs and returns (for testing)
 *
 * @param env - Worker environment with resolver configuration
 * @param payload - The session batch payload
 * @throws Error if resolver type is unknown or required config is missing
 */
export async function dispatchToResolver(env: Env, payload: ResolverPayload): Promise<void> {
  const resolverType = (env.RESOLVER_TYPE || 'none') as ResolverType;

  getLog().info('dispatching', {
    batch_id: payload.batchId,
    resolver_type: resolverType,
    session_id: payload.sessionId,
    violations: payload.summary.violationCount,
    confirmations: payload.summary.confirmationCount,
    overdue_predictions: payload.summary.overduePredictionCount,
  });

  switch (resolverType) {
    case 'webhook':
      await dispatchViaWebhook(env, payload);
      break;

    case 'github':
      await dispatchViaGitHub(env, payload);
      break;

    case 'none':
      getLog().debug('dispatch_disabled', { batch_id: payload.batchId });
      break;

    default:
      throw new Error(`Unknown resolver type: ${resolverType}`);
  }
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

/**
 * Dispatch via GitHub issue creation.
 *
 * Creates an issue in the configured repo with the `memory-resolver` label.
 * A GitHub Actions workflow watches for this label and spawns Claude to resolve.
 */
async function dispatchViaGitHub(env: Env, payload: ResolverPayload): Promise<void> {
  if (!env.RESOLVER_GITHUB_TOKEN) {
    throw new Error('GitHub resolver requires RESOLVER_GITHUB_TOKEN');
  }
  if (!env.RESOLVER_GITHUB_REPO) {
    throw new Error('GitHub resolver requires RESOLVER_GITHUB_REPO');
  }

  const { summary } = payload;
  const parts: string[] = [];
  if (summary.violationCount > 0) parts.push(`${summary.violationCount} violation${summary.violationCount > 1 ? 's' : ''}`);
  if (summary.confirmationCount > 0) parts.push(`${summary.confirmationCount} confirmation${summary.confirmationCount > 1 ? 's' : ''}`);
  if (summary.cascadeCount > 0) parts.push(`${summary.cascadeCount} cascade${summary.cascadeCount > 1 ? 's' : ''}`);
  if (summary.overduePredictionCount > 0) parts.push(`${summary.overduePredictionCount} overdue prediction${summary.overduePredictionCount > 1 ? 's' : ''}`);
  const title = `Memory Resolver: ${parts.join(', ')}`;

  const body = formatGitHubIssueBody(payload);

  const response = await fetch(`https://api.github.com/repos/${env.RESOLVER_GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${env.RESOLVER_GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'pantainos-memory',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      title,
      body,
      labels: ['memory-resolver'],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub issue creation failed: ${response.status} - ${text}`);
  }

  const issue = await response.json() as { number: number; html_url: string };
  getLog().info('github_issue_created', {
    repo: env.RESOLVER_GITHUB_REPO,
    issue_number: issue.number,
    url: issue.html_url,
  });
}

/**
 * Format the resolver payload into a structured GitHub issue body.
 */
function formatGitHubIssueBody(payload: ResolverPayload): string {
  const sections: string[] = [];

  sections.push(`## Memory Resolver Event\n`);
  sections.push(`- **Batch ID:** \`${payload.batchId}\``);
  sections.push(`- **Session ID:** \`${payload.sessionId}\``);
  sections.push(`- **Affected Memories:** ${payload.summary.affectedMemories.map(id => `\`${id}\``).join(', ')}\n`);

  if (payload.violations.length > 0) {
    sections.push(`### Violations (${payload.violations.length})\n`);
    sections.push(`| Memory ID | Violated By | Damage Level | Context |`);
    sections.push(`|-----------|-------------|--------------|---------|`);
    for (const v of payload.violations) {
      const ctx = v.context.condition || v.context.reason || '';
      sections.push(`| \`${v.memory_id}\` | \`${v.violated_by || 'N/A'}\` | ${v.damage_level || 'N/A'} | ${ctx} |`);
    }
    sections.push('');
  }

  if (payload.confirmations.length > 0) {
    sections.push(`### Confirmations (${payload.confirmations.length})\n`);
    sections.push(`| Memory ID | Context |`);
    sections.push(`|-----------|---------|`);
    for (const c of payload.confirmations) {
      const ctx = c.context.condition || c.context.reason || '';
      sections.push(`| \`${c.memory_id}\` | ${ctx} |`);
    }
    sections.push('');
  }

  if (payload.cascades.length > 0) {
    sections.push(`### Cascades (${payload.cascades.length})\n`);
    sections.push(`| Memory ID | Source | Reason |`);
    sections.push(`|-----------|--------|--------|`);
    for (const c of payload.cascades) {
      sections.push(`| \`${c.memory_id}\` | \`${c.context.source_id}\` | ${c.context.reason} |`);
    }
    sections.push('');
  }

  if (payload.overduePredictions.length > 0) {
    sections.push(`### Overdue Predictions (${payload.overduePredictions.length})\n`);
    for (const p of payload.overduePredictions) {
      sections.push(`#### \`${p.memory_id}\`\n`);
      sections.push(`- **Content:** ${p.context.content}`);
      sections.push(`- **Outcome Condition:** ${p.context.outcome_condition || 'N/A'}`);
      sections.push(`- **Deadline:** ${new Date(p.context.resolves_by).toISOString()}`);
      if (p.context.invalidates_if && p.context.invalidates_if.length > 0) {
        sections.push(`- **Invalidates If:** ${p.context.invalidates_if.join('; ')}`);
      }
      if (p.context.confirms_if && p.context.confirms_if.length > 0) {
        sections.push(`- **Confirms If:** ${p.context.confirms_if.join('; ')}`);
      }
      sections.push('');
    }
  }

  sections.push(`<details>\n<summary>Raw Payload</summary>\n`);
  sections.push('```json');
  sections.push(JSON.stringify(payload, null, 2));
  sections.push('```\n</details>');

  return sections.join('\n');
}
