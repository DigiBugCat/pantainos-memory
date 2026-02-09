/**
 * Exposure Checker Service - Cognitive Loop Architecture (v3)
 *
 * Handles intelligent vector-based exposure checking when new observations are created.
 * Checks all three condition types:
 *   - invalidates_if: Conditions that would damage a memory (violation)
 *   - assumes: Underlying assumptions that if contradicted, damage the memory (violation)
 *   - confirms_if: Conditions that would strengthen a prediction (auto-confirm)
 *
 * Uses configurable model (default: gpt-oss-120b) with JSON schema enforcement.
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

interface ConditionMatch {
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
  const pushMsg = `[${memoryId}] ${content}\n\nShock propagated to ${shock.affected_count} memories (max drop ${formatPct(shock.max_confidence_drop)}).`;
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

  // Push notification via Pushover (non-blocking, best-effort)
  if (env.PUSHOVER_USER_KEY && env.PUSHOVER_APP_TOKEN) {
    sendPushoverNotification(env, pushMsg).catch(err => {
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
  message: string
): Promise<void> {
  const resp = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: env.PUSHOVER_APP_TOKEN,
      user: env.PUSHOVER_USER_KEY,
      title: 'Memory: Core Violation',
      message,
      priority: 1, // high priority — bypasses quiet hours
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Pushover ${resp.status}: ${body}`);
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
function parseConditionResponse(responseText: string): ConditionMatch {
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
function buildInvalidatesIfPrompt(
  observationContent: string,
  condition: string,
  memoryContent: string
): string {
  return `You are checking if an observation matches a condition that would invalidate a belief.

MEMORY: "${memoryContent}"

INVALIDATION CONDITION: "${condition}"

OBSERVATION: "${observationContent}"

Does this observation indicate that the invalidation condition is TRUE?

Consider:
1. Does the observation directly state or strongly imply the condition is met?
2. Is the observation merely related but doesn't actually satisfy the condition?
3. How confident are you in this assessment?

Respond with JSON only:
{
  "matches": boolean,
  "confidence": number (0-1),
  "reasoning": "brief explanation",
  "relevantButNotViolation": boolean (true if related but doesn't invalidate)
}`;
}

/**
 * Build prompt for assumes condition check.
 * Checks if observation CONTRADICTS the underlying assumption.
 */
