/**
 * MCP (Model Context Protocol) routes for pantainos-memory.
 *
 * Exposes the memory system's functionality as MCP tools, enabling
 * Claude Code and other MCP clients to interact with the knowledge graph.
 *
 * Endpoint: POST /mcp
 *
 * Authentication: Cloudflare Access headers expected.
 * The CF-Access-Authenticated-User-Email header provides user identity.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv, MemoryRow, ScoredMemory, RecordAccessParams, EdgeRow } from '../types/index.js';
import type { Config } from '../lib/config.js';
import type { ExposureCheckJob } from '../lib/shared/types/index.js';
import { getDisplayType } from '../lib/shared/types/index.js';
import {
  handleMcpMessage,
  parseJsonRpcRequest,
  createToolRegistry,
  defineTool,
  errorResult,
  type ToolContext,
} from '../lib/shared/mcp/index.js';
import type { LoggingEnv } from '../lib/shared/hono/index.js';

// Service imports for direct calls
import { generateId } from '../lib/id.js';
import { TYPE_STARTING_CONFIDENCE } from '../services/confidence.js';
import { getStartingConfidenceForSource, computeSystemStats, getSystemStatsSummary } from '../jobs/compute-stats.js';
import { generateEmbedding, searchSimilar, checkDuplicate, checkDuplicateWithLLM, callExternalLLM } from '../lib/embeddings.js';
import { storeObservationEmbeddings, storeObservationWithConditions, storeThoughtEmbeddings } from '../services/embedding-tables.js';
import { recordVersion } from '../services/history-service.js';
import { recordAccessBatch, querySessionMemories, type SessionMemoryAccess } from '../services/access-service.js';
import { rowToMemory } from '../lib/transforms.js';
import { normalizeSource, isNonEmptySource } from '../lib/source.js';
import { createScoredMemory } from '../lib/scoring.js';
import { incrementCentrality } from '../services/exposure-checker.js';
import { checkMemoryCompleteness, formatCompletenessOutput } from '../services/classification-challenge.js';
import { deleteConditionVectors } from '../services/embedding-tables.js';
import { propagateResolution } from '../services/cascade.js';
import { findMostSurprising } from '../services/surprise.js';
import {
  formatZone,
  parseViolationCount,
  isOverwhelminglyViolated,
  addBoundaryReason,
  checkSignedBalance,
  type SafetyRow,
} from '../lib/zones.js';
import {
  queryInChunks,
  queryContradictionGate,
  fetchMemoriesByIds,
  fetchEdgesBySourceIds,
  fetchEdgesByTargetIds,
} from '../lib/sql-utils.js';
import { findMemories } from '../usecases/find-memories.js';
import { recallMemory } from '../usecases/recall-memory.js';
import { getStatsSummary } from '../usecases/stats-summary.js';
import {
  normalizeAndValidateSource,
  validateDerivedFromIds,
  validateOrigin,
  validateTimeBound,
} from '../usecases/observe-memory.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

/**
 * Parse a resolves_by value into Unix seconds.
 * Accepts:
 *   - Date string: "2026-03-15", "2026-03-15T00:00:00Z", "March 15, 2026"
 *   - Unix seconds: 1770000000 (< 1e12)
 *   - Unix milliseconds: 1770000000000 (>= 1e12, auto-converted)
 * Returns Unix seconds, or null if unparseable.
 */
function parseResolvesBy(value: unknown): number | null {
  if (value === undefined || value === null) return null;

  if (typeof value === 'number') {
    // Already a number — normalize to seconds
    return value >= 1e12 ? Math.floor(value / 1000) : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    // Try as a pure number string
    const asNum = Number(trimmed);
    if (!isNaN(asNum) && trimmed.length > 0) {
      return asNum >= 1e12 ? Math.floor(asNum / 1000) : asNum;
    }

    // Try as a date string
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }

    return null;
  }

  return null;
}

/** Convert stored resolves_by (Unix seconds) to display date string */
function formatResolvesBy(seconds: number): string {
  const ms = seconds < 1e12 ? seconds * 1000 : seconds;
  return new Date(ms).toISOString().split('T')[0];
}

// ============================================
// Text Formatting Helpers (human-readable output)
// ============================================

/** Format a memory for display - compact single-line format */
function formatMemory(m: { id: string; content: string; state?: string; times_tested?: number; confirmations?: number }): string {
  const stateIcon = m.state === 'violated' ? ' ⚠️' : m.state === 'confirmed' ? ' ✓' : '';
  const confidence = m.times_tested && m.times_tested > 0
    ? ` (${Math.round((m.confirmations || 0) / m.times_tested * 100)}% conf, ${m.times_tested} tests)`
    : '';
  return `[${m.id}] ${m.content}${stateIcon}${confidence}`;
}

/** Get outcome/state icon for display */
function getOutcomeIcon(state?: string, outcome?: string): string {
  if (state === 'resolved') {
    if (outcome === 'incorrect') return ' ❌';
    if (outcome === 'superseded') return ' ⏰';
    if (outcome === 'correct') return ' ✅';
    if (outcome === 'voided') return ' 🚫';
  }
  if (state === 'violated') return ' ⚠️';
  if (state === 'confirmed') return ' ✓';
  return '';
}

/** Format search results */
function formatFindResults(results: Array<{ memory: { id: string; content: string; state?: string; outcome?: string }; similarity: number; confidence: number; surprise?: number }>, query: string): string {
  if (results.length === 0) return `No results for "${query}"`;

  const lines = results.map((r, i) => {
    const sim = Math.round(r.similarity * 100);
    const conf = Math.round(r.confidence * 100);
    const icon = getOutcomeIcon(r.memory.state, r.memory.outcome);
    const surp = r.surprise != null ? ` surp:${Math.round(r.surprise * 100)}%` : '';
    return `${i + 1}. [${r.memory.id}] ${r.memory.content}${icon}\n   sim:${sim}% conf:${conf}%${surp}`;
  });

  return `Found ${results.length} for "${query}":\n\n${lines.join('\n\n')}`;
}

/** Format recall result */
function formatRecall(memory: MemoryRow, connections: Array<{ target_id: string; strength: number }>): string {
  const m = rowToMemory(memory);
  const icon = getOutcomeIcon(m.state, m.outcome);
  const stateLabel = m.state === 'resolved' && m.outcome
    ? `resolved:${m.outcome}`
    : m.state;
  const confidence = m.times_tested > 0
    ? `${Math.round(m.confirmations / m.times_tested * 100)}% (${m.confirmations}/${m.times_tested})`
    : 'untested';

  // Describe by field presence instead of type label
  const traits: string[] = [];
  if (m.source) traits.push('sourced');
  if (m.derived_from && m.derived_from.length > 0) traits.push('derived');
  if (m.resolves_by) traits.push('time-bound');
  const traitLabel = traits.length > 0 ? traits.join(', ') : 'standalone';

  let text = `[${m.id}] ${m.content}\n\n`;
  text += `${traitLabel} | State: ${stateLabel}${icon} | Confidence: ${confidence}\n`;

  if (m.source) {
    text += `Source: ${m.source}\n`;
  }

  if (m.violations && m.violations.length > 0) {
    text += `\n⚠️ Violations:\n`;
    m.violations.forEach((v: { condition: string; obs_id: string }) => {
      text += `  - "${v.condition}" (by ${v.obs_id})\n`;
    });
  }

  if (connections.length > 0) {
    text += `\n🔗 Connections: ${connections.map(c => `[${c.target_id}]`).join(', ')}`;
  }

  return text;
}

/** Format insights results */
function formatInsights(view: string, memories: MemoryRow[], total: number, _limit: number, offset: number): string {
  if (memories.length === 0) return `No memories in "${view}" view`;

  const lines = memories.map(row => {
    const m = rowToMemory(row);
    return formatMemory(m);
  });

  const from = offset + 1;
  const to = offset + memories.length;
  return `=== ${view.toUpperCase()} === (showing ${from}-${to} of ${total})\n\n${lines.join('\n')}`;
}

/** Format pending predictions */
function formatPending(memories: Array<{ id: string; content: string; resolves_by?: number }>, total: number, _limit: number, offset: number): string {
  if (memories.length === 0) return 'No pending time-bound memories';

  const lines = memories.map(m => {
    const deadline = m.resolves_by ? formatResolvesBy(m.resolves_by) : 'no deadline';
    return `[${m.id}] ${m.content}\n   Resolves by: ${deadline}`;
  });

  const from = offset + 1;
  const to = offset + memories.length;
  return `=== PENDING RESOLUTION === (showing ${from}-${to} of ${total})\n\n${lines.join('\n\n')}`;
}

type Memory = ReturnType<typeof rowToMemory>;

// truncate/formatConfidence/scoreZone/formatZone/parseViolationCount/isOverwhelminglyViolated
// imported from ../lib/zones.js

/** Text result wrapper */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

type NotificationRow = {
  id: string;
  type: string;
  memory_id: string;
  content: string;
  context: string | null;
  created_at: number;
};

async function prependUnreadNotifications(db: D1Database, response: unknown): Promise<void> {
  const resp = response as { result?: unknown } | null;
  if (!resp || typeof resp !== 'object') return;

  const result = (resp as { result?: unknown }).result as { content?: unknown } | undefined;
  if (!result || typeof result !== 'object') return;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  const unread = await db.prepare(
    `SELECT id, type, memory_id, content, context, created_at
     FROM notifications
     WHERE read = 0
     ORDER BY created_at DESC
     LIMIT 5`
  ).all<NotificationRow>();

  const notifications = unread.results ?? [];
  if (notifications.length === 0) return;

  const header = [
    '=== NOTIFICATIONS ===',
    ...notifications.map(n => `- ${n.content}`),
    '',
  ].join('\n');

  // Prepend to tool result text if possible.
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first && first.type === 'text' && typeof first.text === 'string') {
    (first as { text: string }).text = header + (first as { text: string }).text;
  } else {
    content.unshift({ type: 'text', text: header.trimEnd() });
  }

  // Mark as read.
  const ids = notifications.map(n => n.id);
  const placeholders = ids.map(() => '?').join(',');
  await db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`).bind(...ids).run();
}

/** Build LLM prompt for session recap summarization */
function buildRecapPrompt(accesses: SessionMemoryAccess[]): string {
  const memoryList = accesses.map(a => {
    const queries = a.queryTexts.length > 0 ? ` (surfaced by: ${a.queryTexts.join('; ')})` : '';
    return `- [${a.memoryId}] (${a.displayType}, ${a.state}) ${a.content.substring(0, 200)}${a.content.length > 200 ? '...' : ''}${queries}`;
  }).join('\n');

  return `You are summarizing a research session for an AI agent. Below are the memories accessed during this session.

Memories accessed (${accesses.length} total):
${memoryList}

Write a concise session recap (3-5 paragraphs):
1. Identify 2-4 themes or topics explored
2. Note connections between memories where apparent
3. Highlight key findings or patterns
4. Use [ID] notation when referencing specific memories

