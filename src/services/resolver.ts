/**
 * Resolver Service
 *
 * Dispatches memory events to resolver agents via GitHub issues.
 * Different event types get different labels → different workflow files:
 *   - memory-violation: violations + cascades + confirmations (zone-health-aware triage)
 *   - memory-prediction: overdue predictions (research + observe)
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
 * Determine the dispatch type from payload content.
 * Violations/cascades/confirmations → 'violation'
 * Overdue predictions → 'prediction'
 */
function getDispatchType(payload: ResolverPayload): 'violation' | 'prediction' {
  if (payload.overduePredictions.length > 0) return 'prediction';
  return 'violation';
}

/**
 * Dispatch session batch to the configured resolver.
 */
export async function dispatchToResolver(env: Env, payload: ResolverPayload): Promise<void> {
  const resolverType = (env.RESOLVER_TYPE || 'none') as ResolverType;

  getLog().info('dispatching', {
    batch_id: payload.batchId,
    resolver_type: resolverType,
    dispatch_type: getDispatchType(payload),
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
 * Uses type-specific labels so different workflows handle each event type:
 * - memory-violation → .github/workflows/memory-violation-resolver.yml
 * - memory-prediction → .github/workflows/memory-prediction-resolver.yml
 */
async function dispatchViaGitHub(env: Env, payload: ResolverPayload): Promise<void> {
  if (!env.RESOLVER_GITHUB_TOKEN) {
    throw new Error('GitHub resolver requires RESOLVER_GITHUB_TOKEN');
  }
  if (!env.RESOLVER_GITHUB_REPO) {
    throw new Error('GitHub resolver requires RESOLVER_GITHUB_REPO');
  }

  const dispatchType = getDispatchType(payload);
  const label = `memory-${dispatchType}`;
  const title = buildIssueTitle(payload, dispatchType);
  const body = formatGitHubIssueBody(payload, dispatchType);

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
      labels: [label],
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
    label,
    dispatch_type: dispatchType,
  });
}

/**
 * Build issue title based on dispatch type.
 */
function buildIssueTitle(payload: ResolverPayload, dispatchType: 'violation' | 'prediction'): string {
  const { summary } = payload;

  if (dispatchType === 'prediction') {
    const pred = payload.overduePredictions[0];
    const content = pred?.context.content || '';
    const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
    return `Prediction Overdue: ${preview}`;
  }

  // Violation dispatch
  const parts: string[] = [];
  if (summary.violationCount > 0) parts.push(`${summary.violationCount} violation${summary.violationCount > 1 ? 's' : ''}`);
  if (summary.cascadeCount > 0) parts.push(`${summary.cascadeCount} cascade${summary.cascadeCount > 1 ? 's' : ''}`);
  if (summary.confirmationCount > 0) parts.push(`${summary.confirmationCount} confirmation${summary.confirmationCount > 1 ? 's' : ''}`);
  return `Violation Alert: ${parts.join(', ')}`;
}

/**
 * Format the resolver payload into a structured GitHub issue body.
 */
function formatGitHubIssueBody(payload: ResolverPayload, dispatchType: 'violation' | 'prediction'): string {
  const sections: string[] = [];

  if (dispatchType === 'violation') {
    sections.push(`## Violation Alert\n`);
  } else {
    sections.push(`## Prediction Resolution\n`);
  }

  sections.push(`- **Batch ID:** \`${payload.batchId}\``);
  sections.push(`- **Session ID:** \`${payload.sessionId}\``);
  sections.push(`- **Affected Memories:** ${payload.summary.affectedMemories.map(id => `\`${id}\``).join(', ')}\n`);

  // --- Violations ---
  if (payload.violations.length > 0) {
    const hasZoneHealth = payload.violations.some(v => v.context.zone_health);

    sections.push(`### Violations (${payload.violations.length})\n`);
    if (hasZoneHealth) {
      sections.push(`| Memory ID | Violated By | Damage | Zone Status | Quality | Condition |`);
      sections.push(`|-----------|-------------|--------|-------------|---------|-----------|`);
      for (const v of payload.violations) {
        const zh = v.context.zone_health as { balanced?: boolean; quality_pct?: number; zone_size?: number } | undefined;
        const zoneStatus = zh ? (zh.balanced ? 'balanced' : '**UNBALANCED**') : 'N/A';
        const quality = zh ? `${zh.quality_pct}%` : 'N/A';
        const ctx = (v.context.condition || v.context.reason || '') as string;
        sections.push(`| \`${v.memory_id}\` | \`${v.violated_by || 'N/A'}\` | ${v.damage_level || 'N/A'} | ${zoneStatus} | ${quality} | ${ctx} |`);
      }
    } else {
      sections.push(`| Memory ID | Violated By | Damage Level | Condition |`);
      sections.push(`|-----------|-------------|--------------|-----------|`);
      for (const v of payload.violations) {
        const ctx = v.context.condition || v.context.reason || '';
        sections.push(`| \`${v.memory_id}\` | \`${v.violated_by || 'N/A'}\` | ${v.damage_level || 'N/A'} | ${ctx} |`);
      }
    }
    sections.push('');
  }

  // --- Confirmations ---
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

  // --- Cascades ---
  if (payload.cascades.length > 0) {
    sections.push(`### Cascades (${payload.cascades.length})\n`);
    sections.push(`| Memory ID | Source | Reason |`);
    sections.push(`|-----------|--------|--------|`);
    for (const c of payload.cascades) {
      sections.push(`| \`${c.memory_id}\` | \`${c.context.source_id}\` | ${c.context.reason} |`);
    }
    sections.push('');
  }

  // --- Overdue Predictions ---
  if (payload.overduePredictions.length > 0) {
    sections.push(`### Overdue Prediction\n`);
    for (const p of payload.overduePredictions) {
      sections.push(`- **Memory ID:** \`${p.memory_id}\``);
      sections.push(`- **Content:** ${p.context.content}`);
      sections.push(`- **Outcome Condition:** ${p.context.outcome_condition || 'N/A'}`);
      const deadlineMs = p.context.resolves_by < 1e12 ? p.context.resolves_by * 1000 : p.context.resolves_by;
      sections.push(`- **Deadline:** ${new Date(deadlineMs).toISOString()}`);
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
