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
import { getDisplayType, isObservation } from '../lib/shared/types/index.js';
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
import { generateEmbedding, searchSimilar, checkDuplicate, checkDuplicateWithLLM } from '../lib/embeddings.js';
import { storeObservationEmbeddings, storeObservationWithConditions, storeThoughtEmbeddings } from '../services/embedding-tables.js';
import { recordVersion } from '../services/history-service.js';
import { recordAccessBatch } from '../services/access-service.js';
import { rowToMemory } from '../lib/transforms.js';
import { createScoredMemory } from '../lib/scoring.js';
import { incrementCentrality } from '../services/exposure-checker.js';
import { checkMemoryCompleteness, formatCompletenessOutput } from '../services/classification-challenge.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

/** Valid observation sources */
const VALID_SOURCES = ['market', 'news', 'earnings', 'email', 'human', 'tool'] as const;

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

/** Format search results */
function formatFindResults(results: Array<{ memory: { id: string; content: string; state?: string }; similarity: number; confidence: number }>, query: string): string {
  if (results.length === 0) return `No results for "${query}"`;

  const lines = results.map((r, i) => {
    const sim = Math.round(r.similarity * 100);
    const conf = Math.round(r.confidence * 100);
    const stateIcon = r.memory.state === 'violated' ? ' ⚠️' : r.memory.state === 'confirmed' ? ' ✓' : '';
    return `${i + 1}. [${r.memory.id}] ${r.memory.content}${stateIcon}\n   sim:${sim}% conf:${conf}%`;
  });

  return `Found ${results.length} for "${query}":\n\n${lines.join('\n\n')}`;
}

