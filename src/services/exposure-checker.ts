/**
 * Exposure Checker Service - Cognitive Loop Architecture (v3)
 *
 * Handles intelligent vector-based exposure checking when new observations are created.
 * Checks all three condition types:
 *   - invalidates_if: Conditions that would damage a memory (violation)
 *   - assumes: Underlying assumptions that if contradicted, damage the memory (violation)
 *   - confirms_if: Conditions that would strengthen a prediction (auto-confirm)
 *
 * Uses configurable LLM endpoint (default: OpenAI gpt-5-mini) with JSON schema enforcement.
 */

import type {
  MemoryRow,
  Violation,
  ExposureCheckResult,
} from '../lib/shared/types/index.js';
import { createLazyLogger } from '../lib/lazy-logger.js';
import { getDamageLevel } from './confidence.js';
import { applyShock, type ShockResult } from './shock-propagation.js';

const getLog = createLazyLogger('ExposureChecker', 'exposure-check-init');
import { generateId } from '../lib/id.js';
import { withRetry } from '../lib/retry.js';
import { getConfig, type Config } from '../lib/config.js';
import { generateEmbedding, callExternalLLM } from '../lib/embeddings.js';
import {
  searchInvalidatesConditions,
  searchConfirmsConditions,
  searchObservationsForViolation,
  deleteConditionVectors,
} from './embedding-tables.js';
import { propagateResolution } from './cascade.js';
import { buildZoneHealth } from './zone-builder.js';
import type { Env } from '../types/index.js';

// ============================================
// Configuration (can be overridden via env vars)
// ============================================

/** Default confidence threshold for violation detection */
const DEFAULT_VIOLATION_CONFIDENCE = 0.7;

/** Confidence threshold for auto-confirmation */
const DEFAULT_CONFIRM_CONFIDENCE = 0.75;

/** Maximum candidates to check from Vectorize */
const DEFAULT_MAX_CANDIDATES = 20;

/** Similarity threshold for candidate selection */
const DEFAULT_MIN_SIMILARITY = 0.4;

/** Get configurable thresholds from env or use defaults */
function getThresholds(env: Env) {
  return {
    violationConfidence: parseFloat(env.VIOLATION_CONFIDENCE_THRESHOLD ?? '') || DEFAULT_VIOLATION_CONFIDENCE,
    confirmConfidence: parseFloat(env.CONFIRM_CONFIDENCE_THRESHOLD ?? '') || DEFAULT_CONFIRM_CONFIDENCE,
    maxCandidates: parseInt(env.MAX_CANDIDATES ?? '') || DEFAULT_MAX_CANDIDATES,
    minSimilarity: parseFloat(env.MIN_SIMILARITY ?? '') || DEFAULT_MIN_SIMILARITY,
  };
}

// ============================================
// Types
// ============================================

/** Condition type being checked */
type ConditionType = 'invalidates_if' | 'assumes' | 'confirms_if';

export interface ConditionMatch {
  matches: boolean;
  confidence: number;
  reasoning?: string;
  relevantButNotViolation?: boolean;
}

function formatPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export async function insertCoreViolationNotification(env: Env, memoryId: string, shock: ShockResult): Promise<void> {
  // Fetch memory content for richer notification
  const mem = await env.DB.prepare(
    `SELECT content, state FROM memories WHERE id = ?`
  ).bind(memoryId).first<{ content: string; state: string }>();

  const content = mem?.content ?? '(unknown)';

  const msg = `CORE VIOLATION: [${memoryId}] shock propagated to ${shock.affected_count} memories (max drop ${formatPct(shock.max_confidence_drop)}).`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO notifications (id, type, memory_id, content, context, created_at)
     VALUES (?, 'core_violation', ?, ?, ?, ?)`
  ).bind(
    generateId(),
    memoryId,
    msg,
    JSON.stringify(shock),
    now
  ).run();

  // Push notification via Pushover (non-blocking, best-effort, LLM-formatted)
  if (env.PUSHOVER_USER_KEY && env.PUSHOVER_APP_TOKEN) {
    formatPushoverMessage(env, content, {
      memoryId,
      damageLevel: 'core',
      affectedCount: shock.affected_count,
      maxConfidenceDrop: shock.max_confidence_drop,
    }).then(({ subject, message }) =>
      sendPushoverNotification(env, message, {
        title: `Violation: ${subject}`,
      })
    ).catch(err => {
      getLog().warn('pushover_failed', {
        memory_id: memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * Insert a notification for peripheral violations that destabilize a zone.
 * Only triggers Pushover if zone is unbalanced (priority -1 = low/quiet).
 */
async function insertPeripheralViolationNotification(
  env: Env,
  memoryId: string,
  shock: ShockResult,
  zoneHealth: { balanced: boolean; quality_pct: number; zone_size: number; unsafe_reasons: string[] }
): Promise<void> {
  const mem = await env.DB.prepare(
    `SELECT content FROM memories WHERE id = ?`
  ).bind(memoryId).first<{ content: string }>();

  const content = mem?.content ?? '(unknown)';
  const status = zoneHealth.balanced ? 'balanced' : 'UNBALANCED';
  const msg = `PERIPHERAL VIOLATION: [${memoryId}] zone ${status} (quality ${zoneHealth.quality_pct}%, ${zoneHealth.zone_size} members). Shock affected ${shock.affected_count} memories.`;

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO notifications (id, type, memory_id, content, context, created_at)
     VALUES (?, 'peripheral_violation', ?, ?, ?, ?)`
  ).bind(
    generateId(),
    memoryId,
    msg,
    JSON.stringify({ shock, zone_health: zoneHealth }),
    now
  ).run();

  // Pushover only for unbalanced zones (low priority, won't bypass quiet hours, LLM-formatted)
  if (!zoneHealth.balanced && env.PUSHOVER_USER_KEY && env.PUSHOVER_APP_TOKEN) {
    formatPushoverMessage(env, content, {
      memoryId,
      damageLevel: 'peripheral',
      affectedCount: shock.affected_count,
      maxConfidenceDrop: shock.max_confidence_drop,
      zoneHealth,
    }).then(({ subject, message }) =>
      sendPushoverNotification(env, message, {
        title: `Zone Unstable: ${subject}`,
        priority: -1,
      })
    ).catch(err => {
      getLog().warn('pushover_failed', {
        memory_id: memoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

/**
 * Send a push notification via Pushover API.
 * Best-effort: failures are logged but don't block the caller.
 */
async function sendPushoverNotification(
  env: Env,
  message: string,
  opts?: { title?: string; priority?: number }
): Promise<void> {
  const resp = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: env.PUSHOVER_APP_TOKEN,
      user: env.PUSHOVER_USER_KEY,
      title: opts?.title ?? 'Memory: Core Violation',
      message,
      priority: opts?.priority ?? 1, // default high priority — bypasses quiet hours
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Pushover ${resp.status}: ${body}`);
  }
}

/**
 * Extract a human-readable subject (ticker, name, or topic) from memory content.
 * Returns the first match or a generic fallback.
 */
function extractSubject(content: string): string {
  // Match common ticker patterns: "PWR", "$AAPL", "NVDA Q4", etc.
  const tickerMatch = content.match(/\b([A-Z]{2,5})\b(?:\s+\(([^)]+)\))?/);
  if (tickerMatch) {
    return tickerMatch[2] ? `${tickerMatch[1]} (${tickerMatch[2]})` : tickerMatch[1];
  }
  // Fallback: first 30 chars of content
  return content.slice(0, 30).replace(/\s+/g, ' ').trim();
}

/**
 * Use LLM to format a concise, mobile-readable Pushover notification.
 * Falls back to truncated raw content on LLM failure.
 */
async function formatPushoverMessage(
  env: Env,
  content: string,
  context: {
    memoryId: string;
    damageLevel: 'core' | 'peripheral';
    affectedCount: number;
    maxConfidenceDrop: number;
    zoneHealth?: { balanced: boolean; quality_pct: number; zone_size: number };
  }
): Promise<{ subject: string; message: string }> {
  const subject = extractSubject(content);

  const fallback = (): { subject: string; message: string } => {
    const verb = context.damageLevel === 'core' ? 'Violated' : 'Zone destabilized';
    const msg = `${verb}. ${context.affectedCount} memories affected, max confidence drop ${formatPct(context.maxConfidenceDrop)}.`;
    return { subject, message: msg };
  };

  if (!env.LLM_JUDGE_URL) {
    return fallback();
  }

  const zoneInfo = context.zoneHealth
    ? `\n- Zone: ${context.zoneHealth.balanced ? 'balanced' : 'UNBALANCED'}, quality ${context.zoneHealth.quality_pct}%, ${context.zoneHealth.zone_size} members`
    : '';

  // Truncate content to avoid feeding the LLM a massive prompt
  const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;

  const prompt = `You are formatting a push notification for a mobile phone. Summarize this knowledge graph violation alert.

MEMORY CONTENT:
"${truncated}"

VIOLATION DETAILS:
- Severity: ${context.damageLevel}
- Memories affected: ${context.affectedCount}
- Max confidence drop: ${formatPct(context.maxConfidenceDrop)}${zoneInfo}

RULES:
1. Max 200 characters total — this must fit on a phone lock screen
2. One or two short sentences only
3. Lead with the topic/ticker, then state what happened
4. Do NOT include memory IDs, hashes, or technical identifiers
5. Plain text only — no markdown, no emojis, no bullet points
6. Be specific: mention the ticker/subject and the key finding

EXAMPLE OUTPUT:
"PWR earnings thesis violated — stock hit ATH despite bearish assessment. 2 linked memories lost confidence."

Respond with ONLY the notification text.`;

  try {
    const text = await withRetry(
      () => callExternalLLM(env.LLM_JUDGE_URL!, prompt, {
        apiKey: env.LLM_JUDGE_API_KEY,
        model: env.LLM_JUDGE_MODEL,
      }),
      { retries: 1, delay: 100 }
    );
    // Enforce length limit and strip any quotes the LLM might add
    const cleaned = text.trim().replace(/^["']|["']$/g, '').slice(0, 280);
    return { subject, message: cleaned };
  } catch (err) {
    getLog().warn('pushover_format_llm_failed', {
      memory_id: context.memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback();
  }
}

/** JSON schema for condition check response */
const CONDITION_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    matches: { type: 'boolean' },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
    relevantButNotViolation: { type: 'boolean' },
  },
  required: ['matches', 'confidence'],
};

// ============================================
// AI Gateway Configuration
// ============================================

interface AiGatewayOptions {
  operation: string;
  conditionType?: ConditionType;
  memoryId?: string;
}

/**
 * Build AI Gateway config for routing through gateway with metadata tags.
 * Returns undefined if no gateway configured (graceful degradation for dev).
 */
function getGatewayConfig(config: Config, options: AiGatewayOptions) {
  if (!config.aiGatewayId) {
    return undefined;
  }

  return {
    gateway: {
      id: config.aiGatewayId,
      metadata: {
        service: 'pantainos-memory',
        operation: options.operation,
        model: config.reasoningModel,
        ...(options.conditionType && { condition_type: options.conditionType }),
        ...(options.memoryId && { memory_id: options.memoryId }),
      },
    },
  };
}

// ============================================
// AI Response Parsing
// ============================================

/**
 * Extract response content from various model output formats.
 * Handles gpt-oss (Responses API) and llama (chat completion) formats.
 */
function extractContent(response: unknown): string {
  const r = response as {
    output?: Array<{
      type: string;
      content?: Array<{ text?: string }>;
    }>;
    response?: string;
  };

  // GPT-OSS Responses API format
  if (r?.output && Array.isArray(r.output)) {
    const msg = r.output.find((o) => o.type === 'message');
    if (msg?.content?.[0]?.text) return msg.content[0].text;
  }

  // Standard chat completion format
  if (r?.response) return r.response;

  // Raw string
  if (typeof response === 'string') return response;

  return JSON.stringify(response);
}

/**
 * Parse AI response with JSON schema enforcement and regex fallback.
 * Tries structured output first, falls back to regex extraction.
 */
export function parseConditionResponse(responseText: string): ConditionMatch {
  try {
    // Try direct JSON parse first (structured output)
    const parsed = JSON.parse(responseText);
    if (typeof parsed.matches === 'boolean') {
      return {
        matches: parsed.matches,
        confidence: Number(parsed.confidence) || 0,
        reasoning: parsed.reasoning,
        relevantButNotViolation: Boolean(parsed.relevantButNotViolation),
      };
    }
  } catch {
    // Not valid JSON, try regex extraction
  }

  // Fallback: Extract JSON from response text
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        matches: Boolean(parsed.matches),
        confidence: Number(parsed.confidence) || 0,
        reasoning: parsed.reasoning,
        relevantButNotViolation: Boolean(parsed.relevantButNotViolation),
      };
    } catch {
      // JSON extraction failed
    }
  }

  // Conservative fallback: don't match if we can't parse
  getLog().warn('parse_failed', { response_preview: responseText.slice(0, 200) });
  return { matches: false, confidence: 0 };
}

// ============================================
// Prompt Builders
// ============================================

/**
 * Build prompt for invalidates_if condition check.
 * Checks if observation indicates the invalidation condition is TRUE.
 */
export function buildInvalidatesIfPrompt(
  observationContent: string,
  condition: string,
  memoryContent: string
): string {
  return `You are a precise fact-checker determining if an observation proves an invalidation condition is TRUE.

MEMORY: "${memoryContent}"

INVALIDATION CONDITION: "${condition}"

OBSERVATION: "${observationContent}"

CRITICAL RULES — only return matches=true if ALL of these hold:
1. ENTITY CHECK: The observation must be about the SAME specific entity (company, person, asset) referenced in the condition. An observation about Company A cannot invalidate a condition about Company B, even if they are in the same sector.
2. PROOF vs RISK: The observation must provide evidence the condition ACTUALLY HAPPENED, not merely that it COULD happen. Historical analogs, risk factors, supply chain constraints, and theoretical frameworks are NOT proof. "Turbine blades are constrained" ≠ "capacity target was missed."
3. DIRECTIONAL PRECISION: Parse the exact wording. "Decelerates" ≠ "reverses." "Slows growth" ≠ "declines." If the condition says "drops below X" the observation must show the value actually went below X.
4. THRESHOLD MET: If the condition specifies a threshold (e.g., "above $3.5B", "below 80%", "majority"), the observation must show that specific threshold was crossed, not just movement in that direction.

If the observation is topically related but fails any rule above, return matches=false with relevantButNotViolation=true.

Respond with JSON only:
{
  "matches": boolean,
  "confidence": number (0-1),
  "reasoning": "brief explanation citing which rules passed/failed",
  "relevantButNotViolation": boolean
}`;
}

/**
 * Build prompt for assumes condition check.
 * Checks if observation CONTRADICTS the underlying assumption.
 */
export function buildAssumesPrompt(
  observationContent: string,
  assumption: string,
  memoryContent: string
): string {
  return `You are a precise fact-checker determining if an observation CONTRADICTS an underlying assumption.

MEMORY: "${memoryContent}"

ASSUMPTION: The memory assumes "${assumption}"

OBSERVATION: "${observationContent}"

CRITICAL RULES — only return matches=true if ALL hold:
1. ENTITY CHECK: The observation must be about the SAME entity as the assumption.
2. DIRECT CONTRADICTION: The observation must clearly negate the assumption with factual evidence. A lack of confirmation is NOT a contradiction. A risk factor is NOT a contradiction.
3. SAME SCOPE: The observation must address the assumption at the same level of specificity. A broad industry trend does not contradict a company-specific assumption unless it directly applies.

Respond with JSON only:
{
  "matches": boolean,
  "confidence": number (0-1),
  "reasoning": "brief explanation citing which rules passed/failed",
  "relevantButNotViolation": boolean (true if related but doesn't contradict)
}`;
}

/**
 * Build prompt for confirms_if condition check.
 * Checks if observation indicates the confirmation condition is TRUE.
 */
function buildConfirmsIfPrompt(
  observationContent: string,
  condition: string,
  memoryContent: string
): string {
  return `You are a precise fact-checker determining if an observation confirms a prediction.

PREDICTION: "${memoryContent}"

CONFIRMATION CONDITION: "${condition}"

OBSERVATION: "${observationContent}"

CRITICAL RULES — only return matches=true if ALL hold:
1. ENTITY CHECK: The observation must be about the SAME entity as the prediction.
2. DIRECT EVIDENCE: The observation must provide concrete evidence the confirmation condition was met, not just directional movement or sentiment.
3. THRESHOLD MET: If the condition specifies a threshold, the observation must show it was crossed.

Respond with JSON only:
{
  "matches": boolean,
  "confidence": number (0-1),
  "reasoning": "brief explanation citing which rules passed/failed"
}`;
}

// ============================================
// Core Exposure Checking
// ============================================

/**
 * Check exposures for a new observation (Three-Table Architecture).
 *
 * When an observation is created:
 * 1. Search INVALIDATES_VECTORS to find conditions this observation might match
 * 2. Search CONFIRMS_VECTORS to find conditions this observation might support
 * 3. LLM-judge each match
 *
 * This is the main entry point called when an observation is created.
 */
export async function checkExposures(
  env: Env,
  observationId: string,
  observationContent: string,
  embedding: number[]
): Promise<ExposureCheckResult> {
  const overallStart = Date.now();
  const config = getConfig(env as unknown as Record<string, string | undefined>);
  const thresholds = getThresholds(env);

  const result: ExposureCheckResult = {
    violations: [],
    confirmations: [],
    autoConfirmed: [],
  };

  // Skip exposure checking for resolution observations to prevent feedback loops.
  if (await isResolutionObservation(env.DB, observationId)) {
    getLog().info('skipping_resolution_observation', {
      observation_id: observationId,
    });
    return result;
  }

  getLog().info('exposure_check_start', {
    observation_id: observationId,
    observation_preview: observationContent.slice(0, 100),
    thresholds,
  });

  // Search both vector indexes concurrently — no reason to wait for one before the other
  const [invalidatesCandidates, confirmsCandidates] = await Promise.all([
    searchInvalidatesConditions(env, embedding, thresholds.maxCandidates, thresholds.minSimilarity),
    searchConfirmsConditions(env, embedding, thresholds.maxCandidates, thresholds.minSimilarity),
  ]);

  getLog().info('vector_search_complete', {
    invalidates_candidates: invalidatesCandidates.length,
    confirms_candidates: confirmsCandidates.length,
  });

  // Deduplicate candidates by memory_id (invalidates takes priority)
  const seenMemoryIds = new Set<string>();

  // ── Async pipeline: each candidate flows independently through fetch → filter → LLM → record ──

  // Process invalidation candidates — all flow concurrently
  const invalidationPipelines = invalidatesCandidates
    .filter(candidate => {
      if (seenMemoryIds.has(candidate.memory_id)) return false;
      seenMemoryIds.add(candidate.memory_id);
      return true;
    })
    .map(candidate => (async () => {
      // Each candidate independently: fetch + filter concurrently → LLM judge → record
      const [memory, hasPending] = await Promise.all([
        getMemoryById(env.DB, candidate.memory_id),
        hasPendingResolutionEvent(env.DB, candidate.memory_id),
      ]);
      if (!memory || memory.state !== 'active' || hasPending) return null;

      const llmStart = Date.now();
      const match = await checkConditionMatch(
        env, config, observationContent,
        candidate.condition_text, 'invalidates_if', memory.content
      );

      getLog().info('llm_judge_result', {
        memory_id: candidate.memory_id,
        condition: candidate.condition_text,
        matches: match.matches,
        confidence: match.confidence,
        reasoning: match.reasoning,
        threshold: thresholds.violationConfidence,
        duration_ms: Date.now() - llmStart,
      });

      if (match.matches && match.confidence >= thresholds.violationConfidence) {
        const damageLevel = getDamageLevel(memory.centrality);

        // Record violation + create edge flow concurrently, then cascade
        await Promise.all([
          recordViolation(env, candidate.memory_id, {
            condition: candidate.condition_text,
            timestamp: Date.now(),
            obs_id: observationId,
            damage_level: damageLevel,
            source_type: 'direct',
          }),
          createEdge(env.DB, observationId, candidate.memory_id, 'violated_by'),
        ]);

        // Cascade depends on violation being recorded
        try {
          const cascadeOutcome = damageLevel === 'core' ? 'incorrect' : 'void';
          await propagateResolution(env, candidate.memory_id, cascadeOutcome);
        } catch (cascadeError) {
          getLog().warn('cascade_failed', {
            memory_id: candidate.memory_id,
            error: cascadeError instanceof Error ? cascadeError.message : String(cascadeError),
          });
        }

        return {
          type: 'violation' as const,
          memory_id: candidate.memory_id,
          condition: candidate.condition_text,
          confidence: match.confidence,
          damage_level: damageLevel,
        };
      } else if (match.relevantButNotViolation) {
        await Promise.all([
          recordConfirmation(env.DB, candidate.memory_id),
          createEdge(env.DB, observationId, candidate.memory_id, 'confirmed_by'),
        ]);

        return {
          type: 'confirmation' as const,
          memory_id: candidate.memory_id,
          similarity: candidate.similarity,
        };
      }

      return null;
    })());

  // Process confirmation candidates — all flow concurrently (exclude already-seen memory_ids)
  const confirmationPipelines = confirmsCandidates
    .filter(candidate => {
      if (seenMemoryIds.has(candidate.memory_id)) return false;
      seenMemoryIds.add(candidate.memory_id);
      return true;
    })
    .map(candidate => (async () => {
      const [memory, hasPending] = await Promise.all([
        getMemoryById(env.DB, candidate.memory_id),
        hasPendingResolutionEvent(env.DB, candidate.memory_id),
      ]);
      if (!memory || memory.resolves_by == null || memory.state !== 'active' || hasPending) return null;

      const match = await checkConditionMatch(
        env, config, observationContent,
        candidate.condition_text, 'confirms_if', memory.content
      );

      if (match.matches && match.confidence >= thresholds.confirmConfidence) {
        await autoConfirmThought(env, candidate.memory_id, observationId);

        try {
          await propagateResolution(env, candidate.memory_id, 'correct');
        } catch (cascadeError) {
          getLog().warn('cascade_failed', {
            memory_id: candidate.memory_id,
            error: cascadeError instanceof Error ? cascadeError.message : String(cascadeError),
          });
        }

        return {
          type: 'autoConfirmed' as const,
          memory_id: candidate.memory_id,
          condition: candidate.condition_text,
          confidence: match.confidence,
        };
      }

      return null;
    })());

  // All pipelines flow concurrently — collect results only at the end
  const allResults = await Promise.allSettled([...invalidationPipelines, ...confirmationPipelines]);

  for (const settled of allResults) {
    if (settled.status === 'rejected') {
      getLog().warn('candidate_pipeline_failed', {
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      });
      continue;
    }

    const outcome = settled.value;
    if (!outcome) continue;

    switch (outcome.type) {
      case 'violation':
        result.violations.push({
          memory_id: outcome.memory_id,
          condition: outcome.condition,
          confidence: outcome.confidence,
          damage_level: outcome.damage_level,
          condition_type: 'invalidates_if',
        });
        break;
      case 'confirmation':
        result.confirmations.push({
          memory_id: outcome.memory_id,
          similarity: outcome.similarity,
        });
        break;
      case 'autoConfirmed':
        result.autoConfirmed.push({
          memory_id: outcome.memory_id,
          condition: outcome.condition,
          confidence: outcome.confidence,
        });
        break;
    }
  }

  const overallDuration = Date.now() - overallStart;
  getLog().info('exposure_check_complete', {
    observation_id: observationId,
    violations: result.violations.length,
    confirmations: result.confirmations.length,
    autoConfirmed: result.autoConfirmed.length,
    duration_ms: overallDuration,
  });

  if (env.ANALYTICS) {
    try {
      env.ANALYTICS.writeDataPoint({
        indexes: [observationId],
        doubles: [
          invalidatesCandidates.length,
          confirmsCandidates.length,
          result.violations.length,
          result.confirmations.length,
          result.autoConfirmed.length,
          overallDuration,
        ],
        blobs: ['exposure_check'],
      });
    } catch { /* swallow */ }
  }

  return result;
}

/**
 * Check exposures for a new thought (Bi-directional Architecture).
 *
 * When a thought is created with invalidates_if conditions:
 * 1. Generate embeddings for each invalidates_if condition
 * 2. Search MEMORY_VECTORS (obs only) for existing observations that might match
 * 3. LLM-judge each match
 *
 * This catches violations from observations that already exist in the system.
 *
 * @param timeBound - Whether this is a time-bound thought (has resolves_by)
 */
export async function checkExposuresForNewThought(
  env: Env,
  memoryId: string,
  memoryContent: string,
  invalidatesIf: string[],
  confirmsIf: string[],
  timeBound: boolean = false
): Promise<ExposureCheckResult> {
  const config = getConfig(env as unknown as Record<string, string | undefined>);
  const thresholds = getThresholds(env);

  const result: ExposureCheckResult = {
    violations: [],
    confirmations: [],
    autoConfirmed: [],
  };

  if (invalidatesIf.length === 0 && confirmsIf.length === 0) {
    return result;
  }

  // Get memory details for centrality
  const memory = await getMemoryById(env.DB, memoryId);
  if (!memory) return result;

  // ── Each condition flows independently: embed → search → LLM judge candidates ──
  // Pipelines return DATA only — side-effects (D1 writes) are applied after collection
  // to avoid read-modify-write races on the same memoryId's violations JSON.

  type ViolationOutcome = {
    type: 'violation';
    condition: string;
    confidence: number;
    damage_level: ReturnType<typeof getDamageLevel>;
    violation: Violation;
    obsId: string;
  };
  type ConfirmationOutcome = {
    type: 'confirmation';
    similarity: number;
    obsId: string;
  };
  type AutoConfirmedOutcome = {
    type: 'autoConfirmed';
    condition: string;
    confidence: number;
    obsId: string;
  };
  type PipelineOutcome = ViolationOutcome | ConfirmationOutcome | AutoConfirmedOutcome | null;

  // All invalidates_if conditions flow concurrently
  const invalidationPipelines = invalidatesIf.map(condition => (async (): Promise<PipelineOutcome> => {
    // Step 1: Generate embedding for this condition
    const conditionEmbedding = await generateEmbedding(env.AI, condition, config);

    // Step 2: Search for matching observations (flows immediately after embedding)
    const obsCandidates = await searchObservationsForViolation(
      env, conditionEmbedding, thresholds.maxCandidates, thresholds.minSimilarity
    );

    getLog().debug('obs_candidates_for_condition', {
      condition_preview: condition.slice(0, 50),
      count: obsCandidates.length,
    });

    // Step 3: First match wins per condition
    for (const obsCandidate of obsCandidates) {
      const obs = await getMemoryById(env.DB, obsCandidate.id);
      if (!obs) continue;
      if (hasResolutionTag(obs.tags)) continue;

      const match = await checkConditionMatch(
        env, config, obs.content, condition, 'invalidates_if', memoryContent
      );

      if (match.matches && match.confidence >= thresholds.violationConfidence) {
        const damageLevel = getDamageLevel(memory.centrality);

        // Return data — don't write to D1 (avoids race on violations JSON)
        return {
          type: 'violation',
          condition,
          confidence: match.confidence,
          damage_level: damageLevel,
          violation: {
            condition,
            timestamp: Date.now(),
            obs_id: obsCandidate.id,
            damage_level: damageLevel,
            source_type: 'direct',
          },
          obsId: obsCandidate.id,
        };
      } else if (match.relevantButNotViolation) {
        return {
          type: 'confirmation',
          similarity: obsCandidate.similarity,
          obsId: obsCandidate.id,
        };
      }
    }

    return null;
  })());

  // All confirms_if conditions flow concurrently (only for time-bound thoughts)
  const confirmationPipelines = (timeBound && confirmsIf.length > 0)
    ? confirmsIf.map(condition => (async (): Promise<PipelineOutcome> => {
        const conditionEmbedding = await generateEmbedding(env.AI, condition, config);

        const obsCandidates = await searchObservationsForViolation(
          env, conditionEmbedding, thresholds.maxCandidates, thresholds.minSimilarity
        );

        for (const obsCandidate of obsCandidates) {
          const obs = await getMemoryById(env.DB, obsCandidate.id);
          if (!obs) continue;
          if (hasResolutionTag(obs.tags)) continue;

          const match = await checkConditionMatch(
            env, config, obs.content, condition, 'confirms_if', memoryContent
          );

          if (match.matches && match.confidence >= thresholds.confirmConfidence) {
            // Return data — don't call autoConfirmThought (avoids duplicate calls)
            return {
              type: 'autoConfirmed',
              condition,
              confidence: match.confidence,
              obsId: obsCandidate.id,
            };
          }
        }

        return null;
      })())
    : [];

  // All condition pipelines flow concurrently — collect results (data only, no D1 writes yet)
  const allResults = await Promise.allSettled([...invalidationPipelines, ...confirmationPipelines]);

  // ── Apply side-effects sequentially after collection ──
  // This avoids read-modify-write races on the same memoryId's violations JSON,
  // and ensures autoConfirmThought is called at most once.

  const violationsToRecord: Violation[] = [];
  const edgesToCreate: { sourceId: string; targetId: string; edgeType: 'violated_by' | 'confirmed_by' | 'derived_from' }[] = [];
  let firstAutoConfirmObsId: string | null = null;

  for (const settled of allResults) {
    if (settled.status === 'rejected') {
      getLog().warn('thought_candidate_pipeline_failed', {
        memory_id: memoryId,
        error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
      });
      continue;
    }

    const outcome = settled.value;
    if (!outcome) continue;

    switch (outcome.type) {
      case 'violation':
        violationsToRecord.push(outcome.violation);
        edgesToCreate.push({ sourceId: outcome.obsId, targetId: memoryId, edgeType: 'violated_by' });
        result.violations.push({
          memory_id: memoryId,
          condition: outcome.condition,
          confidence: outcome.confidence,
          damage_level: outcome.damage_level,
          condition_type: 'invalidates_if',
        });
        break;
      case 'confirmation':
        edgesToCreate.push({ sourceId: outcome.obsId, targetId: memoryId, edgeType: 'confirmed_by' });
        result.confirmations.push({
          memory_id: memoryId,
          similarity: outcome.similarity,
        });
        break;
      case 'autoConfirmed':
        // Only auto-confirm once (first match wins)
        if (!firstAutoConfirmObsId) {
          firstAutoConfirmObsId = outcome.obsId;
        }
        result.autoConfirmed.push({
          memory_id: memoryId,
          condition: outcome.condition,
          confidence: outcome.confidence,
        });
        break;
    }
  }

  // Apply D1 writes — no races since we're sequential and each targets different concerns

  // Batch-record all violations in a single read-modify-write (no lost updates)
  if (violationsToRecord.length > 0) {
    await recordViolations(env, memoryId, violationsToRecord);
  }

  // Record confirmations (atomic counter increments — safe even if multiple)
  const confirmationCount = result.confirmations.length;
  if (confirmationCount > 0) {
    await recordConfirmation(env.DB, memoryId);
  }

  // Create all edges concurrently (each targets different row, no race)
  if (edgesToCreate.length > 0) {
    await Promise.all(edgesToCreate.map(e =>
      createEdge(env.DB, e.sourceId, e.targetId, e.edgeType)
    ));
  }

  // Auto-confirm once if any confirms_if condition matched
  if (firstAutoConfirmObsId) {
    await autoConfirmThought(env, memoryId, firstAutoConfirmObsId);
  }

  return result;
}

/**
 * @deprecated Use checkExposuresForNewThought - kept for migration compatibility
 */
export async function checkExposuresForNewPrediction(
  env: Env,
  memoryId: string,
  memoryType: 'infer' | 'pred',
  memoryContent: string,
  invalidatesIf: string[],
  confirmsIf: string[]
): Promise<ExposureCheckResult> {
  const timeBound = memoryType === 'pred';
  return checkExposuresForNewThought(env, memoryId, memoryContent, invalidatesIf, confirmsIf, timeBound);
}

/**
 * Get a memory by ID from D1.
 */
async function getMemoryById(
  db: D1Database,
  memoryId: string
): Promise<MemoryRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM memories WHERE id = ? AND retracted = 0`
    )
    .bind(memoryId)
    .first<MemoryRow>();

  return row;
}

// ============================================
// Resolution Feedback Loop Prevention
// ============================================

/** Tags that indicate an observation is part of a resolution process */
const RESOLUTION_TAGS = ['resolution', 'resolver', 'auto-resolution'];

/**
 * Check if a memory's tags JSON contains any resolution-related tags.
 * Used to filter out resolution observations from exposure checking.
 */
function hasResolutionTag(tagsJson: string | null): boolean {
  if (!tagsJson) return false;
  try {
    const tags: string[] = JSON.parse(tagsJson);
    return tags.some(tag => RESOLUTION_TAGS.includes(tag.toLowerCase()));
  } catch {
    return false;
  }
}

/**
 * Check if an observation is tagged as a resolution observation.
 * Resolution observations are created by the resolver agent and should
 * not trigger new violations (prevents feedback loops).
 */
async function isResolutionObservation(
  db: D1Database,
  observationId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT tags FROM memories WHERE id = ?')
    .bind(observationId)
    .first<{ tags: string | null }>();

  return row ? hasResolutionTag(row.tags) : false;
}

/**
 * Check if a memory has a pending resolution event in the event queue.
 * Memories awaiting resolution should not be re-violated or re-confirmed.
 * Checks both undispatched AND dispatched events (resolver may be actively working).
 */
async function hasPendingResolutionEvent(
  db: D1Database,
  memoryId: string
): Promise<boolean> {
  const row = await db
    .prepare(`
      SELECT COUNT(*) as count FROM memory_events
      WHERE memory_id = ?
        AND event_type = 'thought:pending_resolution'
    `)
    .bind(memoryId)
    .first<{ count: number }>();

  return (row?.count ?? 0) > 0;
}

/**
 * Use LLM to check if an observation matches a condition.
 * Uses configurable model with JSON schema enforcement.
 */
async function checkConditionMatch(
  env: Env,
  config: Config,
  observationContent: string,
  condition: string,
  conditionType: ConditionType,
  memoryContent: string
): Promise<ConditionMatch> {
  // Build prompt based on condition type
  let prompt: string;
  switch (conditionType) {
    case 'invalidates_if':
      prompt = buildInvalidatesIfPrompt(observationContent, condition, memoryContent);
      break;
    case 'assumes':
      prompt = buildAssumesPrompt(observationContent, condition, memoryContent);
      break;
    case 'confirms_if':
      prompt = buildConfirmsIfPrompt(observationContent, condition, memoryContent);
      break;
  }

  try {
    let responseText: string;

    // Use external LLM endpoint if configured
    if (env.LLM_JUDGE_URL) {
      responseText = await withRetry(
        () => callExternalLLM(
          env.LLM_JUDGE_URL!,
          prompt,
          { apiKey: env.LLM_JUDGE_API_KEY, model: env.LLM_JUDGE_MODEL }
        ),
        { retries: 2, delay: 100 }
      );
    } else {
      // Use Workers AI
      const response = await withRetry(
        async () => {
          const model = config.reasoningModel;
          const isGptOss = model.includes('gpt-oss');

          // AI Gateway config for observability (optional - gracefully falls back if not configured)
          const gatewayConfig = getGatewayConfig(config, {
            operation: 'condition_check',
            conditionType,
          });

          if (isGptOss) {
            // GPT-OSS uses Responses API format with structured output
            return await env.AI.run(
              model as Parameters<typeof env.AI.run>[0],
              {
                input: prompt,
                instructions: 'Return only valid JSON matching the schema',
                response_format: {
                  type: 'json_schema',
                  json_schema: {
                    name: 'condition_check',
                    strict: true,
                    schema: CONDITION_CHECK_SCHEMA,
                  },
                },
              } as Parameters<typeof env.AI.run>[1],
              gatewayConfig
            );
          } else {
            // Chat completion format for other models
            return await env.AI.run(
              model as Parameters<typeof env.AI.run>[0],
              {
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 200,
              } as Parameters<typeof env.AI.run>[1],
              gatewayConfig
            );
          }
        },
        { retries: 2, delay: 100 }
      );

      responseText = extractContent(response);
    }

    return parseConditionResponse(responseText);
  } catch (error) {
    getLog().error('condition_check_failed', { error: error instanceof Error ? error.message : String(error) });
    return { matches: false, confidence: 0 };
  }
}

// ============================================
// Database Operations
// ============================================

/**
 * Record a violation for a memory.
 * Updates: violations array, times_tested count, contradictions count.
 * If damage_level is 'core', auto-resolves the memory as incorrect.
 */
async function recordViolation(
  env: Env,
  memoryId: string,
  violation: Violation
): Promise<void> {
  // Get current violations
  const row = await env.DB
    .prepare('SELECT violations, times_tested FROM memories WHERE id = ?')
    .bind(memoryId)
    .first<{ violations: string; times_tested: number }>();

  if (!row) {
    return;
  }

  const violations: Violation[] = JSON.parse(row.violations || '[]');

  // Dedup: skip if this observation already violated this memory
  if (violation.obs_id && violations.some(v => v.obs_id === violation.obs_id)) {
    getLog().debug('duplicate_violation_skipped', {
      memory_id: memoryId,
      obs_id: violation.obs_id,
    });
    return;
  }

  violations.push(violation);

  const now = Date.now();

  // If core damage, auto-resolve as incorrect
  if (violation.damage_level === 'core') {
    await env.DB
      .prepare(
        `
      UPDATE memories
      SET violations = ?,
          times_tested = times_tested + 1,
          contradictions = contradictions + 1,
          state = 'resolved',
          outcome = 'incorrect',
          resolved_at = ?,
          updated_at = ?
      WHERE id = ?
      `
      )
      .bind(JSON.stringify(violations), now, now, memoryId)
      .run();
  } else {
    // Non-core violations don't auto-resolve
    await env.DB
      .prepare(
        `
      UPDATE memories
      SET violations = ?,
          times_tested = times_tested + 1,
          contradictions = contradictions + 1,
          state = 'violated',
          updated_at = ?
      WHERE id = ?
      `
      )
      .bind(JSON.stringify(violations), now, memoryId)
      .run();
  }

  // Clean up condition vectors so this memory can't be re-matched
  await deleteConditionVectors(env, memoryId).catch(err => {
    getLog().warn('condition_vector_cleanup_failed', {
      memory_id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Decay outgoing support edges (shock update from Nikooroo & Engel)
  // Core violations decay edges to 50%, peripheral to 75%
  const damageFactor = violation.damage_level === 'core' ? 0.5 : 0.25;
  await env.DB
    .prepare(
      `UPDATE edges SET strength = strength * (1.0 - ?)
       WHERE source_id = ? AND edge_type IN ('derived_from', 'confirmed_by')`
    )
    .bind(damageFactor, memoryId)
    .run();

  // Phase B-alpha: local shock propagation (non-blocking)
  try {
    const shock = await applyShock(env, memoryId, violation.damage_level);
    if (violation.damage_level === 'core') {
      await insertCoreViolationNotification(env, memoryId, shock);
    } else {
      // Peripheral violation: check zone health, notify if zone became unbalanced
      try {
        const zoneHealthStart = Date.now();
        const zoneHealth = await buildZoneHealth(env.DB, memoryId, { maxDepth: 2, maxSize: 20 });
        getLog().info('zone_health_checked', {
          memory_id: memoryId,
          zone_size: zoneHealth.zone_size,
          quality_pct: zoneHealth.quality_pct,
          balanced: zoneHealth.balanced,
          duration_ms: Date.now() - zoneHealthStart,
        });
        if (!zoneHealth.balanced || zoneHealth.quality_pct < 50) {
          await insertPeripheralViolationNotification(env, memoryId, shock, zoneHealth);
        }
      } catch (zoneErr) {
        getLog().warn('peripheral_zone_health_failed', {
          memory_id: memoryId,
          error: zoneErr instanceof Error ? zoneErr.message : String(zoneErr),
        });
      }
    }
  } catch (err) {
    getLog().warn('shock_propagation_failed', {
      memory_id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Batch-record multiple violations for a single memory in one read-modify-write.
 * Used by checkExposuresForNewThought where all concurrent pipelines target the same memoryId.
 * Avoids the lost-update race that would occur if each pipeline called recordViolation independently.
 */
async function recordViolations(
  env: Env,
  memoryId: string,
  newViolations: Violation[]
): Promise<void> {
  const row = await env.DB
    .prepare('SELECT violations FROM memories WHERE id = ?')
    .bind(memoryId)
    .first<{ violations: string }>();

  if (!row) return;

  const existing: Violation[] = JSON.parse(row.violations || '[]');

  // Dedup against existing violations
  const toAdd = newViolations.filter(v =>
    !v.obs_id || !existing.some(e => e.obs_id === v.obs_id)
  );
  if (toAdd.length === 0) return;

  const allViolations = [...existing, ...toAdd];
  const hasCore = toAdd.some(v => v.damage_level === 'core');
  const now = Date.now();

  if (hasCore) {
    await env.DB
      .prepare(
        `UPDATE memories
         SET violations = ?, times_tested = times_tested + ?, contradictions = contradictions + ?,
             state = 'resolved', outcome = 'incorrect', resolved_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(JSON.stringify(allViolations), toAdd.length, toAdd.length, now, now, memoryId)
      .run();
  } else {
    await env.DB
      .prepare(
        `UPDATE memories
         SET violations = ?, times_tested = times_tested + ?, contradictions = contradictions + ?,
             state = 'violated', updated_at = ?
         WHERE id = ?`
      )
      .bind(JSON.stringify(allViolations), toAdd.length, toAdd.length, now, memoryId)
      .run();
  }

  // Clean up condition vectors so this memory can't be re-matched
  await deleteConditionVectors(env, memoryId).catch(err => {
    getLog().warn('condition_vector_cleanup_failed', {
      memory_id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Decay outgoing support edges — use worst damage level
  const worstDamage = hasCore ? 'core' : 'peripheral';
  const damageFactor = worstDamage === 'core' ? 0.5 : 0.25;
  await env.DB
    .prepare(
      `UPDATE edges SET strength = strength * (1.0 - ?)
       WHERE source_id = ? AND edge_type IN ('derived_from', 'confirmed_by')`
    )
    .bind(damageFactor, memoryId)
    .run();

  // Shock propagation using worst damage level
  try {
    const shock = await applyShock(env, memoryId, worstDamage);
    if (worstDamage === 'core') {
      await insertCoreViolationNotification(env, memoryId, shock);
    } else {
      try {
        const zoneHealth = await buildZoneHealth(env.DB, memoryId, { maxDepth: 2, maxSize: 20 });
        if (!zoneHealth.balanced || zoneHealth.quality_pct < 50) {
          await insertPeripheralViolationNotification(env, memoryId, shock, zoneHealth);
        }
      } catch (zoneErr) {
        getLog().warn('peripheral_zone_health_failed', {
          memory_id: memoryId,
          error: zoneErr instanceof Error ? zoneErr.message : String(zoneErr),
        });
      }
    }
  } catch (err) {
    getLog().warn('shock_propagation_failed', {
      memory_id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a confirmation for a memory.
 * Updates: confirmations count, times_tested count
 */
async function recordConfirmation(
  db: D1Database,
  memoryId: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE memories
    SET confirmations = confirmations + 1, times_tested = times_tested + 1, updated_at = ?
    WHERE id = ?
    `
    )
    .bind(Date.now(), memoryId)
    .run();

  // Recover outgoing support edges toward 1.0 (10% per confirmation, capped)
  await db
    .prepare(
      `UPDATE edges SET strength = MIN(1.0, strength * 1.1)
       WHERE source_id = ? AND edge_type IN ('derived_from', 'confirmed_by')`
    )
    .bind(memoryId)
    .run();
}

/**
 * Auto-confirm a time-bound thought when confirms_if condition matches.
 * Creates edge, updates stats, and resolves the thought as correct.
 */
async function autoConfirmThought(
  env: Env,
  thoughtId: string,
  observationId: string
): Promise<void> {
  const now = Date.now();

  await env.DB
    .prepare(
      `
    UPDATE memories
    SET confirmations = confirmations + 1,
        times_tested = times_tested + 1,
        state = 'resolved',
        outcome = 'correct',
        resolved_at = ?,
        updated_at = ?
    WHERE id = ?
    `
    )
    .bind(now, now, thoughtId)
    .run();

  await createEdge(env.DB, observationId, thoughtId, 'confirmed_by');

  // Clean up condition vectors — resolved thought shouldn't match future exposure checks
  await deleteConditionVectors(env, thoughtId).catch(err => {
    getLog().warn('condition_vector_cleanup_failed', {
      memory_id: thoughtId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Create an edge between observation and memory.
 */
async function createEdge(
  db: D1Database,
  sourceId: string,
  targetId: string,
  edgeType: 'derived_from' | 'violated_by' | 'confirmed_by'
): Promise<void> {
  const id = generateId();
  await db
    .prepare(
      `
    INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
    VALUES (?, ?, ?, ?, 1.0, ?)
    `
    )
    .bind(id, sourceId, targetId, edgeType, Date.now())
    .run();
}

// ============================================
// Manual Exposure Operations
// ============================================

/**
 * Manually confirm a memory (increase confidence).
 * Called from /api/confirm/:id endpoint.
 */
export async function manualConfirm(
  db: D1Database,
  memoryId: string,
  observationId?: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE memories
    SET confirmations = confirmations + 1, times_tested = times_tested + 1, updated_at = ?
    WHERE id = ?
    `
    )
    .bind(Date.now(), memoryId)
    .run();

  // Recover outgoing support edges toward 1.0
  await db
    .prepare(
      `UPDATE edges SET strength = MIN(1.0, strength * 1.1)
       WHERE source_id = ? AND edge_type IN ('derived_from', 'confirmed_by')`
    )
    .bind(memoryId)
    .run();

  // Create edge if observation provided
  if (observationId) {
    await createEdge(db, observationId, memoryId, 'confirmed_by');
  }
}

/**
 * Manually violate a memory (add to violations).
 * Called from /api/violate/:id endpoint.
 * If damage_level is 'core', auto-resolves as incorrect.
 */
export async function manualViolate(
  env: Env,
  memoryId: string,
  condition: string,
  observationId?: string
): Promise<Violation> {
  // Get memory to determine damage level
  const row = await env.DB
    .prepare('SELECT centrality, violations FROM memories WHERE id = ?')
    .bind(memoryId)
    .first<{ centrality: number; violations: string }>();

  if (!row) {
    throw new Error(`Memory not found: ${memoryId}`);
  }

  const now = Date.now();
  const damageLevel = getDamageLevel(row.centrality);

  const violation: Violation = {
    condition,
    timestamp: now,
    obs_id: observationId || 'manual',
    damage_level: damageLevel,
    source_type: 'direct',
  };

  const violations: Violation[] = JSON.parse(row.violations || '[]');
  violations.push(violation);

  // If core damage, auto-resolve as incorrect
  if (damageLevel === 'core') {
    await env.DB
      .prepare(
        `
      UPDATE memories
      SET violations = ?,
          times_tested = times_tested + 1,
          contradictions = contradictions + 1,
          state = 'resolved',
          outcome = 'incorrect',
          resolved_at = ?,
          updated_at = ?
      WHERE id = ?
      `
      )
      .bind(JSON.stringify(violations), now, now, memoryId)
      .run();
  } else {
    // Non-core violations don't auto-resolve
    await env.DB
      .prepare(
        `
      UPDATE memories
      SET violations = ?,
          times_tested = times_tested + 1,
          contradictions = contradictions + 1,
          state = 'violated',
          updated_at = ?
      WHERE id = ?
      `
      )
      .bind(JSON.stringify(violations), now, memoryId)
      .run();
  }

  // Clean up condition vectors so this memory can't be re-matched
  await deleteConditionVectors(env, memoryId).catch(err => {
    getLog().warn('condition_vector_cleanup_failed', {
      memory_id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Decay outgoing support edges (shock update)
  const damageFactor = damageLevel === 'core' ? 0.5 : 0.25;
  await env.DB
    .prepare(
      `UPDATE edges SET strength = strength * (1.0 - ?)
       WHERE source_id = ? AND edge_type IN ('derived_from', 'confirmed_by')`
    )
    .bind(damageFactor, memoryId)
    .run();

  // Phase B-alpha: local shock propagation (non-blocking)
  try {
    const shock = await applyShock(env, memoryId, damageLevel);
    if (damageLevel === 'core') {
      await insertCoreViolationNotification(env, memoryId, shock);
    }
  } catch (err) {
    getLog().warn('shock_propagation_failed', {
      memory_id: memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Create edge if observation provided
  if (observationId) {
    await createEdge(env.DB, observationId, memoryId, 'violated_by');
  }

  return violation;
}

// ============================================
// Centrality Management
// ============================================

/**
 * Increment centrality when an edge is created TO a memory.
 * Call this when creating derived_from edges.
 */
export async function incrementCentrality(
  db: D1Database,
  targetId: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE memories
    SET centrality = centrality + 1, updated_at = ?
    WHERE id = ?
    `
    )
    .bind(Date.now(), targetId)
    .run();
}

/**
 * Decrement centrality when an edge is deleted.
 */
export async function decrementCentrality(
  db: D1Database,
  targetId: string
): Promise<void> {
  await db
    .prepare(
      `
    UPDATE memories
    SET centrality = MAX(0, centrality - 1), updated_at = ?
    WHERE id = ?
    `
    )
    .bind(Date.now(), targetId)
    .run();
}