Be concise and insightful. Focus on what the session revealed, not just what was looked up.`;
}

/** Format raw recap (structured fallback when LLM unavailable) */
function formatRawRecap(accesses: SessionMemoryAccess[], sessionId: string | undefined, minutes: number): string {
  const scope = sessionId ? `session ${sessionId}` : `last ${minutes} minutes`;
  let text = `=== SESSION RECAP (raw) === ${scope}\n${accesses.length} memories accessed\n\n`;

  const byType: Record<string, SessionMemoryAccess[]> = {};
  for (const a of accesses) {
    (byType[a.displayType] ??= []).push(a);
  }

  for (const [type, items] of Object.entries(byType)) {
    text += `--- ${type.toUpperCase()}S (${items.length}) ---\n`;
    for (const item of items) {
      const queries = item.queryTexts.length > 0 ? `\n   queries: ${item.queryTexts.join(', ')}` : '';
      text += `[${item.memoryId}] ${item.content.substring(0, 150)}${item.content.length > 150 ? '...' : ''}${queries}\n`;
    }
    text += '\n';
  }

  return text.trim();
}

/** Wrap LLM summary with header and referenced IDs */
function formatRecapResult(summary: string, memoryIds: string[], total: number): string {
  let text = `=== SESSION RECAP === (${total} memories)\n\n${summary}`;
  if (memoryIds.length > 0) {
    text += `\n\nReferenced: ${memoryIds.map(id => `[${id}]`).join(', ')}`;
  }
  return text;
}

// ============================================
// Tool Definitions
// ============================================

const createMemoryTools = (config: Config, requestId: string) => createToolRegistry<Env>([
  // ----------------------------------------
  // Write Path - Create and modify memories
  // ----------------------------------------

defineTool({
    name: 'observe',
    description: `Store a new memory. Every memory is a perception — what you saw, read, inferred, or predicted.

ATOMICITY PRINCIPLE (enforced):
Each memory MUST capture ONE atomic insight — a single claim, fact, observation, or prediction.
If your content contains multiple distinct claims, split them into separate observe calls and link via derived_from.

NON-ATOMIC (will be rejected):
- "Revenue hit $5B AND new CEO announced AND expanding to Europe" → 3 separate memories
- "1) NVDA up 3% 2) analysts bullish 3) competitors lagging" → 3 separate memories
- Multiple predictions bundled together → one memory per prediction

ATOMIC (good):
- "Company X Q4 2025 revenue: $5.2B (beat estimates by 8%)"
- "NVDA trading at $850, up 3% on 2026-02-17"
- A single continuous quote from an earnings call (even if long)

Use atomic_override: true ONLY for intentionally composite notes (rare).

Set "source" for provenance (what you perceived from), "derived_from" for lineage (what memories informed this).
Both can be set together. At least one is required.