function buildAssumesPrompt(
  observationContent: string,
  assumption: string,
  memoryContent: string
): string {
  return `You are checking if an observation contradicts an underlying assumption.

MEMORY: "${memoryContent}"

ASSUMPTION: The memory assumes "${assumption}"

OBSERVATION: "${observationContent}"

Does this observation CONTRADICT or NEGATE this assumption?

Important: Only return matches=true if the observation clearly contradicts the assumption.
A lack of confirmation is NOT a contradiction.

Respond with JSON only:
{
  "matches": boolean,
  "confidence": number (0-1),
  "reasoning": "brief explanation",
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
  return `You are checking if an observation confirms a prediction.

PREDICTION: "${memoryContent}"

CONFIRMATION CONDITION: "${condition}"

OBSERVATION: "${observationContent}"

Does this observation indicate that the confirmation condition is TRUE, thereby confirming the prediction?

Consider:
1. Does the observation directly satisfy the confirmation condition?
2. Is it merely related but not conclusive?
3. How confident are you?

Respond with JSON only:
{
  "matches": boolean,
  "confidence": number (0-1),
  "reasoning": "brief explanation"
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
  const config = getConfig(env as unknown as Record<string, string | undefined>);
  const thresholds = getThresholds(env);

  const result: ExposureCheckResult = {
    violations: [],
    confirmations: [],
    autoConfirmed: [],
  };

  // Skip exposure checking for resolution observations to prevent feedback loops.
  // When the resolver agent resolves a memory, it may create observations whose
  // content matches invalidation conditions of other memories, causing circular violations.
  if (await isResolutionObservation(env.DB, observationId)) {
    getLog().info('skipping_resolution_observation', {
      observation_id: observationId,
    });
    return result;
  }

  // Track which memories we've already processed to avoid duplicates
  const processedMemories = new Set<string>();

  getLog().info('exposure_check_start', {
    observation_id: observationId,
    observation_preview: observationContent.slice(0, 100),
    thresholds,
  });

  // 1. Search INVALIDATES_VECTORS for conditions this observation might match
  const invalidatesCandidates = await searchInvalidatesConditions(
    env,
    embedding,
    thresholds.maxCandidates,
    thresholds.minSimilarity
  );

  getLog().info('invalidates_candidates', {
    count: invalidatesCandidates.length,
    candidates: invalidatesCandidates.map(c => ({
      condition: c.condition_text,
      similarity: c.similarity,
      memory_id: c.memory_id,
    })),
  });

  // 2. Process invalidation candidates
  for (const candidate of invalidatesCandidates) {
    if (processedMemories.has(candidate.memory_id)) continue;

    // Get full memory details
    const memory = await getMemoryById(env.DB, candidate.memory_id);
    if (!memory) continue;

    // Skip memories that are no longer active (already violated/resolved/confirmed)
    if (memory.state !== 'active') {
      getLog().debug('skipping_non_active_memory', {
        memory_id: candidate.memory_id,
        state: memory.state,
        condition: candidate.condition_text,
      });
      continue;
    }

    // Skip memories that have a pending resolution event (being processed by resolver)
    if (await hasPendingResolutionEvent(env.DB, candidate.memory_id)) {
      getLog().debug('skipping_pending_resolution', {
        memory_id: candidate.memory_id,
        condition: candidate.condition_text,
      });
      continue;
    }

    // LLM-judge this specific condition
    const match = await checkConditionMatch(
      env,
      config,
      observationContent,
      candidate.condition_text,
      'invalidates_if',
      memory.content
    );

    getLog().info('llm_judge_result', {
      memory_id: candidate.memory_id,
      condition: candidate.condition_text,
      matches: match.matches,
      confidence: match.confidence,
      reasoning: match.reasoning,
      threshold: thresholds.violationConfidence,
    });

    if (match.matches && match.confidence >= thresholds.violationConfidence) {
      const damageLevel = getDamageLevel(memory.centrality);
      result.violations.push({
        memory_id: candidate.memory_id,
        condition: candidate.condition_text,
        confidence: match.confidence,
        damage_level: damageLevel,
        condition_type: 'invalidates_if',
      });

      await recordViolation(env, candidate.memory_id, {
        condition: candidate.condition_text,
        timestamp: Date.now(),
        obs_id: observationId,
        damage_level: damageLevel,
        source_type: 'direct',
      });

      await createEdge(env.DB, observationId, candidate.memory_id, 'violated_by');

      // Propagate cascade for all violations
      // - Core damage: resolved as incorrect → cascade 'incorrect' (damage_confidence)
      // - Non-core damage: not resolved, just violated → cascade 'void' (review)
      try {
        const cascadeOutcome = damageLevel === 'core' ? 'incorrect' : 'void';
        await propagateResolution(env, candidate.memory_id, cascadeOutcome);
      } catch (cascadeError) {
        getLog().warn('cascade_failed', {
          memory_id: candidate.memory_id,
          error: cascadeError instanceof Error ? cascadeError.message : String(cascadeError),
        });
      }

      processedMemories.add(candidate.memory_id);
    } else if (match.relevantButNotViolation) {
      // Related but not a violation = confirmation
      result.confirmations.push({
        memory_id: candidate.memory_id,
        similarity: candidate.similarity,
      });
      await recordConfirmation(env.DB, candidate.memory_id);
      await createEdge(env.DB, observationId, candidate.memory_id, 'confirmed_by');
      processedMemories.add(candidate.memory_id);
    }
  }

  // 3. Search CONFIRMS_VECTORS for conditions this observation might support
  const confirmsCandidates = await searchConfirmsConditions(
    env,
    embedding,
    thresholds.maxCandidates,
    thresholds.minSimilarity
  );

  getLog().debug('confirms_candidates', { count: confirmsCandidates.length });

  // 4. Process confirmation candidates (predictions only)
  for (const candidate of confirmsCandidates) {
    if (processedMemories.has(candidate.memory_id)) continue;

    // Get full memory details
    const memory = await getMemoryById(env.DB, candidate.memory_id);
    // Only process predictions (have resolves_by set)
    if (!memory || memory.resolves_by == null) continue;

    // Skip predictions that are no longer active (already resolved/confirmed)
    if (memory.state !== 'active') {
      getLog().debug('skipping_non_active_prediction', {
        memory_id: candidate.memory_id,
        state: memory.state,
      });
      continue;
    }

    // Skip predictions that have a pending resolution event
    if (await hasPendingResolutionEvent(env.DB, candidate.memory_id)) {
      getLog().debug('skipping_pending_resolution_prediction', {
        memory_id: candidate.memory_id,
      });
      continue;
    }

    // LLM-judge this specific condition
    const match = await checkConditionMatch(
      env,
      config,
      observationContent,
      candidate.condition_text,
      'confirms_if',
      memory.content
    );

    if (match.matches && match.confidence >= thresholds.confirmConfidence) {
      result.autoConfirmed.push({
        memory_id: candidate.memory_id,
        condition: candidate.condition_text,
        confidence: match.confidence,
      });

      await autoConfirmThought(env, candidate.memory_id, observationId);

      // Propagate resolution to related memories (mark for review, don't auto-modify)
      try {
        await propagateResolution(env, candidate.memory_id, 'correct');
      } catch (cascadeError) {
        // Log but don't fail the main operation
        getLog().warn('cascade_failed', {
          memory_id: candidate.memory_id,
          error: cascadeError instanceof Error ? cascadeError.message : String(cascadeError),
        });
      }

      processedMemories.add(candidate.memory_id);
    }
  }

  getLog().info('exposure_check_complete', {
    observation_id: observationId,
    violations: result.violations.length,
    confirmations: result.confirmations.length,
    autoConfirmed: result.autoConfirmed.length,
  });

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

  // Track processed observations
  const processedObs = new Set<string>();

  // 1. For each invalidates_if condition, search for matching observations
  for (const condition of invalidatesIf) {
    // Generate embedding for this condition
    const conditionEmbedding = await generateEmbedding(
      env.AI,
      condition,
      config
    );

    // Search MEMORY_VECTORS for observations that might match this condition
    const obsCandidates = await searchObservationsForViolation(
      env,
      conditionEmbedding,
      thresholds.maxCandidates,
      thresholds.minSimilarity
    );

    getLog().debug('obs_candidates_for_condition', {
      condition_preview: condition.slice(0, 50),
      count: obsCandidates.length,
    });

    // LLM-judge each observation against this condition
    for (const obsCandidate of obsCandidates) {
      if (processedObs.has(obsCandidate.id)) continue;

      // Get observation content
      const obs = await getMemoryById(env.DB, obsCandidate.id);
      if (!obs) continue;

      // Skip resolution observations to prevent feedback loops
      if (hasResolutionTag(obs.tags)) {
        processedObs.add(obsCandidate.id);
        continue;
      }

      const match = await checkConditionMatch(
        env,
        config,
        obs.content,
        condition,
        'invalidates_if',
        memoryContent
      );

      if (match.matches && match.confidence >= thresholds.violationConfidence) {
        const damageLevel = getDamageLevel(memory.centrality);
        result.violations.push({
          memory_id: memoryId,
          condition,
          confidence: match.confidence,
          damage_level: damageLevel,
          condition_type: 'invalidates_if',
        });

        await recordViolation(env, memoryId, {
          condition,
          timestamp: Date.now(),
          obs_id: obsCandidate.id,
          damage_level: damageLevel,
          source_type: 'direct',
        });

        await createEdge(env.DB, obsCandidate.id, memoryId, 'violated_by');
        processedObs.add(obsCandidate.id);
        break; // One violation per condition
      } else if (match.relevantButNotViolation) {
        result.confirmations.push({
          memory_id: memoryId,
          similarity: obsCandidate.similarity,
        });
        await recordConfirmation(env.DB, memoryId);
        await createEdge(env.DB, obsCandidate.id, memoryId, 'confirmed_by');
        processedObs.add(obsCandidate.id);
        break;
      }
    }
  }

  // 2. For time-bound thoughts with confirms_if, check if existing observations confirm them
  if (timeBound && confirmsIf.length > 0) {
    for (const condition of confirmsIf) {
      const conditionEmbedding = await generateEmbedding(
        env.AI,
        condition,
        config
      );

      const obsCandidates = await searchObservationsForViolation(
        env,
        conditionEmbedding,
        thresholds.maxCandidates,
        thresholds.minSimilarity
      );

      for (const obsCandidate of obsCandidates) {
        if (processedObs.has(obsCandidate.id)) continue;

        const obs = await getMemoryById(env.DB, obsCandidate.id);
        if (!obs) continue;

        // Skip resolution observations to prevent feedback loops
        if (hasResolutionTag(obs.tags)) {
          processedObs.add(obsCandidate.id);
          continue;
        }

        const match = await checkConditionMatch(
          env,
          config,
          obs.content,
          condition,
          'confirms_if',
          memoryContent
        );

        if (match.matches && match.confidence >= thresholds.confirmConfidence) {
          result.autoConfirmed.push({
            memory_id: memoryId,
            condition,
            confidence: match.confidence,
          });

          await autoConfirmThought(env, memoryId, obsCandidate.id);
          processedObs.add(obsCandidate.id);
          break;
        }
      }
    }
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

    // Use external LLM endpoint if configured (service binding or URL)
    if (env.CLAUDE_PROXY || env.LLM_JUDGE_URL) {
      responseText = await withRetry(
        () => callExternalLLM(
          env.CLAUDE_PROXY ?? env.LLM_JUDGE_URL!,
          prompt,
          { apiKey: env.LLM_JUDGE_API_KEY }
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