/** Format recall result */
function formatRecall(memory: MemoryRow, connections: Array<{ target_id: string; strength: number }>): string {
  const m = rowToMemory(memory);
  const displayType = getDisplayType(m);
  const stateIcon = m.state === 'violated' ? ' ⚠️ VIOLATED' : m.state === 'confirmed' ? ' ✓ CONFIRMED' : '';
  const confidence = m.times_tested > 0
    ? `${Math.round(m.confirmations / m.times_tested * 100)}% (${m.confirmations}/${m.times_tested})`
    : 'untested';

  let text = `[${m.id}] ${m.content}\n\n`;
  text += `Type: ${displayType} | State: ${m.state}${stateIcon} | Confidence: ${confidence}\n`;

  if (isObservation(m) && m.source) {
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
function formatInsights(view: string, memories: MemoryRow[], total: number, limit: number, offset: number): string {
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
function formatPending(memories: Array<{ id: string; content: string; resolves_by?: number }>, total: number, limit: number, offset: number): string {
  if (memories.length === 0) return 'No pending time-bound predictions';

  const lines = memories.map(m => {
    const deadline = m.resolves_by ? formatResolvesBy(m.resolves_by) : 'no deadline';
    return `[${m.id}] ${m.content}\n   Resolves by: ${deadline}`;
  });

  const from = offset + 1;
  const to = offset + memories.length;
  return `=== PENDING RESOLUTION === (showing ${from}-${to} of ${total})\n\n${lines.join('\n\n')}`;
}

/** Text result wrapper */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
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
    description: `Record a memory. Two modes based on origin:

OBSERVATION (reality intake): Set "source" (market, news, earnings, email, human, tool)
THOUGHT (derived belief): Set "derived_from" with source memory IDs

Exactly one of "source" OR "derived_from" required (mutually exclusive).

Both modes support invalidates_if/confirms_if conditions.
For predictions: add resolves_by (date string or timestamp) + outcome_condition.`,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content' },
        source: { type: 'string', enum: ['market', 'news', 'earnings', 'email', 'human', 'tool'], description: 'Observation source (mutually exclusive with derived_from)' },
        derived_from: { type: 'array', items: { type: 'string' }, description: 'Source memory IDs (mutually exclusive with source)' },
        invalidates_if: { type: 'array', items: { type: 'string' }, description: 'Conditions that would prove this wrong' },
        confirms_if: { type: 'array', items: { type: 'string' }, description: 'Conditions that would strengthen this' },
        assumes: { type: 'array', items: { type: 'string' }, description: 'Underlying assumptions (thoughts only)' },
        resolves_by: { type: 'string', description: 'Deadline as date string (e.g. "2026-03-15") or Unix timestamp' },
        outcome_condition: { type: 'string', description: 'Success/failure criteria (required if resolves_by set)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
      },
      required: ['content'],
    },
    handler: async (args, ctx) => {
      const {
        content,
        source,
        derived_from,
        invalidates_if,
        confirms_if,
        assumes,
        resolves_by: rawResolvesBy,
        outcome_condition,
        tags,
      } = args as {
        content: string;
        source?: string;
        derived_from?: string[];
        invalidates_if?: string[];
        confirms_if?: string[];
        assumes?: string[];
        resolves_by?: number | string;
        outcome_condition?: string;
        tags?: string[];
      };

      // Parse resolves_by: accepts date strings ("2026-03-15") or Unix timestamps
      const resolves_by = parseResolvesBy(rawResolvesBy);
      if (rawResolvesBy !== undefined && resolves_by === null) {
        return errorResult(`Could not parse resolves_by: "${rawResolvesBy}". Use a date string (e.g. "2026-03-15") or Unix timestamp.`);
      }

      // Validate origin: exactly one of source XOR derived_from required
      const hasSource = source !== undefined && source !== null;
      const hasDerivedFrom = derived_from !== undefined && derived_from !== null && derived_from.length > 0;

      if (!hasSource && !hasDerivedFrom) {
        return errorResult('Either "source" or "derived_from" is required. Set "source" for observations, "derived_from" for thoughts.');
      }

      if (hasSource && hasDerivedFrom) {
        return errorResult('"source" and "derived_from" are mutually exclusive. Use "source" for observations (reality intake) or "derived_from" for thoughts (derived beliefs).');
      }

      // Mode-specific validation
      if (hasSource) {
        // Observation mode
        if (!VALID_SOURCES.includes(source as typeof VALID_SOURCES[number])) {
          return errorResult(`source must be one of: ${VALID_SOURCES.join(', ')}`);
        }
        // Observations can't have assumes
        if (assumes && assumes.length > 0) {
          return errorResult('"assumes" is only valid for thoughts (derived_from mode), not observations');
        }
      } else {
        // Thought mode - validate derived_from existence
        const placeholders = derived_from!.map(() => '?').join(',');
        const sources = await ctx.env.DB.prepare(
          `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
        ).bind(...derived_from!).all<{ id: string }>();

        if (!sources.results || sources.results.length !== derived_from!.length) {
          const foundIds = new Set(sources.results?.map((r) => r.id) || []);
          const missing = derived_from!.filter((id) => !foundIds.has(id));
          return errorResult(`Source memories not found: ${missing.join(', ')}`);
        }
      }

      // Time-bound validation
      const timeBound = resolves_by !== null && resolves_by !== undefined;
      if (timeBound && !outcome_condition) {
        return errorResult('outcome_condition is required when resolves_by is set');
      }

      // Generate embedding first for duplicate check
      const embedding = await generateEmbedding(ctx.env.AI, content, config, requestId);

      // Check for duplicates
      const dupCheck = await checkDuplicate(ctx.env, embedding, requestId);
      if (dupCheck.id && dupCheck.similarity >= config.dedupThreshold) {
        const existing = await ctx.env.DB.prepare(
          `SELECT content FROM memories WHERE id = ?`
        ).bind(dupCheck.id).first<{ content: string }>();

        return textResult(`⚠️ DUPLICATE DETECTED (${Math.round(dupCheck.similarity * 100)}% match)\n\nExisting: [${dupCheck.id}] ${existing?.content || '(not found)'}\n\nNew (skipped): ${content}`);
      } else if (dupCheck.id && dupCheck.similarity >= config.dedupLowerThreshold) {
        const existing = await ctx.env.DB.prepare(
          `SELECT content FROM memories WHERE id = ?`
        ).bind(dupCheck.id).first<{ content: string }>();

        if (existing) {
          const llmResult = await checkDuplicateWithLLM(ctx.env.AI, content, existing.content, config, requestId, ctx.env);
          if (llmResult.isDuplicate && llmResult.confidence >= config.dedupConfidenceThreshold) {
            return textResult(`⚠️ DUPLICATE DETECTED (LLM: ${Math.round(llmResult.confidence * 100)}% confidence)\n\nExisting: [${dupCheck.id}] ${existing.content}\n\nNew (skipped): ${content}\n\nReason: ${llmResult.reasoning}`);
          }
        }
      }

      const now = Date.now();
      const id = generateId();
      const sessionId = ctx.sessionId;

      // Determine starting confidence based on mode
      let startingConfidence: number;
      if (hasSource) {
        // Observation: use source-based confidence
        startingConfidence = await getStartingConfidenceForSource(ctx.env.DB, source!);
      } else {
        // Thought: predictions get lower prior than general thoughts
        startingConfidence = timeBound ? TYPE_STARTING_CONFIDENCE.predict : TYPE_STARTING_CONFIDENCE.think;
      }

      // Unified INSERT into memories table
      await ctx.env.DB.prepare(
        `INSERT INTO memories (
          id, content, source, derived_from,
          assumes, invalidates_if, confirms_if,
          outcome_condition, resolves_by,
          starting_confidence, confirmations, times_tested, contradictions,
          centrality, state, violations,
          retracted, tags, session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
      ).bind(
        id,
        content,
        hasSource ? source : null,
        hasDerivedFrom ? JSON.stringify(derived_from) : null,
        assumes ? JSON.stringify(assumes) : null,
        invalidates_if ? JSON.stringify(invalidates_if) : null,
        confirms_if ? JSON.stringify(confirms_if) : null,
        outcome_condition || null,
        resolves_by || null,
        startingConfidence,
        tags ? JSON.stringify(tags) : null,
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
      const entityType = hasSource ? 'observation' : (timeBound ? 'prediction' : 'thought');
      await recordVersion(ctx.env.DB, {
        entityId: id,
        entityType,
        changeType: 'created',
        contentSnapshot: {
          id,
          content,
          source: hasSource ? source : undefined,
          derived_from: hasDerivedFrom ? derived_from : undefined,
          assumes,
          invalidates_if,
          confirms_if,
          outcome_condition,
          resolves_by,
          tags,
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
        // Observation mode
        if (hasConditions) {
          await storeObservationWithConditions(ctx.env, ctx.env.AI, config, {
            id,
            content,
            source: source!,
            invalidates_if,
            confirms_if,
            requestId,
            embedding,
          });
        } else {
          await storeObservationEmbeddings(ctx.env, ctx.env.AI, config, {
            id,
            content,
            source: source!,
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

      await ctx.env.DETECTION_QUEUE.send(exposureJob);

      // Check for memory completeness (feature toggle)
      let completenessText = '';
      const completeness = await checkMemoryCompleteness(ctx.env, ctx.env.AI, config, {
        content,
        has_source: hasSource,
        has_derived_from: hasDerivedFrom,
        has_invalidates_if: Boolean(invalidates_if?.length),
        has_confirms_if: Boolean(confirms_if?.length),
        has_resolves_by: timeBound,
        requestId,
      });
      if (completeness) {
        completenessText = formatCompletenessOutput(completeness);
      }

      // Format response based on mode
      if (hasSource) {
        return textResult(`✓ Observed [${id}]\n${content.substring(0, 100)}${content.length > 100 ? '...' : ''}${completenessText}`);
      } else {
        const typeLabel = timeBound ? 'Predicted' : 'Thought';
        return textResult(`✓ ${typeLabel} [${id}]\n${content.substring(0, 100)}${content.length > 100 ? '...' : ''}\n\nDerived from: ${derived_from!.map(d => `[${d}]`).join(', ')}${completenessText}`);
      }
    },
  }),

  defineTool({
    name: 'update',
    description: 'Add missing fields to a recently-created memory (within 1 hour or same session). Use after completeness suggestions to strengthen a memory without recreating it. Cannot change core identity (content, source, derived_from).',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to update' },
        invalidates_if: { type: 'array', items: { type: 'string' }, description: 'Conditions to ADD (not replace)' },
        confirms_if: { type: 'array', items: { type: 'string' }, description: 'Conditions to ADD (not replace)' },
        assumes: { type: 'array', items: { type: 'string' }, description: 'Assumptions to ADD (thoughts only)' },
        resolves_by: { type: 'string', description: 'Deadline as date string (e.g. "2026-03-15") or Unix timestamp (cannot change if already set)' },
        outcome_condition: { type: 'string', description: 'Success/failure criteria (cannot change if already set)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to ADD (not replace)' },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const {
        memory_id: rawMemoryId,
        id: rawId,
        invalidates_if,
        confirms_if,
        assumes,
        resolves_by: rawResolvesBy2,
        outcome_condition,
        tags,
      } = args as {
        memory_id?: string;
        id?: string;
        invalidates_if?: string[];
        confirms_if?: string[];
        assumes?: string[];
        resolves_by?: number | string;
        outcome_condition?: string;
        tags?: string[];
      };

      const memory_id = rawMemoryId || rawId;
      if (!memory_id) {
        return errorResult('memory_id is required');
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

      // Check time window: same session OR created within 1 hour
      const ONE_HOUR_MS = 60 * 60 * 1000;
      const now = Date.now();
      const isSameSession = ctx.sessionId && row.session_id === ctx.sessionId;
      const isWithinTimeWindow = (now - row.created_at) < ONE_HOUR_MS;

      if (!isSameSession && !isWithinTimeWindow) {
        return errorResult(`Memory [${memory_id}] is too old to update (created ${Math.round((now - row.created_at) / 1000 / 60)} minutes ago). Only memories created within 1 hour or in the same session can be updated.`);
      }

      // Determine memory type
      const hasSource = row.source !== null;
      const hasDerivedFrom = row.derived_from !== null;

      // Validate assumes is only for thoughts
      if (assumes && assumes.length > 0 && hasSource) {
        return errorResult('"assumes" can only be added to thoughts (derived_from mode), not observations');
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

      // Handle resolves_by and outcome_condition - can only set if not already set
      let newResolvesBy = row.resolves_by;
      let newOutcomeCondition = row.outcome_condition;

      if (resolves_by !== undefined) {
        if (row.resolves_by !== null) {
          return errorResult('resolves_by is already set and cannot be changed');
        }
        newResolvesBy = resolves_by;
      }

      if (outcome_condition !== undefined) {
        if (row.outcome_condition !== null) {
          return errorResult('outcome_condition is already set and cannot be changed');
        }
        newOutcomeCondition = outcome_condition;
      }

      // Validate time-bound consistency
      if (newResolvesBy !== null && newOutcomeCondition === null) {
        return errorResult('outcome_condition is required when resolves_by is set');
      }

      // Update the memory
      await ctx.env.DB.prepare(
        `UPDATE memories SET
          invalidates_if = ?,
          confirms_if = ?,
          assumes = ?,
          resolves_by = ?,
          outcome_condition = ?,
          tags = ?,
          updated_at = ?
        WHERE id = ?`
      ).bind(
        newInvalidatesIf.length > 0 ? JSON.stringify(newInvalidatesIf) : null,
        newConfirmsIf.length > 0 ? JSON.stringify(newConfirmsIf) : null,
        newAssumes.length > 0 ? JSON.stringify(newAssumes) : null,
        newResolvesBy || null,
        newOutcomeCondition || null,
        newTags.length > 0 ? JSON.stringify(newTags) : null,
        now,
        memory_id
      ).run();

      // Re-embed conditions if new ones were added
      const addedInvalidatesIf = invalidates_if || [];
      const addedConfirmsIf = confirms_if || [];
      const timeBound = newResolvesBy !== null;

      if (addedInvalidatesIf.length > 0 || addedConfirmsIf.length > 0) {
        // Store new condition embeddings
        // Start index from existing array length to avoid ID collisions
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

        // Update MEMORY_VECTORS metadata to reflect conditions now exist
        const existingEmbedding = await generateEmbedding(ctx.env.AI, row.content, config, requestId);
        await ctx.env.MEMORY_VECTORS.upsert([
          {
            id: memory_id,
            values: existingEmbedding,
            metadata: {
              type: hasSource ? 'obs' : 'thought',
              source: row.source || undefined,
              has_invalidates_if: newInvalidatesIf.length > 0,
              has_confirms_if: newConfirmsIf.length > 0,
              has_assumes: newAssumes.length > 0,
              has_outcome: timeBound,
              resolves_by: newResolvesBy || undefined,
              time_bound: timeBound,
            } as any,
          },
        ]);

        // Re-queue exposure check with new conditions
        const exposureJob: ExposureCheckJob = {
          memory_id,
          is_observation: hasSource,
          content: row.content,
          embedding: existingEmbedding,
          session_id: ctx.sessionId,
          request_id: requestId,
          timestamp: now,
          invalidates_if: newInvalidatesIf.length > 0 ? newInvalidatesIf : undefined,
          confirms_if: newConfirmsIf.length > 0 ? newConfirmsIf : undefined,
          time_bound: timeBound,
        };
        await ctx.env.DETECTION_QUEUE.send(exposureJob);
      }

      // Record version for audit trail
      await recordVersion(ctx.env.DB, {
        entityId: memory_id,
        entityType: hasSource ? 'observation' : (timeBound ? 'prediction' : 'thought'),
        changeType: 'updated',
        contentSnapshot: {
          id: memory_id,
          content: row.content,
          source: row.source || undefined,
          derived_from: hasDerivedFrom ? JSON.parse(row.derived_from!) : undefined,
          assumes: newAssumes.length > 0 ? newAssumes : undefined,
          invalidates_if: newInvalidatesIf.length > 0 ? newInvalidatesIf : undefined,
          confirms_if: newConfirmsIf.length > 0 ? newConfirmsIf : undefined,
          outcome_condition: newOutcomeCondition || undefined,
          resolves_by: newResolvesBy || undefined,
          tags: newTags.length > 0 ? newTags : undefined,
        },
        sessionId: ctx.sessionId,
        requestId,
      });

      // Build response showing what was added
      const changes: string[] = [];
      if (addedInvalidatesIf.length > 0) changes.push(`+${addedInvalidatesIf.length} invalidates_if`);
      if (addedConfirmsIf.length > 0) changes.push(`+${addedConfirmsIf.length} confirms_if`);
      if (assumes && assumes.length > 0) changes.push(`+${assumes.length} assumes`);
      if (tags && tags.length > 0) changes.push(`+${tags.length} tags`);
      if (resolves_by !== undefined) changes.push(`resolves_by set`);
      if (outcome_condition !== undefined) changes.push(`outcome_condition set`);

      return textResult(`✓ Updated [${memory_id}]\n${changes.join(', ')}`);
    },
  }),

  defineTool({
    name: 'find',
    description: 'Search memories by meaning. Results ranked by: similarity (semantic match), confidence (survival rate under testing), and centrality (how many thoughts derive from this). Use to find related observations before forming thoughts, or to check if a thought already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        types: { type: 'array', items: { type: 'string', enum: ['observation', 'thought', 'prediction'] }, description: 'Filter by memory types (observation, thought, prediction)' },
        limit: { type: 'integer', description: 'Max results to return (default: 10)', minimum: 1, maximum: 100 },
        min_similarity: { type: 'number', description: 'Minimum similarity threshold (0-1)' },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const { query, types, limit: requestedLimit, min_similarity } = args as {
        query: string;
        types?: string[];
        limit?: number;
        min_similarity?: number;
      };

      const limit = requestedLimit || config.search.defaultLimit;
      const minSimilarity = min_similarity || config.search.minSimilarity;
      const filterTypes = types || null; // null means no filter

      // Generate embedding for query
      const queryEmbedding = await generateEmbedding(ctx.env.AI, query, config, requestId);

      // Search Vectorize
      const searchResults = await searchSimilar(
        ctx.env,
        queryEmbedding,
        limit * 2,
        minSimilarity,
        requestId
      );

      // Fetch memory details and filter
      const results: ScoredMemory[] = [];

      for (const match of searchResults) {
        if (results.length >= limit) break;

        const row = await ctx.env.DB.prepare(
          `SELECT * FROM memories WHERE id = ? AND retracted = 0`
        ).bind(match.id).first<MemoryRow>();

        if (!row) continue;

        const memory = rowToMemory(row);

        // Type filtering using field presence
        if (filterTypes) {
          const displayType = getDisplayType(memory);
          if (!filterTypes.includes(displayType)) continue;
        }

        const scoredMemory = createScoredMemory(memory, match.similarity, config);
        results.push(scoredMemory);
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

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
      })), query));
    },
  }),

  defineTool({
    name: 'recall',
    description: 'Get a memory by ID. Returns the content, confidence stats (times_tested, confirmations), state (active/violated/confirmed), and derivation edges. Use to inspect a specific memory before building on it.',
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

      const row = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ?`
      ).bind(resolvedId).first<MemoryRow>();

      if (!row) {
        return errorResult(`Memory not found: ${resolvedId}`);
      }

      // Get connected memories
      const edges = await ctx.env.DB.prepare(
        `SELECT target_id, strength FROM edges WHERE source_id = ?`
      ).bind(resolvedId).all<{ target_id: string; strength: number }>();

      return textResult(formatRecall(row, edges.results || []));
    },
  }),

  defineTool({
    name: 'stats',
    description: 'Get memory statistics (counts by type, robustness distribution, etc.).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, ctx) => {
      // Count memories by type using field presence
      const obsCount = await ctx.env.DB.prepare(
        `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NOT NULL`
      ).first<{ count: number }>();

      const thoughtCount = await ctx.env.DB.prepare(
        `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND derived_from IS NOT NULL AND resolves_by IS NULL`
      ).first<{ count: number }>();

      const predictionCount = await ctx.env.DB.prepare(
        `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND resolves_by IS NOT NULL`
      ).first<{ count: number }>();

      // Count edges
      const edgeCount = await ctx.env.DB.prepare(
        'SELECT COUNT(*) as count FROM edges'
      ).first<{ count: number }>();

      const obs = obsCount?.count || 0;
      const thoughts = thoughtCount?.count || 0;
      const predictions = predictionCount?.count || 0;
      const total = obs + thoughts + predictions;
      const edges = edgeCount?.count || 0;

      return textResult(`📊 Memory Stats\nObservations: ${obs}\nThoughts: ${thoughts}\nPredictions: ${predictions}\nTotal: ${total}\nConnections: ${edges}`);
    },
  }),

  defineTool({
    name: 'pending',
    description: 'List time-bound predictions past their resolves_by deadline awaiting resolution. These need human review to mark as confirmed or violated.',
    inputSchema: {
      type: 'object',
      properties: {
        overdue: { type: 'boolean', description: 'Only show overdue predictions (default: false shows all pending)' },
        limit: { type: 'integer', description: 'Max results (default: 20)' },
        offset: { type: 'integer', description: 'Skip first N results for pagination (default: 0)' },
      },
    },
    handler: async (args, ctx) => {
      const { overdue, limit, offset } = args as { overdue?: boolean; limit?: number; offset?: number };
      const now = Date.now();
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
    description: 'Analyze knowledge graph health. Views: hubs (most-connected memories), orphans (unconnected - no derivation links), untested (low times_tested - dangerous if confident), failing (have violations from contradicting observations), recent (latest memories).',
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
      const visited = new Set<string>();

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

      // Traverse function
      async function traverse(
        memoryId: string,
        currentDepth: number,
        dir: string
      ): Promise<void> {
        if (currentDepth >= maxDepth || visited.has(`${memoryId}-${dir}`)) return;
        visited.add(`${memoryId}-${dir}`);

        // Traverse up (what this memory is derived from)
        if (dir === 'up' || dir === 'both') {
          const derivedFrom = await ctx.env.DB.prepare(
            `SELECT * FROM edges WHERE target_id = ?`
          ).bind(memoryId).all<EdgeRow>();

          for (const row of derivedFrom.results || []) {
            if (!nodes.has(row.source_id)) {
              const sourceRow = await ctx.env.DB.prepare(
                `SELECT * FROM memories WHERE id = ? AND retracted = 0`
              ).bind(row.source_id).first<MemoryRow>();

              if (sourceRow) {
                const sourceMemory = rowToMemory(sourceRow);
                nodes.set(row.source_id, {
                  id: row.source_id,
                  type: getDisplayType(sourceMemory),
                  content: sourceMemory.content,
                  depth: currentDepth + 1,
                });
              }
            }

            edges.push({
              source: row.source_id,
              target: memoryId,
              type: row.edge_type,
              strength: row.strength,
            });

            await traverse(row.source_id, currentDepth + 1, 'up');
          }
        }

        // Traverse down (what derives from this memory)
        if (dir === 'down' || dir === 'both') {
          const derivesTo = await ctx.env.DB.prepare(
            `SELECT * FROM edges WHERE source_id = ?`
          ).bind(memoryId).all<EdgeRow>();

          for (const row of derivesTo.results || []) {
            if (!nodes.has(row.target_id)) {
              const targetRow = await ctx.env.DB.prepare(
                `SELECT * FROM memories WHERE id = ? AND retracted = 0`
              ).bind(row.target_id).first<MemoryRow>();

              if (targetRow) {
                const targetMemory = rowToMemory(targetRow);
                nodes.set(row.target_id, {
                  id: row.target_id,
                  type: getDisplayType(targetMemory),
                  content: targetMemory.content,
                  depth: currentDepth + 1,
                });
              }
            }

            edges.push({
              source: memoryId,
              target: row.target_id,
              type: row.edge_type,
              strength: row.strength,
            });

            await traverse(row.target_id, currentDepth + 1, 'down');
          }
        }
      }

      await traverse(memory_id, 0, direction);

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
    description: 'Trace a thought back to its root observations. Walks the derivation chain to find the original facts this belief is based on. Use to audit reasoning - every thought should trace back to reality.',
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

      // If already an observation, return itself
      if (isObservation(memory)) {
        return textResult(`[${memory_id}] is already an observation (ground truth)\n\n${memory.content}`);
      }

      // Trace to roots
      const visited = new Set<string>();
      const roots: Array<{ id: string; content: string; type: string }> = [];
      let maxDepth = 0;

      async function traceToRoots(memId: string, depth: number): Promise<void> {
        if (visited.has(memId)) return;
        visited.add(memId);

        const derivedFrom = await ctx.env.DB.prepare(
          `SELECT source_id FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
        ).bind(memId).all<{ source_id: string }>();

        if (!derivedFrom.results || derivedFrom.results.length === 0) {
          // Check if this is an observation (root) - has source field set
          const obsRow = await ctx.env.DB.prepare(
            `SELECT * FROM memories WHERE id = ? AND source IS NOT NULL AND retracted = 0`
          ).bind(memId).first<MemoryRow>();

          if (obsRow && !roots.some(r => r.id === memId)) {
            roots.push({
              id: memId,
              content: obsRow.content,
              type: 'observation',
            });
            if (depth > maxDepth) maxDepth = depth;
          }
          return;
        }

        for (const parent of derivedFrom.results) {
          const parentRow = await ctx.env.DB.prepare(
            `SELECT * FROM memories WHERE id = ? AND retracted = 0`
          ).bind(parent.source_id).first<MemoryRow>();

          if (!parentRow) continue;

          // Check if parent is an observation (has source field)
          if (parentRow.source !== null) {
            if (!roots.some(r => r.id === parent.source_id)) {
              roots.push({
                id: parent.source_id,
                content: parentRow.content,
                type: 'observation',
              });
              if (depth + 1 > maxDepth) maxDepth = depth + 1;
            }
          } else {
            await traceToRoots(parent.source_id, depth + 1);
          }
        }
      }

      await traceToRoots(memory_id, 0);

      if (roots.length === 0) {
        return textResult(`[${memory_id}] has no traceable roots (orphan thought)`);
      }

      const rootLines = roots.map(r => `[${r.id}] ${r.content}`);
      let text = `=== ROOTS of [${memory_id}] (depth: ${maxDepth}) ===\n\n`;
      text += `Source: ${memory.content.substring(0, 100)}...\n\n`;
      text += `Grounded in ${roots.length} observation(s):\n\n`;
      text += rootLines.join('\n');

      return textResult(text);
    },
  }),

  defineTool({
    name: 'between',
    description: 'Find memories that bridge two given memories. Discovers conceptual connections you might not have noticed. Use when you have two related thoughts and want to understand what links them.',
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
    // Notification - no response needed
    return c.body(null, 204);
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

  return handleMcpMessage(
    message as Parameters<typeof handleMcpMessage>[0],
    {
      name: 'pantainos-memory',
      version: '2.0.0',
      toolRegistry,
    },
    context
  );
}

export default mcpRouter;