source examples: "market", "sec-10k", "reddit", "polygon-api", "analyst-report", "earnings-call", "human", "agent-research"
For time-bound claims: add resolves_by (date string or timestamp) + outcome_condition.
All memories support invalidates_if/confirms_if conditions.`,
    annotations: {
      title: 'Record Memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content' },
        source: {
          type: 'string',
          description: 'Free-text provenance string (examples: "market", "sec-10k", "reddit", "polygon-api", "analyst-report", "earnings-call", "human", "agent-research")',
        },
        source_url: { type: 'string', description: 'URL/link where this information came from' },
        derived_from: { type: 'array', items: { type: 'string' }, description: 'Source memory IDs this memory derives from' },
        invalidates_if: { type: 'array', items: { type: 'string' }, description: 'Conditions that would prove this wrong' },
        confirms_if: { type: 'array', items: { type: 'string' }, description: 'Conditions that would strengthen this' },
        assumes: { type: 'array', items: { type: 'string' }, description: 'Underlying assumptions' },
        resolves_by: { type: 'string', description: 'Deadline as date string (e.g. "2026-03-15") or Unix timestamp' },
        outcome_condition: { type: 'string', description: 'Success/failure criteria (required if resolves_by set)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        obsidian_sources: { type: 'array', items: { type: 'string' }, description: 'Obsidian vault file paths that reference this memory' },
        atomic_override: { type: 'boolean', description: 'Bypass atomicity check for intentionally composite notes. Use sparingly.' },
      },
      required: ['content'],
    },
    handler: async (args, ctx) => {
      const {
        content,
        source,
        source_url,
        derived_from,
        invalidates_if,
        confirms_if,
        assumes,
        resolves_by: rawResolvesBy,
        outcome_condition,
        tags,
        obsidian_sources,
        atomic_override,
      } = args as {
        content: string;
        source?: string;
        source_url?: string;
        derived_from?: string[];
        invalidates_if?: string[];
        confirms_if?: string[];
        assumes?: string[];
        resolves_by?: number | string;
        outcome_condition?: string;
        tags?: string[];
        obsidian_sources?: string[];
        atomic_override?: boolean;
      };

      // Parse resolves_by: accepts date strings ("2026-03-15") or Unix timestamps
      const resolves_by = parseResolvesBy(rawResolvesBy);
      if (rawResolvesBy !== undefined && resolves_by === null) {
        return errorResult(`Could not parse resolves_by: "${rawResolvesBy}". Use a date string (e.g. "2026-03-15") or Unix timestamp.`);
      }

      // Normalize source before validation/persistence
      const sourceValidation = normalizeAndValidateSource(source);
      if (sourceValidation.error) {
        return errorResult(sourceValidation.error);
      }
      const normalizedSource = sourceValidation.normalizedSource;

      // Validate origin: at least one of source or derived_from required
      const originError = validateOrigin(normalizedSource, derived_from);
      const hasSource = normalizedSource !== undefined;
      const hasDerivedFrom = derived_from !== undefined && derived_from !== null && derived_from.length > 0;
      if (originError) {
        return errorResult('Either "source" or "derived_from" is required. Set "source" for provenance, "derived_from" for lineage, or both.');
      }

      // Field-specific validation
      if (hasDerivedFrom) {
        const derivedFromError = await validateDerivedFromIds(ctx.env.DB, derived_from);
        if (derivedFromError) {
          return errorResult(derivedFromError);
        }
      }

      // Time-bound validation
      const timeBound = resolves_by !== null && resolves_by !== undefined;
      const timeBoundError = validateTimeBound(resolves_by ?? undefined, outcome_condition);
      if (timeBoundError) {
        return errorResult(timeBoundError);
      }

      // Generate embedding first for duplicate check
      const embedding = await generateEmbedding(ctx.env.AI, content, config, requestId);

      // Check for duplicates
      const dupCheck = await checkDuplicate(ctx.env, embedding, requestId);
      if (dupCheck.id && dupCheck.similarity >= config.dedupThreshold) {
        const existing = await ctx.env.DB.prepare(
          `SELECT content FROM memories WHERE id = ?`
        ).bind(dupCheck.id).first<{ content: string }>();

        return errorResult(`Duplicate detected (${Math.round(dupCheck.similarity * 100)}% match). Existing: [${dupCheck.id}] ${existing?.content || '(not found)'}`);
      } else if (dupCheck.id && dupCheck.similarity >= config.dedupLowerThreshold) {
        const existing = await ctx.env.DB.prepare(
          `SELECT content FROM memories WHERE id = ?`
        ).bind(dupCheck.id).first<{ content: string }>();

        if (existing) {
          const llmResult = await checkDuplicateWithLLM(ctx.env.AI, content, existing.content, config, requestId, ctx.env);
          if (llmResult.isDuplicate && llmResult.confidence >= config.dedupConfidenceThreshold) {
            return errorResult(`Duplicate detected (LLM: ${Math.round(llmResult.confidence * 100)}% confidence). Existing: [${dupCheck.id}] ${existing.content}. Reason: ${llmResult.reasoning}`);
          }
        }
      }

      // Check for memory completeness before creating (feature toggle)
      const completeness = await checkMemoryCompleteness(ctx.env, ctx.env.AI, config, {
        content,
        has_source: hasSource,
        has_derived_from: hasDerivedFrom,
        has_invalidates_if: Boolean(invalidates_if?.length),
        has_confirms_if: Boolean(confirms_if?.length),
        has_resolves_by: timeBound,
        atomic_override,
        requestId,
      });
      if (completeness && !completeness.is_complete && completeness.missing_fields.length > 0) {
        return errorResult(formatCompletenessOutput(completeness));
      }

      const now = Date.now();
      const id = generateId();
      const sessionId = ctx.sessionId;

      // Determine starting confidence based on mode
      let startingConfidence: number;
      if (hasSource) {
        // Has provenance: use source-based confidence
        startingConfidence = await getStartingConfidenceForSource(ctx.env.DB, normalizedSource!);
      } else {
        // Derived only: predictions get lower prior than general perceptions
        startingConfidence = timeBound ? TYPE_STARTING_CONFIDENCE.predict : TYPE_STARTING_CONFIDENCE.think;
      }

      // Unified INSERT into memories table
      await ctx.env.DB.prepare(
        `INSERT INTO memories (
          id, content, source, source_url, derived_from,
          assumes, invalidates_if, confirms_if,
          outcome_condition, resolves_by,
          starting_confidence, confirmations, times_tested, contradictions,
          centrality, state, violations,
          retracted, tags, obsidian_sources, session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'active', '[]', 0, ?, ?, ?, ?)`
      ).bind(
        id,
        content,
        hasSource ? normalizedSource : null,
        source_url || null,
        hasDerivedFrom ? JSON.stringify(derived_from) : null,
        assumes ? JSON.stringify(assumes) : null,
        invalidates_if ? JSON.stringify(invalidates_if) : null,
        confirms_if ? JSON.stringify(confirms_if) : null,
        outcome_condition || null,
        resolves_by || null,
        startingConfidence,
        tags ? JSON.stringify(tags) : null,
        obsidian_sources ? JSON.stringify(obsidian_sources) : null,
        sessionId || null,
        now
      ).run();

      // For thoughts: create derivation edges and increment centrality
      if (hasDerivedFrom) {
        for (const sourceId of derived_from!) {
          const edgeId = generateId();
          await ctx.env.DB.prepare(
            `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
             VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
          ).bind(edgeId, sourceId, id, now).run();

          await incrementCentrality(ctx.env.DB, sourceId);
        }
      }

      // Record version for audit trail
      await recordVersion(ctx.env.DB, {
        entityId: id,
        entityType: 'memory',
        changeType: 'created',
        contentSnapshot: {
          id,
          content,
          source: hasSource ? normalizedSource : undefined,
          source_url: source_url || undefined,
          derived_from: hasDerivedFrom ? derived_from : undefined,
          assumes,
          invalidates_if,
          confirms_if,
          outcome_condition,
          resolves_by,
          tags,
          obsidian_sources,
          starting_confidence: startingConfidence,
          confirmations: 0,
          times_tested: 0,
          contradictions: 0,
          centrality: 0,
          state: 'active',
          violations: [],
          retracted: false,
          time_bound: timeBound,
        },
        sessionId,
        requestId,
      });

      // Store embeddings based on mode
      const hasConditions = (invalidates_if && invalidates_if.length > 0) ||
        (confirms_if && confirms_if.length > 0);

      if (hasSource) {
        // Source-based embeddings (observation path)
        if (hasConditions) {
          await storeObservationWithConditions(ctx.env, ctx.env.AI, config, {
            id,
            content,
            source: normalizedSource!,
            invalidates_if,
            confirms_if,
            requestId,
            embedding,
          });
        } else {
          await storeObservationEmbeddings(ctx.env, ctx.env.AI, config, {
            id,
            content,
            source: normalizedSource!,
            requestId,
            embedding,
          });
        }
      } else {
        // Thought mode
        await storeThoughtEmbeddings(ctx.env, ctx.env.AI, config, {
          id,
          content,
          invalidates_if,
          confirms_if,
          assumes,
          resolves_by: resolves_by ?? undefined,
          requestId,
          embedding,
        });
      }

      // Queue exposure check
      const exposureJob: ExposureCheckJob = {
        memory_id: id,
        is_observation: hasSource,
        content,
        embedding,
        session_id: sessionId,
        request_id: requestId,
        timestamp: now,
        invalidates_if: hasConditions ? invalidates_if : undefined,
        confirms_if: hasConditions ? confirms_if : undefined,
        time_bound: timeBound,
      };

      if (ctx.env.DETECTION_QUEUE) {
        await ctx.env.DETECTION_QUEUE.send(exposureJob);
      }

      // Unified response format
      let response = `✓ Stored [${id}]\n${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`;
      if (hasDerivedFrom) {
        response += `\n\nDerived from: ${derived_from!.map(d => `[${d}]`).join(', ')}`;
      }
      return textResult(response);
    },
  }),

  defineTool({
    name: 'update',
    description: 'Update a memory\'s content (corrections/refinements) or metadata. For fundamental thesis changes, use resolve(outcome="superseded", replaced_by=...) + observe() instead. Content changes on memories older than 1 hour will reset test counts (the evidence tested the OLD content). Arrays (invalidates_if, confirms_if, assumes, tags) are merged with existing values.',
    annotations: {
      title: 'Update Memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to update' },
        content: { type: 'string', description: 'New content text (replaces existing)' },
        source: {
          type: 'string',
          description: 'Free-text provenance string (examples: "market", "sec-10k", "reddit", "polygon-api", "analyst-report", "earnings-call", "human", "agent-research")',
        },
        source_url: { type: 'string', description: 'URL/link where this information came from' },
        derived_from: { type: 'array', items: { type: 'string' }, description: 'Replace derived_from IDs' },
        invalidates_if: { type: 'array', items: { type: 'string' }, description: 'Conditions to ADD (not replace)' },
        confirms_if: { type: 'array', items: { type: 'string' }, description: 'Conditions to ADD (not replace)' },
        assumes: { type: 'array', items: { type: 'string' }, description: 'Assumptions to ADD' },
        resolves_by: { type: 'string', description: 'Deadline as date string (e.g. "2026-03-15") or Unix timestamp' },
        outcome_condition: { type: 'string', description: 'Success/failure criteria (required if resolves_by set)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to ADD (not replace)' },
        obsidian_sources: { type: 'array', items: { type: 'string' }, description: 'Obsidian vault file paths to ADD (not replace)' },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const {
        memory_id: rawMemoryId,
        id: rawId,
        content: newContent,
        source: newSource,
        source_url: newSourceUrl,
        derived_from: newDerivedFrom,
        invalidates_if,
        confirms_if,
        assumes,
        resolves_by: rawResolvesBy2,
        outcome_condition,
        tags,
        obsidian_sources,
      } = args as {
        memory_id?: string;
        id?: string;
        content?: string;
        source?: string;
        source_url?: string;
        derived_from?: string[];
        invalidates_if?: string[];
        confirms_if?: string[];
        assumes?: string[];
        resolves_by?: number | string;
        outcome_condition?: string;
        tags?: string[];
        obsidian_sources?: string[];
      };

      const memory_id = rawMemoryId || rawId;
      if (!memory_id) {
        return errorResult('memory_id is required');
      }

      let normalizedNewSource: string | undefined;
      if (newSource !== undefined) {
        if (typeof newSource !== 'string' || !isNonEmptySource(newSource)) {
          return errorResult('source must be a non-empty string when provided');
        }
        normalizedNewSource = normalizeSource(newSource);
      }

      // Parse resolves_by if provided
      const resolves_by = rawResolvesBy2 !== undefined ? parseResolvesBy(rawResolvesBy2) : undefined;
      if (rawResolvesBy2 !== undefined && resolves_by === null) {
        return errorResult(`Could not parse resolves_by: "${rawResolvesBy2}". Use a date string (e.g. "2026-03-15") or Unix timestamp.`);
      }

      // Fetch the memory
      const row = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ? AND retracted = 0`
      ).bind(memory_id).first<MemoryRow>();

      if (!row) {
        return errorResult(`Memory not found: ${memory_id}`);
      }

      const now = Date.now();
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const isOldMemory = (now - row.created_at) >= ONE_HOUR_MS;

      // LLM guard: when content is being changed, check if it's a correction vs thesis change
      if (newContent && newContent !== row.content) {
        // Generate embeddings for both old and new content to check similarity
        const [oldEmbedding, newEmbedding] = await Promise.all([
          generateEmbedding(ctx.env.AI, row.content, config, requestId),
          generateEmbedding(ctx.env.AI, newContent, config, requestId),
        ]);

        // Cosine similarity between old and new content
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < oldEmbedding.length; i++) {
          dotProduct += oldEmbedding[i] * newEmbedding[i];
          normA += oldEmbedding[i] * oldEmbedding[i];
          normB += newEmbedding[i] * newEmbedding[i];
        }
        const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

        // If similarity is very low, this is likely a thesis change, not a correction
        if (similarity < 0.7) {
          // Use LLM judge as tiebreaker for borderline cases
          const guardPrompt = `Compare these two versions of a memory. Is the new version a CORRECTION (rephrasing, fixing errors, adding nuance to the same claim) or a THESIS CHANGE (fundamentally different claim)?

OLD: "${row.content}"
NEW: "${newContent}"

Respond with exactly one word: CORRECTION or THESIS_CHANGE`;

          let isThesisChange = true; // Default to blocking if LLM fails
          try {
            let guardResponse: string;
            if (ctx.env.LLM_JUDGE_URL) {
              guardResponse = await callExternalLLM(
                ctx.env.LLM_JUDGE_URL,
                guardPrompt,
                { apiKey: ctx.env.LLM_JUDGE_API_KEY, model: ctx.env.LLM_JUDGE_MODEL, requestId }
              );
            } else {
              const aiResponse = await ctx.env.AI.run(
                '@cf/meta/llama-3.1-8b-instruct' as Parameters<typeof ctx.env.AI.run>[0],
                { messages: [{ role: 'user', content: guardPrompt }] } as { messages: Array<{ role: string; content: string }> }
              ) as { response?: string };
              guardResponse = aiResponse.response || '';
            }
            isThesisChange = guardResponse.toUpperCase().includes('THESIS_CHANGE');
          } catch {
            // LLM failed — fall back to embedding similarity only
            isThesisChange = similarity < 0.5;
          }

          if (isThesisChange) {
            return errorResult(
              `This looks like a fundamental change in claim (similarity: ${Math.round(similarity * 100)}%). ` +
              `Use resolve(memory_id="${memory_id}", outcome="superseded", replaced_by="<new_id>") + observe() ` +
              `to create a supersede chain instead. update() is for corrections and refinements only.`
            );
          }
        }
      }

      // Determine current memory type
      const hasDerivedFrom = row.derived_from !== null;

      // After update, determine the effective type
      const effectiveSource = normalizedNewSource !== undefined ? normalizedNewSource : row.source;
      const effectiveDerivedFrom = newDerivedFrom !== undefined ? newDerivedFrom : (hasDerivedFrom ? JSON.parse(row.derived_from!) : null);
      const hasEffectiveSource = effectiveSource !== null;

      // Validate new derived_from IDs exist
      if (newDerivedFrom && newDerivedFrom.length > 0) {
        const placeholders = newDerivedFrom.map(() => '?').join(',');
        const sources = await ctx.env.DB.prepare(
          `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
        ).bind(...newDerivedFrom).all<{ id: string }>();

        if (!sources.results || sources.results.length !== newDerivedFrom.length) {
          const foundIds = new Set(sources.results?.map((r) => r.id) || []);
          const missing = newDerivedFrom.filter((id) => !foundIds.has(id));
          return errorResult(`Source memories not found: ${missing.join(', ')}`);
        }
      }

      // Parse existing arrays
      const existingInvalidatesIf: string[] = row.invalidates_if ? JSON.parse(row.invalidates_if) : [];
      const existingConfirmsIf: string[] = row.confirms_if ? JSON.parse(row.confirms_if) : [];
      const existingAssumes: string[] = row.assumes ? JSON.parse(row.assumes) : [];
      const existingTags: string[] = row.tags ? JSON.parse(row.tags) : [];

      // Merge arrays (ADD, not replace)
      const newInvalidatesIf = invalidates_if ? [...existingInvalidatesIf, ...invalidates_if] : existingInvalidatesIf;
      const newConfirmsIf = confirms_if ? [...existingConfirmsIf, ...confirms_if] : existingConfirmsIf;
      const newAssumes = assumes ? [...existingAssumes, ...assumes] : existingAssumes;
      const newTags = tags ? [...new Set([...existingTags, ...tags])] : existingTags;

      // Merge obsidian_sources (ADD, deduplicated)
      const existingObsidianSources: string[] = row.obsidian_sources ? JSON.parse(row.obsidian_sources) : [];
      const newObsidianSources = obsidian_sources ? [...new Set([...existingObsidianSources, ...obsidian_sources])] : existingObsidianSources;

      // Handle resolves_by and outcome_condition - allow overwriting
      const newResolvesBy = resolves_by !== undefined ? resolves_by : row.resolves_by;
      const newOutcomeCondition = outcome_condition !== undefined ? outcome_condition : row.outcome_condition;
      const timeBound = newResolvesBy !== null && newResolvesBy !== undefined;

      // Validate time-bound consistency
      if (timeBound && !newOutcomeCondition) {
        return errorResult('outcome_condition is required when resolves_by is set');
      }

      const finalContent = newContent || row.content;

      // Completeness check on the updated state
      const updateCompleteness = await checkMemoryCompleteness(ctx.env, ctx.env.AI, config, {
        content: finalContent,
        has_source: hasEffectiveSource,
        has_derived_from: effectiveDerivedFrom !== null && effectiveDerivedFrom.length > 0,
        has_invalidates_if: newInvalidatesIf.length > 0,
        has_confirms_if: newConfirmsIf.length > 0,
        has_resolves_by: timeBound,
        requestId,
      });
      if (updateCompleteness && !updateCompleteness.is_complete && updateCompleteness.missing_fields.length > 0) {
        return errorResult(formatCompletenessOutput(updateCompleteness));
      }

      // Resolve source_url: explicit update wins, otherwise keep existing
      const effectiveSourceUrl = newSourceUrl !== undefined ? (newSourceUrl || null) : row.source_url ?? null;

      // Update the memory
      await ctx.env.DB.prepare(
        `UPDATE memories SET
          content = ?,
          source = ?,
          source_url = ?,
          derived_from = ?,
          invalidates_if = ?,
          confirms_if = ?,
          assumes = ?,
          resolves_by = ?,
          outcome_condition = ?,
          tags = ?,
          obsidian_sources = ?,
          updated_at = ?
        WHERE id = ?`
      ).bind(
        finalContent,
        hasEffectiveSource ? effectiveSource : null,
        effectiveSourceUrl,
        effectiveDerivedFrom ? JSON.stringify(effectiveDerivedFrom) : null,
        newInvalidatesIf.length > 0 ? JSON.stringify(newInvalidatesIf) : null,
        newConfirmsIf.length > 0 ? JSON.stringify(newConfirmsIf) : null,
        newAssumes.length > 0 ? JSON.stringify(newAssumes) : null,
        newResolvesBy || null,
        newOutcomeCondition || null,
        newTags.length > 0 ? JSON.stringify(newTags) : null,
        newObsidianSources.length > 0 ? JSON.stringify(newObsidianSources) : null,
        now,
        memory_id
      ).run();

      // Safety rail: reset test counts when content changes on old memories
      // The evidence (confirmations, tests, contradictions) tested the OLD content
      const contentChanged = newContent !== undefined;
      if (contentChanged && isOldMemory) {
        await ctx.env.DB.prepare(
          `UPDATE memories SET confirmations = 0, times_tested = 0, contradictions = 0 WHERE id = ?`
        ).bind(memory_id).run();
      }

      // Handle derived_from edge changes
      if (newDerivedFrom !== undefined) {
        // Delete old edges and create new ones
        await ctx.env.DB.prepare(
          `DELETE FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
        ).bind(memory_id).run();

        for (const sourceId of newDerivedFrom) {
          const edgeId = generateId();
          await ctx.env.DB.prepare(
            `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
             VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
          ).bind(edgeId, sourceId, memory_id, now).run();

          await incrementCentrality(ctx.env.DB, sourceId);
        }
      }

      // Re-embed if content or conditions changed
      const addedInvalidatesIf = invalidates_if || [];
      const addedConfirmsIf = confirms_if || [];
      const needsReEmbed = contentChanged || addedInvalidatesIf.length > 0 || addedConfirmsIf.length > 0;

      if (needsReEmbed) {
        const embedding = await generateEmbedding(ctx.env.AI, finalContent, config, requestId);

        // Store new condition embeddings
        if (addedInvalidatesIf.length > 0) {
          const conditionVectors = await Promise.all(
            addedInvalidatesIf.map(async (condition, idx) => {
              const index = existingInvalidatesIf.length + idx;
              const condEmbedding = await generateEmbedding(ctx.env.AI, condition, config, requestId);
              return {
                id: `${memory_id}:inv:${index}`,
                values: condEmbedding,
                metadata: {
                  memory_id,
                  condition_index: index,
                  condition_text: condition,
                  time_bound: timeBound,
                },
              };
            })
          );
          await ctx.env.INVALIDATES_VECTORS.upsert(conditionVectors as any);
        }

        if (addedConfirmsIf.length > 0) {
          const conditionVectors = await Promise.all(
            addedConfirmsIf.map(async (condition, idx) => {
              const index = existingConfirmsIf.length + idx;
              const condEmbedding = await generateEmbedding(ctx.env.AI, condition, config, requestId);
              return {
                id: `${memory_id}:conf:${index}`,
                values: condEmbedding,
                metadata: {
                  memory_id,
                  condition_index: index,
                  condition_text: condition,
                  time_bound: timeBound,
                },
              };
            })
          );
          await ctx.env.CONFIRMS_VECTORS.upsert(conditionVectors as any);
        }

        // Update MEMORY_VECTORS with new embedding and metadata
        await ctx.env.MEMORY_VECTORS.upsert([
          {
            id: memory_id,
            values: embedding,
            metadata: {
              type: hasEffectiveSource ? 'obs' : 'thought',
              source: effectiveSource || undefined,
              has_invalidates_if: newInvalidatesIf.length > 0,
              has_confirms_if: newConfirmsIf.length > 0,
              has_assumes: newAssumes.length > 0,
              has_outcome: timeBound,
              resolves_by: newResolvesBy || undefined,
              time_bound: timeBound,
            } as any,
          },
        ]);

        // Re-queue exposure check
        const exposureJob: ExposureCheckJob = {
          memory_id,
          is_observation: hasEffectiveSource,
          content: finalContent,
          embedding,
          session_id: ctx.sessionId,
          request_id: requestId,
          timestamp: now,
          invalidates_if: newInvalidatesIf.length > 0 ? newInvalidatesIf : undefined,
          confirms_if: newConfirmsIf.length > 0 ? newConfirmsIf : undefined,
          time_bound: timeBound,
        };
        if (ctx.env.DETECTION_QUEUE) {
          await ctx.env.DETECTION_QUEUE.send(exposureJob);
        }
      }

      // Record version for audit trail
      await recordVersion(ctx.env.DB, {
        entityId: memory_id,
        entityType: 'memory',
        changeType: 'updated',
        contentSnapshot: {
          id: memory_id,
          content: finalContent,
          source: effectiveSource || undefined,
          derived_from: effectiveDerivedFrom || undefined,
          assumes: newAssumes.length > 0 ? newAssumes : undefined,
          invalidates_if: newInvalidatesIf.length > 0 ? newInvalidatesIf : undefined,
          confirms_if: newConfirmsIf.length > 0 ? newConfirmsIf : undefined,
          outcome_condition: newOutcomeCondition || undefined,
          resolves_by: newResolvesBy || undefined,
          tags: newTags.length > 0 ? newTags : undefined,
          obsidian_sources: newObsidianSources.length > 0 ? newObsidianSources : undefined,
        },
        sessionId: ctx.sessionId,
        requestId,
      });

      // Build response showing what changed
      const changes: string[] = [];
      if (contentChanged) changes.push('content updated');
      if (normalizedNewSource !== undefined) changes.push(`source → ${normalizedNewSource}`);
      if (newDerivedFrom !== undefined) changes.push(`derived_from → [${newDerivedFrom.join(', ')}]`);
      if (addedInvalidatesIf.length > 0) changes.push(`+${addedInvalidatesIf.length} invalidates_if`);
      if (addedConfirmsIf.length > 0) changes.push(`+${addedConfirmsIf.length} confirms_if`);
      if (assumes && assumes.length > 0) changes.push(`+${assumes.length} assumes`);
      if (tags && tags.length > 0) changes.push(`+${tags.length} tags`);
      if (obsidian_sources && obsidian_sources.length > 0) changes.push(`+${obsidian_sources.length} obsidian_sources`);
      if (resolves_by !== undefined) changes.push('resolves_by updated');
      if (outcome_condition !== undefined) changes.push('outcome_condition updated');

      // Safety warnings
      const warnings: string[] = [];
      if (contentChanged && isOldMemory) {
        warnings.push('Test counts reset (evidence tested old content)');
      }
      if (contentChanged && row.centrality > 0) {
        warnings.push(`This memory has ${row.centrality} dependent(s) that may need review`);
      }

      let result = `✓ Updated [${memory_id}]\n${changes.join(', ')}`;
      if (warnings.length > 0) {
        result += `\n\n⚠️ ${warnings.join('\n⚠️ ')}`;
      }
      return textResult(result);
    },
  }),

  defineTool({
    name: 'find',
    description: 'Search memories by meaning. Results ranked by: similarity (semantic match), confidence (survival rate under testing), surprise (prediction error — how novel this was when observed), and centrality (how many memories derive from this). Use to find related memories before storing new ones, or to check if a perception already exists.',
    annotations: {
      title: 'Search Memories',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        has_source: { type: 'boolean', description: 'Filter to memories with external source (provenance)' },
        has_derived_from: { type: 'boolean', description: 'Filter to memories derived from other memories' },
        time_bound: { type: 'boolean', description: 'Filter to time-bound memories (have resolves_by deadline)' },
        limit: { type: 'integer', description: 'Max results to return (default: 10)', minimum: 1, maximum: 100 },
        min_similarity: { type: 'number', description: 'Minimum similarity threshold (0-1)' },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const { query, has_source, has_derived_from, time_bound, limit: requestedLimit, min_similarity } = args as {
        query: string;
        has_source?: boolean;
        has_derived_from?: boolean;
        time_bound?: boolean;
        limit?: number;
        min_similarity?: number;
      };

      const limit = requestedLimit || config.search.defaultLimit;
      const minSimilarity = min_similarity || config.search.minSimilarity;
      const results = await findMemories(ctx.env, config, {
        query,
        limit,
        minSimilarity,
        requestId,
        candidateMultiplier: 2,
        filter: (_row, memory) => {
          const hasFilters = has_source !== undefined || has_derived_from !== undefined || time_bound !== undefined;
          if (!hasFilters) return true;
          if (has_source === true && memory.source == null) return false;
          if (has_source === false && memory.source != null) return false;
          if (has_derived_from === true && (!memory.derived_from || memory.derived_from.length === 0)) return false;
          if (has_derived_from === false && memory.derived_from && memory.derived_from.length > 0) return false;
          if (time_bound === true && memory.resolves_by == null) return false;
          if (time_bound === false && memory.resolves_by != null) return false;
          return true;
        },
      });

      // Record access events
      if (results.length > 0) {
        const accessEvents: RecordAccessParams[] = results.map((result, index) => ({
          entityId: result.memory.id,
          entityType: getDisplayType(result.memory),
          accessType: 'find' as const,
          sessionId: ctx.sessionId,
          requestId,
          queryText: query,
          resultRank: index + 1,
          similarityScore: result.similarity,
        }));
        await recordAccessBatch(ctx.env.DB, accessEvents);
      }

      return textResult(formatFindResults(results.map(r => ({
        memory: { id: r.memory.id, content: r.memory.content, state: r.memory.state },
        similarity: r.similarity,
        confidence: r.confidence,
        surprise: r.surprise,
      })), query));
    },
  }),

  defineTool({
    name: 'recall',
    description: 'Get a memory by ID. Returns the content, confidence stats (times_tested, confirmations), state (active/violated/confirmed), and derivation edges. Use to inspect a specific memory before building on it.',
    annotations: {
      title: 'Get Memory',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to recall' },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const { memory_id, id } = args as { memory_id?: string; id?: string };
      const resolvedId = memory_id || id;

      if (!resolvedId) {
        return errorResult('memory_id is required');
      }

      const recalled = await recallMemory(ctx.env.DB, resolvedId);
      if (!recalled) {
        return errorResult(`Memory not found: ${resolvedId}`);
      }
      const row = recalled.row;

      const edges = recalled.edges
        .filter((edge) => edge.source_id === resolvedId)
        .map((edge) => ({ target_id: edge.target_id, strength: edge.strength }));

      return textResult(formatRecall(row, edges));
    },
  }),

  defineTool({
    name: 'stats',
    description: 'Get memory statistics (counts by field presence, edge count, etc.).',
    annotations: {
      title: 'Memory Statistics',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, ctx) => {
      const summary = await getStatsSummary(ctx.env.DB);
      const obs = summary.memories.observation;
      const thoughts = summary.memories.thought;
      const predictions = summary.memories.prediction;
      const total = summary.memories.total;
      const edges = summary.edges;

      return textResult(`📊 Memory Stats\nTotal: ${total} (${obs} sourced, ${thoughts} derived, ${predictions} time-bound)\nConnections: ${edges}`);
    },
  }),

  defineTool({
    name: 'pending',
    description: 'List time-bound memories past their resolves_by deadline awaiting resolution. These need review to mark as confirmed or violated.',
    annotations: {
      title: 'Pending Time-Bound Memories',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        overdue: { type: 'boolean', description: 'Only show overdue time-bound memories (default: false shows all pending)' },
        limit: { type: 'integer', description: 'Max results (default: 20)' },
        offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)' },
      },
    },
    handler: async (args, ctx) => {
      const { overdue, limit, offset } = args as { overdue?: boolean; limit?: number; offset?: number };
      const now = Math.floor(Date.now() / 1000);
      const resultLimit = limit || 20;
      const resultOffset = offset || 0;

      // Predictions are memories with resolves_by set (uses field presence)
      let whereClause = `
        WHERE state = 'active'
        AND retracted = 0
        AND resolves_by IS NOT NULL
      `;

      if (overdue) {
        whereClause += ` AND resolves_by < ${now}`;
      }

      const countResult = await ctx.env.DB.prepare(
        `SELECT COUNT(*) as count FROM memories ${whereClause}`
      ).first<{ count: number }>();
      const total = countResult?.count || 0;

      const results = await ctx.env.DB.prepare(
        `SELECT * FROM memories ${whereClause} ORDER BY created_at DESC LIMIT ${resultLimit} OFFSET ${resultOffset}`
      ).all<MemoryRow>();

      return textResult(formatPending((results.results || []).map(row => ({
        id: row.id,
        content: row.content,
        resolves_by: row.resolves_by ?? undefined,
      })), total, resultLimit, resultOffset));
    },
  }),

  defineTool({
    name: 'insights',
    description: 'Analyze knowledge graph health. Views: hubs (most-connected memories), orphans (unconnected - no derivation links), untested (low times_tested - dangerous if confident), failing (have violations from contradicting memories), recent (latest memories).',
    annotations: {
      title: 'Graph Insights',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['hubs', 'orphans', 'untested', 'failing', 'recent'],
          description: 'Type of insight view (default: recent)'
        },
        limit: { type: 'integer', description: 'Max results (default: 20)' },
        offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)' },
      },
    },
    handler: async (args, ctx) => {
      const { view, limit, offset } = args as { view?: string; limit?: number; offset?: number };
      const resultLimit = limit || 20;
      const resultOffset = offset || 0;

      let query = '';
      let countQuery = '';
      switch (view) {
        case 'hubs':
          query = `
            SELECT m.*, COUNT(e.target_id) as connection_count
            FROM memories m
            LEFT JOIN edges e ON m.id = e.source_id
            WHERE m.retracted = 0
            GROUP BY m.id
            ORDER BY connection_count DESC
            LIMIT ${resultLimit} OFFSET ${resultOffset}
          `;
          countQuery = `SELECT COUNT(*) as count FROM memories WHERE retracted = 0`;
          break;
        case 'orphans':
          query = `
            SELECT m.*
            FROM memories m
            LEFT JOIN edges e ON m.id = e.source_id OR m.id = e.target_id
            WHERE m.retracted = 0 AND e.source_id IS NULL
            ORDER BY m.created_at DESC
            LIMIT ${resultLimit} OFFSET ${resultOffset}
          `;
          countQuery = `
            SELECT COUNT(*) as count
            FROM memories m
            LEFT JOIN edges e ON m.id = e.source_id OR m.id = e.target_id
            WHERE m.retracted = 0 AND e.source_id IS NULL
          `;
          break;
        case 'untested':
          query = `
            SELECT * FROM memories
            WHERE retracted = 0 AND times_tested < 3
            ORDER BY created_at DESC
            LIMIT ${resultLimit} OFFSET ${resultOffset}
          `;
          countQuery = `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND times_tested < 3`;
          break;
        case 'failing':
          query = `
            SELECT * FROM memories
            WHERE retracted = 0 AND json_array_length(violations) > 0
            ORDER BY created_at DESC
            LIMIT ${resultLimit} OFFSET ${resultOffset}
          `;
          countQuery = `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND json_array_length(violations) > 0`;
          break;
        case 'recent':
        default:
          query = `
            SELECT * FROM memories
            WHERE retracted = 0
            ORDER BY created_at DESC
            LIMIT ${resultLimit} OFFSET ${resultOffset}
          `;
          countQuery = `SELECT COUNT(*) as count FROM memories WHERE retracted = 0`;
      }

      const [results, countResult] = await Promise.all([
        ctx.env.DB.prepare(query).all<MemoryRow>(),
        ctx.env.DB.prepare(countQuery).first<{ count: number }>(),
      ]);
      const total = countResult?.count || 0;

      return textResult(formatInsights(view || 'recent', results.results || [], total, resultLimit, resultOffset));
    },
  }),

  // ----------------------------------------
  // Graph Traversal - Navigate derivation chain
  // ----------------------------------------

  defineTool({
    name: 'reference',
    description: 'Follow the derivation graph from a memory. Returns memories connected by derivation edges - what this memory derives from (ancestors via direction=up) or what derives from it (descendants via direction=down). Use to trace reasoning chains and understand thought dependencies.',
    annotations: {
      title: 'Follow Derivation Graph',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to traverse from' },
        direction: { type: 'string', enum: ['up', 'down', 'both'], description: 'Traverse direction: up (ancestors), down (descendants), both (default: both)' },
        depth: { type: 'integer', description: 'Max traversal depth (default: 2)', minimum: 1, maximum: 10 },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const { memory_id: rawMemId, id: rawId2, direction = 'both', depth: maxDepth = 2 } = args as {
        memory_id?: string;
        id?: string;
        direction?: 'up' | 'down' | 'both';
        depth?: number;
      };
      const memory_id = rawMemId || rawId2;
      if (!memory_id) {
        return errorResult('memory_id is required');
      }

      interface GraphNode {
        id: string;
        type: string;
        content: string;
        depth: number;
      }

      interface GraphEdge {
        source: string;
        target: string;
        type: string;
        strength: number;
      }

      const nodes: Map<string, GraphNode> = new Map();
      const edges: GraphEdge[] = [];
      const visited = new Set<string>([memory_id]);
      const edgeSeen = new Set<string>();

      // Get root memory
      const rootRow = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ?`
      ).bind(memory_id).first<MemoryRow>();

      if (!rootRow) {
        return errorResult(`Memory not found: ${memory_id}`);
      }

      const rootMemory = rowToMemory(rootRow);
      nodes.set(memory_id, {
        id: memory_id,
        type: getDisplayType(rootMemory),
        content: rootMemory.content,
        depth: 0,
      });

      let frontier = [memory_id];
      let depth = 0;

      while (frontier.length > 0 && depth < maxDepth) {
        const [incoming, outgoing] = await Promise.all([
          (direction === 'up' || direction === 'both')
            ? fetchEdgesByTargetIds<EdgeRow>(ctx.env.DB, frontier)
            : Promise.resolve([] as EdgeRow[]),
          (direction === 'down' || direction === 'both')
            ? fetchEdgesBySourceIds<EdgeRow>(ctx.env.DB, frontier)
            : Promise.resolve([] as EdgeRow[]),
        ]);

        const nextIds: string[] = [];

        for (const row of incoming) {
          const edgeKey = `${row.source_id}:${row.target_id}:${row.edge_type}`;
          if (!edgeSeen.has(edgeKey)) {
            edgeSeen.add(edgeKey);
            edges.push({
              source: row.source_id,
              target: row.target_id,
              type: row.edge_type,
              strength: row.strength,
            });
          }
          if (!visited.has(row.source_id)) nextIds.push(row.source_id);
        }

        for (const row of outgoing) {
          const edgeKey = `${row.source_id}:${row.target_id}:${row.edge_type}`;
          if (!edgeSeen.has(edgeKey)) {
            edgeSeen.add(edgeKey);
            edges.push({
              source: row.source_id,
              target: row.target_id,
              type: row.edge_type,
              strength: row.strength,
            });
          }
          if (!visited.has(row.target_id)) nextIds.push(row.target_id);
        }

        const uniqueNextIds = [...new Set(nextIds)];
        if (uniqueNextIds.length === 0) break;

        const nextRows = await fetchMemoriesByIds<MemoryRow>(ctx.env.DB, uniqueNextIds, {
          includeRetracted: false,
        });
        for (const row of nextRows) {
          if (!nodes.has(row.id)) {
            const nextMemory = rowToMemory(row);
            nodes.set(row.id, {
              id: row.id,
              type: getDisplayType(nextMemory),
              content: nextMemory.content,
              depth: depth + 1,
            });
          }
        }

        for (const nextId of uniqueNextIds) visited.add(nextId);
        frontier = uniqueNextIds;
        depth += 1;
      }

      const nodeList = Array.from(nodes.values());
      if (nodeList.length === 0) {
        return textResult(`[${memory_id}] has no ${direction === 'up' ? 'ancestors' : direction === 'down' ? 'descendants' : 'connections'}`);
      }

      const lines = nodeList.map(n => `[${n.id}] ${n.content}`);
      const edgeLines = edges.map(e => `  ${e.source} → ${e.target}`);

      let text = `=== ${direction.toUpperCase()} from [${memory_id}] ===\n\n`;
      text += lines.join('\n') + '\n\n';
      text += `Edges:\n${edgeLines.join('\n')}`;

      return textResult(text);
    },
  }),

  defineTool({
    name: 'roots',
    description: 'Trace a memory back to its root perceptions. Walks the derivation chain to find the original source memories this belief is based on. Use to audit reasoning - every derived memory should trace back to direct perceptions.',
    annotations: {
      title: 'Trace Roots',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to trace roots for' },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const { memory_id: rawMemId3, id: rawId3 } = args as { memory_id?: string; id?: string };
      const memory_id = rawMemId3 || rawId3;
      if (!memory_id) {
        return errorResult('memory_id is required');
      }

      // Get the memory
      const row = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ?`
      ).bind(memory_id).first<MemoryRow>();

      if (!row) {
        return errorResult(`Memory not found: ${memory_id}`);
      }

      const memory = rowToMemory(row);

      // If memory has no derivation chain, it's already a root
      if (!memory.derived_from || memory.derived_from.length === 0) {
        return textResult(`[${memory_id}] is already a root (no derived_from)\n\n${memory.content}`);
      }

      const visited = new Set<string>([memory_id]);
      const nodeDepth = new Map<string, number>([[memory_id, 0]]);
      const rootIds = new Set<string>();
      let frontier = [memory_id];

      while (frontier.length > 0) {
        const derivedFrom = await fetchEdgesByTargetIds<EdgeRow>(ctx.env.DB, frontier, ['derived_from']);
        const parentMap = new Map<string, string[]>();

        for (const edge of derivedFrom) {
          const parents = parentMap.get(edge.target_id) || [];
          parents.push(edge.source_id);
          parentMap.set(edge.target_id, parents);
        }

        const nextFrontier: string[] = [];
        for (const childId of frontier) {
          const parents = parentMap.get(childId) || [];
          if (parents.length === 0) {
            rootIds.add(childId);
            continue;
          }

          const childDepth = nodeDepth.get(childId) || 0;
          for (const parentId of parents) {
            if (visited.has(parentId)) continue;
            visited.add(parentId);
            nodeDepth.set(parentId, childDepth + 1);
            nextFrontier.push(parentId);
          }
        }

        frontier = nextFrontier;
      }

      if (rootIds.size === 0) {
        return textResult(`[${memory_id}] has no traceable roots (orphan memory)`);
      }

      const rootRows = await fetchMemoriesByIds<MemoryRow>(ctx.env.DB, [...rootIds], {
        includeRetracted: false,
      });
      const roots = rootRows.map((rootRow) => ({
        id: rootRow.id,
        content: rootRow.content,
        type: getDisplayType(rowToMemory(rootRow)),
      }));
      const maxDepth = roots.reduce((acc, rootNode) => Math.max(acc, nodeDepth.get(rootNode.id) || 0), 0);

      const rootLines = roots.map(r => `[${r.id}] (${r.type}) ${r.content}`);
      let text = `=== ROOTS of [${memory_id}] (depth: ${maxDepth}) ===\n\n`;
      text += `Source: ${memory.content.substring(0, 100)}...\n\n`;
      text += `Grounded in ${roots.length} root(s):\n\n`;
      text += rootLines.join('\n');

      return textResult(text);
    },
  }),

  defineTool({
    name: 'zones',
    description: 'Return a locally consistent reasoning zone: a mutually non-contradictory cluster of memories around a seed, plus boundary contradictions and external support dependency. Use this when you need a coherent set of facts/thoughts to reason over without internal violated_by conflicts.',
    annotations: {
      title: 'Reasoning Zones',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic seed query (optional)' },
        memory_id: { type: 'string', description: 'Direct seed memory ID (optional)' },
        max_depth: { type: 'integer', description: 'Graph traversal depth (default: 3)', minimum: 1, maximum: 5 },
        max_size: { type: 'integer', description: 'Max zone members (default: 30)', minimum: 5, maximum: 100 },
        include_semantic: { type: 'boolean', description: 'Supplement with semantic search if zone is small (default: true)' },
        min_edge_strength: { type: 'number', description: 'Minimum edge strength to traverse (default: 0.3, range 0-1). Edges weakened by violations below this threshold are skipped.', minimum: 0, maximum: 1 },
      },
    },
    handler: async (args, ctx) => {
      const {
        query,
        memory_id: rawMemoryId,
        max_depth,
        max_size,
        include_semantic,
        min_edge_strength,
      } = args as {
        query?: string;
        memory_id?: string;
        max_depth?: number;
        max_size?: number;
        include_semantic?: boolean;
        min_edge_strength?: number;
      };

      const maxDepth = max_depth ?? 3;
      const maxSize = max_size ?? 30;
      const includeSemantic = include_semantic ?? true;
      const minEdgeStrength = min_edge_strength ?? 0.3;

      if (!query && !rawMemoryId) {
        return errorResult('At least one of "query" or "memory_id" is required');
      }
      if (maxDepth < 1 || maxDepth > 5) {
        return errorResult('max_depth must be between 1 and 5');
      }
      if (maxSize < 5 || maxSize > 100) {
        return errorResult('max_size must be between 5 and 100');
      }

      // SafetyRow, parseViolationCount, isOverwhelminglyViolated, addBoundaryReason
      // imported from ../lib/zones.js

      // --------------------------
      // Phase 1: Seed selection
      // --------------------------
      let seedId: string | null = null;
      let seedRow: MemoryRow | null = null;

      if (rawMemoryId) {
        seedId = rawMemoryId;
        seedRow = await ctx.env.DB.prepare(
          `SELECT * FROM memories WHERE id = ? AND retracted = 0`
        ).bind(seedId).first<MemoryRow>();
        if (!seedRow) return errorResult(`Memory not found: ${seedId}`);
      } else if (query) {
        const queryEmbedding = await generateEmbedding(ctx.env.AI, query, config, requestId);
        const matches = await searchSimilar(ctx.env, queryEmbedding, 10, config.search.minSimilarity, requestId);

        for (const match of matches) {
          const row = await ctx.env.DB.prepare(
            `SELECT * FROM memories WHERE id = ? AND retracted = 0`
          ).bind(match.id).first<MemoryRow>();
          if (row) {
            seedId = match.id;
            seedRow = row;
            break;
          }
        }

        if (!seedId || !seedRow) {
          return errorResult('No seed found for query (no non-retracted matches)');
        }
      }

      if (!seedId || !seedRow) {
        return errorResult('Failed to resolve seed');
      }

      // --------------------------
      // Phase 1.5: Seed safety eval (using already-fetched seedRow)
      // --------------------------
      const unsafeReasons: string[] = [];
      if (seedRow.state === 'violated') unsafeReasons.push('seed state=violated');
      // outcome column exists in DB but not in MemoryRow type — SELECT * returns it
      const seedOutcome = (seedRow as unknown as Record<string, unknown>).outcome as string | null;
      if (seedRow.state === 'resolved' && seedOutcome === 'incorrect') unsafeReasons.push('seed resolved incorrect');
      if (parseViolationCount(seedRow.violations) > 0) unsafeReasons.push('seed has recorded violations');

      // --------------------------
      // Phase 2: BFS growth (graph)
      // --------------------------
      const zoneIds: string[] = [seedId];
      const zoneSet = new Set<string>(zoneIds);
      const seen = new Set<string>(zoneIds);
      const semanticMemberIds = new Set<string>();
      const boundaryReasons = new Map<string, Set<string>>();

      type TraversalEdgeRow = { source_id: string; target_id: string; edge_type: string; strength: number };
      type ViolatedByEdgeRow = { source_id: string; target_id: string };

      let frontier: string[] = [seedId];
      for (let depth = 0; depth < maxDepth; depth++) {
        if (zoneIds.length >= maxSize) break;
        if (frontier.length === 0) break;

        const frontierSet = new Set(frontier);
        const edgeResults = await queryInChunks<TraversalEdgeRow>(
          ctx.env.DB,
          (ph) => `SELECT source_id, target_id, edge_type, strength
           FROM edges
           WHERE edge_type IN ('derived_from', 'confirmed_by')
             AND strength >= ?
             AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
          frontier,
          [minEdgeStrength],
          [],
          2,
        );
        const edges = { results: edgeResults };

        const candidates: string[] = [];
        const candidateSet = new Set<string>();
        for (const e of edges.results ?? []) {
          if (frontierSet.has(e.source_id) && !seen.has(e.target_id) && !candidateSet.has(e.target_id)) {
            candidates.push(e.target_id);
            candidateSet.add(e.target_id);
          }
          if (frontierSet.has(e.target_id) && !seen.has(e.source_id) && !candidateSet.has(e.source_id)) {
            candidates.push(e.source_id);
            candidateSet.add(e.source_id);
          }
        }

        if (candidates.length === 0) {
          frontier = [];
          continue;
        }

        // Mark all as seen to avoid re-processing across depths.
        for (const id of candidates) seen.add(id);

        const safetyResults = await queryInChunks<SafetyRow>(
          ctx.env.DB,
          (ph) => `SELECT id, state, outcome, retracted, violations, times_tested, confirmations FROM memories WHERE id IN (${ph})`,
          candidates,
          [],
          [],
          1,
        );

        const safetyById = new Map<string, SafetyRow>();
        for (const r of safetyResults) safetyById.set(r.id, r);

        const eligible: string[] = [];
        for (const id of candidates) {
          const r = safetyById.get(id);
          if (!r) continue;
          if (r.retracted) continue;

          if (r.state === 'violated') {
            addBoundaryReason(boundaryReasons, id, 'excluded: state=violated');
            continue;
          }
          if (r.state === 'resolved' && r.outcome === 'incorrect') {
            addBoundaryReason(boundaryReasons, id, 'excluded: resolved incorrect');
            continue;
          }
          if (isOverwhelminglyViolated(r)) {
            const surv = r.times_tested > 0 ? Math.round(r.confirmations / r.times_tested * 100) : 0;
            addBoundaryReason(boundaryReasons, id, `excluded: survival rate ${surv}% (${r.confirmations}/${r.times_tested})`);
            continue;
          }
          eligible.push(id);
        }

        // Contradiction gate against current zone
        const newlyAdded: string[] = [];
        if (eligible.length > 0 && zoneIds.length < maxSize) {
          const candSet2 = new Set<string>(eligible);

          const contradictionResults = await queryContradictionGate<ViolatedByEdgeRow>(
            ctx.env.DB,
            eligible,
            zoneIds,
          );

          const conflicts = new Map<string, Set<string>>();
          for (const e of contradictionResults) {
            if (candSet2.has(e.source_id) && zoneSet.has(e.target_id)) {
              (conflicts.get(e.source_id) ?? conflicts.set(e.source_id, new Set()).get(e.source_id)!).add(e.target_id);
            } else if (candSet2.has(e.target_id) && zoneSet.has(e.source_id)) {
              (conflicts.get(e.target_id) ?? conflicts.set(e.target_id, new Set()).get(e.target_id)!).add(e.source_id);
            }
          }

          for (const id of eligible) {
            if (zoneIds.length >= maxSize) break;
            const conflictWith = conflicts.get(id);
            if (conflictWith && conflictWith.size > 0) {
              for (const zid of conflictWith) {
                addBoundaryReason(boundaryReasons, id, `contradicts [${zid}] (violated_by)`);
              }
              continue;
            }

            zoneIds.push(id);
            zoneSet.add(id);
            newlyAdded.push(id);
          }
        }

        frontier = newlyAdded;
      }

      // --------------------------
      // Phase 3: Semantic expansion (optional)
      // --------------------------
      if (includeSemantic && query && zoneIds.length < 5 && zoneIds.length < maxSize) {
        const queryEmbedding = await generateEmbedding(ctx.env.AI, query, config, requestId);
        const matches = await searchSimilar(ctx.env, queryEmbedding, 25, config.search.minSimilarity, requestId);

        const candidates: string[] = [];
        for (const m of matches) {
          if (zoneSet.has(m.id) || seen.has(m.id)) continue;
          candidates.push(m.id);
        }

        if (candidates.length > 0) {
          for (const id of candidates) seen.add(id);

          const safetyResults2 = await queryInChunks<SafetyRow>(
            ctx.env.DB,
            (ph) => `SELECT id, state, outcome, retracted, violations, times_tested, confirmations FROM memories WHERE id IN (${ph})`,
            candidates,
            [],
            [],
            1,
          );

          const safetyById = new Map<string, SafetyRow>();
          for (const r of safetyResults2) safetyById.set(r.id, r);

          const eligible: string[] = [];
          for (const id of candidates) {
            const r = safetyById.get(id);
            if (!r) continue;
            if (r.retracted) continue;

            if (r.state === 'violated') {
              addBoundaryReason(boundaryReasons, id, 'excluded: state=violated');
              continue;
            }
            if (r.state === 'resolved' && r.outcome === 'incorrect') {
              addBoundaryReason(boundaryReasons, id, 'excluded: resolved incorrect');
              continue;
            }
            if (isOverwhelminglyViolated(r)) {
              const surv = r.times_tested > 0 ? Math.round(r.confirmations / r.times_tested * 100) : 0;
              addBoundaryReason(boundaryReasons, id, `excluded: survival rate ${surv}% (${r.confirmations}/${r.times_tested})`);
              continue;
            }
            eligible.push(id);
          }

          if (eligible.length > 0 && zoneIds.length < maxSize) {
            const candSet2 = new Set<string>(eligible);

            const contradictionResults2 = await queryContradictionGate<ViolatedByEdgeRow>(
              ctx.env.DB,
              eligible,
              zoneIds,
            );

            const conflicts = new Map<string, Set<string>>();
            for (const e of contradictionResults2) {
              if (candSet2.has(e.source_id) && zoneSet.has(e.target_id)) {
                (conflicts.get(e.source_id) ?? conflicts.set(e.source_id, new Set()).get(e.source_id)!).add(e.target_id);
              } else if (candSet2.has(e.target_id) && zoneSet.has(e.source_id)) {
                (conflicts.get(e.target_id) ?? conflicts.set(e.target_id, new Set()).get(e.target_id)!).add(e.source_id);
              }
            }

            for (const id of eligible) {
              if (zoneIds.length >= maxSize) break;
              const conflictWith = conflicts.get(id);
              if (conflictWith && conflictWith.size > 0) {
                for (const zid of conflictWith) {
                  addBoundaryReason(boundaryReasons, id, `contradicts [${zid}] (violated_by)`);
                }
                continue;
              }

              zoneIds.push(id);
              zoneSet.add(id);
              semanticMemberIds.add(id);
            }
          }
        }
      }

      // --------------------------
      // Boundary completion (cut-)
      // --------------------------
      const violatedEdgeResults = await queryInChunks<ViolatedByEdgeRow>(
        ctx.env.DB,
        (ph) => `SELECT source_id, target_id
         FROM edges
         WHERE edge_type = 'violated_by'
           AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
        zoneIds,
        [],
        [],
        2,
      );

      const cutMinusEdges: Array<{ source_id: string; target_id: string; edge_type: 'violated_by' }> = [];
      const internalContradictions: Array<{ source_id: string; target_id: string }> = [];
      for (const e of violatedEdgeResults) {
        const sourceIn = zoneSet.has(e.source_id);
        const targetIn = zoneSet.has(e.target_id);
        if (sourceIn && targetIn) {
          internalContradictions.push({ source_id: e.source_id, target_id: e.target_id });
          continue;
        }
        if (sourceIn !== targetIn) {
          cutMinusEdges.push({ source_id: e.source_id, target_id: e.target_id, edge_type: 'violated_by' });
        }

        const other = sourceIn ? e.target_id : e.source_id;
        const inZone = sourceIn ? e.source_id : e.target_id;
        if (!zoneSet.has(other)) {
          addBoundaryReason(boundaryReasons, other, `contradicts [${inZone}] (violated_by)`);
        }
      }

      // --------------------------
      // External support dependency (loss+)
      // --------------------------
      const traversalEdgeResults = await queryInChunks<TraversalEdgeRow>(
        ctx.env.DB,
        (ph) => `SELECT source_id, target_id, edge_type, strength
         FROM edges
         WHERE edge_type IN ('derived_from', 'confirmed_by')
           AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
        zoneIds,
        [],
        [],
        2,
      );

      const internalEdges: Array<{ source_id: string; target_id: string; edge_type: string; strength: number }> = [];
      const lossPlusEdges: Array<{ source_id: string; target_id: string; edge_type: 'derived_from' | 'confirmed_by' }> = [];
      const internalKey = new Set<string>();
      for (const e of traversalEdgeResults) {
        const sourceIn = zoneSet.has(e.source_id);
        const targetIn = zoneSet.has(e.target_id);
        if (sourceIn && targetIn) {
          const key = `${e.source_id}|${e.target_id}|${e.edge_type}`;
          if (!internalKey.has(key)) {
            internalKey.add(key);
            internalEdges.push({ source_id: e.source_id, target_id: e.target_id, edge_type: e.edge_type, strength: e.strength });
          }
        } else if (sourceIn !== targetIn) {
          lossPlusEdges.push({
            source_id: e.source_id,
            target_id: e.target_id,
            edge_type: e.edge_type as 'derived_from' | 'confirmed_by',
          });
        }
      }

      // --------------------------
      // Signed cycle detection (Harary 2-coloring, Proposition 1)
      // --------------------------
      if (internalContradictions.length > 0) {
        const balance = checkSignedBalance(internalEdges, internalContradictions);
        if (!balance.balanced) {
          unsafeReasons.push(balance.conflictDescription ?? 'signed cycle detected (Harary 2-coloring failed)');
        }
        // Add internal contradictions to edge display
        for (const e of internalContradictions) {
          internalEdges.push({ source_id: e.source_id, target_id: e.target_id, edge_type: 'violated_by', strength: 1.0 });
        }
      }

      // --------------------------
      // Fetch full rows for output
      // --------------------------
      const boundaryIds = Array.from(boundaryReasons.keys()).filter(id => !zoneSet.has(id));
      const idsToFetch = Array.from(new Set([...zoneIds, ...boundaryIds]));

      const memById = new Map<string, MemoryRow>();
      if (idsToFetch.length > 0) {
        const fetchedRows = await queryInChunks<MemoryRow>(
          ctx.env.DB,
          (ph) => `SELECT * FROM memories WHERE id IN (${ph}) AND retracted = 0`,
          idsToFetch,
          [],
          [],
          1,
        );
        for (const r of fetchedRows) memById.set(r.id, r);
      }

      const zoneMembers: Memory[] = [];
      for (const id of zoneIds) {
        const row = memById.get(id);
        if (!row) continue;
        zoneMembers.push(rowToMemory(row));
      }

      const boundary: Array<{ memory: Memory; reasons: string[] }> = [];
      for (const [id, reasons] of boundaryReasons.entries()) {
        if (zoneSet.has(id)) continue;
        const row = memById.get(id);
        if (!row) continue; // retracted or missing
        boundary.push({ memory: rowToMemory(row), reasons: Array.from(reasons) });
      }

      // --------------------------
      // Record access events
      // --------------------------
      const accessEvents: RecordAccessParams[] = [];
      let rank = 1;
      for (const m of zoneMembers) {
        accessEvents.push({
          entityId: m.id,
          entityType: getDisplayType(m),
          accessType: 'reference' as const,
          sessionId: ctx.sessionId,
          requestId,
          queryText: query,
          queryParams: { tool: 'zones', seedId, maxDepth, maxSize, includeSemantic: includeSemantic },
          resultRank: rank++,
        });
      }
      for (const b of boundary) {
        accessEvents.push({
          entityId: b.memory.id,
          entityType: getDisplayType(b.memory),
          accessType: 'reference' as const,
          sessionId: ctx.sessionId,
          requestId,
          queryText: query,
          queryParams: { tool: 'zones', seedId, maxDepth, maxSize, includeSemantic: includeSemantic },
          resultRank: rank++,
        });
      }
      if (accessEvents.length > 0) {
        await recordAccessBatch(ctx.env.DB, accessEvents);
      }

      return textResult(formatZone({
        seedId,
        query,
        zoneMembers,
        semanticMemberIds,
        internalEdges,
        boundary,
        cutMinusEdges,
        lossPlusEdges,
        unsafeReasons,
      }));
    },
  }),

  defineTool({
    name: 'between',
    description: 'Find memories that bridge two given memories. Discovers conceptual connections you might not have noticed. Use when you have two related thoughts and want to understand what links them.',
    annotations: {
      title: 'Find Bridges',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        memory_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of memories to find bridges between (minimum 2)' },
        limit: { type: 'integer', description: 'Max bridges to return (default: 5)', minimum: 1, maximum: 20 },
      },
      required: ['memory_ids'],
    },
    handler: async (args, ctx) => {
      const { memory_ids, limit = 5 } = args as { memory_ids: string[]; limit?: number };

      if (!memory_ids || memory_ids.length < 2) {
        return errorResult('At least 2 memory IDs are required');
      }

      // Fetch content for all input memories
      const contents: Array<{ id: string; content: string }> = [];

      for (const id of memory_ids) {
        const row = await ctx.env.DB.prepare(
          `SELECT content FROM memories WHERE id = ? AND retracted = 0`
        ).bind(id).first<{ content: string }>();

        if (!row) {
          return errorResult(`Memory not found: ${id}`);
        }

        contents.push({ id, content: row.content });
      }

      // Generate embeddings and compute centroid
      const embeddings: number[][] = [];
      for (const item of contents) {
        const embedding = await generateEmbedding(ctx.env.AI, item.content, config, requestId);
        embeddings.push(embedding);
      }

      // Compute centroid
      const dimensions = embeddings[0].length;
      const centroid = new Array(dimensions).fill(0);
      for (const emb of embeddings) {
        for (let i = 0; i < dimensions; i++) {
          centroid[i] += emb[i];
        }
      }
      for (let i = 0; i < dimensions; i++) {
        centroid[i] /= embeddings.length;
      }

      // Search for memories near centroid
      const searchResults = await searchSimilar(
        ctx.env,
        centroid,
        limit * 3 + memory_ids.length,
        0.3,
        requestId
      );

      // Filter out input memories and fetch details
      const inputIdSet = new Set(memory_ids);
      const bridges: Array<{
        id: string;
        type: string;
        content: string;
        relevanceScore: number;
      }> = [];

      for (const match of searchResults) {
        if (bridges.length >= limit) break;
        if (inputIdSet.has(match.id)) continue;

        const row = await ctx.env.DB.prepare(
          `SELECT * FROM memories WHERE id = ? AND retracted = 0`
        ).bind(match.id).first<MemoryRow>();

        if (!row) continue;

        const memory = rowToMemory(row);
        bridges.push({
          id: match.id,
          type: getDisplayType(memory),
          content: row.content,
          relevanceScore: match.similarity,
        });
      }

      if (bridges.length === 0) {
        return textResult(`No bridges found between ${memory_ids.map(id => `[${id}]`).join(' and ')}`);
      }

      const lines = bridges.map((b, i) => `${i + 1}. [${b.id}] ${b.content}\n   relevance: ${Math.round(b.relevanceScore * 100)}%`);
      return textResult(`=== BRIDGES between ${memory_ids.map(id => `[${id}]`).join(' & ')} ===\n\n${lines.join('\n\n')}`);
    },
  }),

  // ============================================
  // System Stats Tool
  // ============================================

  defineTool({
    name: 'refresh_stats',
    description: 'Manually trigger system statistics recomputation. Updates max_times_tested, median_times_tested, and per-source learned_confidence values. Normally runs daily via cron, use this to force an immediate refresh.',
    annotations: {
      title: 'Refresh Statistics',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        summary_only: { type: 'boolean', description: 'If true, only return current stats without recomputing (default: false)' },
      },
      required: [],
    },
    handler: async (args, ctx) => {
      const { summary_only = false } = args as { summary_only?: boolean };

      if (summary_only) {
        // Just return current stats
        const summary = await getSystemStatsSummary(ctx.env.DB);
        const lastUpdated = summary.last_updated
          ? new Date(summary.last_updated).toISOString()
          : 'never';

        let text = `System Stats Summary (last updated: ${lastUpdated})\n\n`;
        text += `max_times_tested: ${summary.max_times_tested ?? 'not computed'}\n`;
        text += `median_times_tested: ${summary.median_times_tested ?? 'not computed'}\n`;

        if (Object.keys(summary.source_track_records).length > 0) {
          text += `\nSource Track Records:\n`;
          for (const [source, confidence] of Object.entries(summary.source_track_records)) {
            text += `  ${source}: ${Math.round(confidence * 100)}%\n`;
          }
        } else {
          text += `\nNo source track records yet (need 5+ tested memories per source)`;
        }

        return textResult(text);
      }

      // Compute fresh stats
      const result = await computeSystemStats(ctx.env, requestId);

      let text = `✓ Stats recomputed successfully\n\n`;
      text += `max_times_tested: ${result.maxTimesTested}\n`;
      text += `median_times_tested: ${result.medianTimesTested}\n`;
      text += `total_memories: ${result.totalMemories}\n`;

      if (Object.keys(result.sourceTrackRecords).length > 0) {
        text += `\nSource Track Records Updated:\n`;
        for (const [source, confidence] of Object.entries(result.sourceTrackRecords)) {
          text += `  ${source}: ${Math.round(confidence * 100)}%\n`;
        }
      } else {
        text += `\nNo source track records computed (need 5+ tested memories per source)`;
      }

      return textResult(text);
    },
  }),

  defineTool({
    name: 'resolve',
    description: 'Resolve any memory as correct, incorrect, superseded, or voided. Use when information is proven wrong (incorrect), outdated by newer data (superseded), confirmed accurate (correct), or no longer relevant (voided). Sets state to "resolved" with the given outcome, cleans up condition vectors, triggers cascade propagation to related memories, and records an audit trail. For superseded: pass replaced_by with the ID of the newer memory to create a supersedes edge. Pass force=true to re-resolve an already-resolved memory.',
    annotations: {
      title: 'Resolve Memory',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to resolve' },
        outcome: {
          type: 'string',
          enum: ['correct', 'incorrect', 'voided', 'superseded'],
          description: 'Resolution outcome: correct (confirmed true), incorrect (proven wrong), superseded (was accurate but outdated now), voided (no longer relevant/testable)',
        },
        reason: { type: 'string', description: 'Explanation for why this outcome was chosen (audit trail)' },
        replaced_by: { type: 'string', description: 'ID of the newer memory that replaces this one (creates a supersedes edge). Recommended when outcome is "superseded".' },
        force: { type: 'boolean', description: 'Allow re-resolution of already-resolved memories (default: false)' },
      },
      required: ['memory_id', 'outcome', 'reason'],
    },
    handler: async (args, ctx) => {
      const { memory_id, outcome, reason, replaced_by, force = false } = args as {
        memory_id: string;
        outcome: 'correct' | 'incorrect' | 'voided' | 'superseded';
        reason: string;
        replaced_by?: string;
        force?: boolean;
      };

      if (!memory_id) return errorResult('memory_id is required');
      if (!outcome) return errorResult('outcome is required');
      if (!reason) return errorResult('reason is required');

      // Validate replaced_by if provided
      if (replaced_by) {
        if (replaced_by === memory_id) {
          return errorResult('replaced_by cannot be the same as memory_id');
        }
        const replacementRow = await ctx.env.DB.prepare(
          'SELECT id, retracted FROM memories WHERE id = ?'
        ).bind(replaced_by).first<{ id: string; retracted: number }>();
        if (!replacementRow) return errorResult(`Replacement memory not found: ${replaced_by}`);
        if (replacementRow.retracted) return errorResult(`Replacement memory is retracted: ${replaced_by}`);
      }

      // Fetch memory
      const row = await ctx.env.DB.prepare(
        'SELECT id, content, state, outcome, source, retracted, resolves_by, derived_from FROM memories WHERE id = ?'
      ).bind(memory_id).first<{ id: string; content: string; state: string; outcome: string | null; source: string | null; retracted: number; resolves_by: number | null; derived_from: string | null }>();

      if (!row) return errorResult(`Memory not found: ${memory_id}`);
      if (row.retracted) return errorResult(`Memory is retracted: ${memory_id}`);
      if (row.state === 'resolved' && !force) return errorResult(`Memory is already resolved (outcome: ${row.outcome}). Pass force=true to re-resolve.`);

      const oldState = row.state;
      const oldOutcome = row.outcome;
      const now = Date.now();

      // Update state
      await ctx.env.DB.prepare(
        `UPDATE memories SET state = 'resolved', outcome = ?, resolved_at = ?, updated_at = ? WHERE id = ?`
      ).bind(outcome, now, now, memory_id).run();

      // Create supersedes edge if replaced_by provided
      let supersededText = '';
      if (replaced_by) {
        const edgeId = generateId();
        await ctx.env.DB.prepare(
          `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
           VALUES (?, ?, ?, 'supersedes', 1.0, ?)`
        ).bind(edgeId, memory_id, replaced_by, now).run();
        supersededText = `\nSuperseded by: [${replaced_by}]`;
      }

      // Clean up condition vectors so resolved memory doesn't match future exposure checks
      await deleteConditionVectors(ctx.env, memory_id).catch(() => {});

      // Record version for audit trail
      await recordVersion(ctx.env.DB, {
        entityId: memory_id,
        entityType: 'memory',
        changeType: 'resolved',
        contentSnapshot: {
          old_state: oldState,
          old_outcome: oldOutcome,
          new_state: 'resolved',
          outcome,
          reason,
          replaced_by: replaced_by || undefined,
          force,
        },
        changeReason: reason,
        sessionId: ctx.sessionId,
        requestId,
      });

      // Trigger cascade propagation
      // Map superseded → incorrect for cascade (same shock effect)
      let cascadeText = '';
      try {
        const cascadeOutcome = outcome === 'correct' ? 'correct'
          : (outcome === 'incorrect' || outcome === 'superseded') ? 'incorrect'
          : 'void';
        const cascadeResult = await propagateResolution(ctx.env, memory_id, cascadeOutcome, ctx.sessionId);
        if (cascadeResult.effects.length > 0) {
          cascadeText = `\nCascade: ${cascadeResult.effects.length} related memories flagged for review`;
        }
      } catch (err) {
        cascadeText = `\nCascade failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      let text = `Resolved [${memory_id}] as ${outcome}\n`;
      text += `  ${row.content.slice(0, 120)}${row.content.length > 120 ? '...' : ''}\n`;
      text += `  Previous state: ${oldState}${oldOutcome ? ` (was: ${oldOutcome})` : ''}\n`;
      text += `  Reason: ${reason}`;
      text += supersededText;
      text += cascadeText;

      return textResult(text);
    },
  }),

  defineTool({
    name: 'surprising',
    description: 'Find the most surprising memories — those that deviated most from what the knowledge graph predicted. Surprise decays as memories gain connections (edges, confirmations, tests). Scores are revalidated against current graph state. High surprise + low depth = genuine outlier. High surprise + high depth = graph has a blind spot.',
    annotations: {
      title: 'Most Surprising Memories',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max results (default 10)', minimum: 1, maximum: 50 },
        min_surprise: { type: 'number', description: 'Minimum surprise threshold 0-1 (default 0.3)', minimum: 0, maximum: 1 },
      },
    },
    handler: async (args, ctx) => {
      const { limit, min_surprise } = args as { limit?: number; min_surprise?: number };
      const results = await findMostSurprising(ctx.env, limit ?? 10, min_surprise ?? 0.3);

      if (results.length === 0) {
        return textResult('No surprising memories found above the threshold.');
      }

      const lines = results.map((r, i) => {
        const m = r.memory;
        const type = getDisplayType(m);
        const staleTag = r.stale ? ' (refreshed)' : '';
        const depthTag = r.structural_depth > 0 ? ` depth=${r.structural_depth}` : '';
        return `${i + 1}. [${m.id}] surprise=${r.surprise.toFixed(3)}${staleTag}${depthTag} (${type})\n   ${m.content.slice(0, 150)}${m.content.length > 150 ? '...' : ''}`;
      });

      return textResult(`🔮 Most Surprising Memories (${results.length} results)\n\n${lines.join('\n\n')}`);
    },
  }),

  defineTool({
    name: 'session_recap',
    description: 'Summarize memories accessed in the current session. Pulls recently accessed memories, sends them to an LLM for thematic summarization, and returns a narrative recap with memory IDs. Use raw mode to skip LLM summarization.',
    annotations: {
      title: 'Session Recap',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { type: 'integer', description: 'Time window in minutes (default: 30, used when no session ID available)', minimum: 1, maximum: 1440 },
        limit: { type: 'integer', description: 'Max memories to include (default: 30)', minimum: 1, maximum: 100 },
        raw: { type: 'boolean', description: 'Skip LLM summarization, return structured list (default: false)' },
      },
    },
    handler: async (args, ctx) => {
      const { minutes = 30, limit = 30, raw = false } = args as {
        minutes?: number;
        limit?: number;
        raw?: boolean;
      };

      const accesses = await querySessionMemories(ctx.env.DB, {
        sessionId: ctx.sessionId,
        sinceMinutes: minutes,
        limit,
      });

      if (accesses.length === 0) {
        return textResult('No memories accessed in this session. Use find/recall/reference to explore the knowledge graph first.');
      }

      // Raw mode: skip LLM
      if (raw) {
        return textResult(formatRawRecap(accesses, ctx.sessionId, minutes));
      }

      // Try LLM summarization
      const prompt = buildRecapPrompt(accesses);
      const memoryIds = accesses.map(a => a.memoryId);

      try {
        let summary: string;

        if (ctx.env.LLM_JUDGE_URL) {
          summary = await callExternalLLM(
            ctx.env.LLM_JUDGE_URL,
            prompt,
            { apiKey: ctx.env.LLM_JUDGE_API_KEY, model: ctx.env.LLM_JUDGE_MODEL, requestId }
          );
        } else {
          // Workers AI fallback
          const aiResponse = await ctx.env.AI.run(
            '@cf/meta/llama-3.1-8b-instruct' as Parameters<typeof ctx.env.AI.run>[0],
            { messages: [{ role: 'user', content: prompt }] } as { messages: Array<{ role: string; content: string }> }
          ) as { response?: string };

          summary = aiResponse.response || '';
        }

        if (!summary) {
          return textResult(formatRawRecap(accesses, ctx.sessionId, minutes));
        }

        return textResult(formatRecapResult(summary, memoryIds, accesses.length));
      } catch (_err) {
        // Graceful degradation to raw format
        return textResult(formatRawRecap(accesses, ctx.sessionId, minutes));
      }
    },
  }),
]);


// ============================================
// MCP Router
// ============================================

const mcpRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// MCP endpoint - handles JSON-RPC requests
mcpRouter.post('/', async (c) => {
  const body = await c.req.text();
  const parsed = parseJsonRpcRequest(body);

  if ('error' in parsed) {
    return c.json(parsed.error);
  }

  const config = c.get('config');
  const requestId = c.get('requestId') || `mcp-${Date.now()}`;

  // Create tool registry with current config
  const toolRegistry = createMemoryTools(config, requestId);

  const context: ToolContext<Env> = {
    userEmail: c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous',
    env: c.env,
    sessionId: c.get('sessionId'),
  };

  const response = await handleMcpMessage(
    parsed.request,
    {
      name: 'pantainos-memory',
      version: '2.0.0',
      toolRegistry,
    },
    context
  );

  if (response === null) {
    // Notification - return 202 (not 204) for rmcp/Codex client compatibility
    return c.body(null, 202);
  }

  if (parsed.request.method === 'tools/call') {
    // Best-effort: do not fail the tool call if notifications table isn't present yet.
    await prependUnreadNotifications(c.env.DB, response).catch(() => undefined);
  }

  return c.json(response);
});

// Well-known discovery endpoint
mcpRouter.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
});

/**
 * Handle an MCP message directly (for use by POST / endpoint).
 * This allows the root endpoint to also serve MCP requests.
 */
export async function handleMCPMessage(
  message: unknown,
  userEmail: string,
  env: Env
): Promise<unknown> {
  // Use a simple config - this is for the POST / endpoint
  const config = {
    search: { defaultLimit: 10, minSimilarity: 0.3 },
    aiGatewayId: (env as unknown as Record<string, string>).AI_GATEWAY_ID || undefined,
  } as Config;
  const requestId = `mcp-root-${Date.now()}`;

  const toolRegistry = createMemoryTools(config, requestId);

  const context: ToolContext<Env> = {
    userEmail,
    env,
    sessionId: undefined,
  };

  const resp = await handleMcpMessage(
    message as Parameters<typeof handleMcpMessage>[0],
    {
      name: 'pantainos-memory',
      version: '2.0.0',
      toolRegistry,
    },
    context
  );

  if ((message as { method?: unknown } | null)?.method === 'tools/call' && resp !== null) {
    await prependUnreadNotifications(env.DB, resp).catch(() => undefined);
  }

  return resp;
}

export default mcpRouter;
