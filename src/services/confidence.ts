/**
 * Confidence Service - Unified Thought Model (v4)
 *
 * Implements Subjective Logic-inspired confidence model:
 * - Starting confidence = prior belief based on source/type
 * - Effective confidence = blend of prior + evidence weight
 * - Evidence weight = log-scale normalization against global max
 * - Score = similarity × (1 + effective × boost_weight)
 *
 * Key insight: Untested memories retain their prior, while tested
 * memories earn confidence through survival rate.
 */

import type {
  Memory,
  ConfidenceStats,
  Robustness,
  DamageLevel,
} from '../lib/shared/types/index.js';
import type { Config } from '../lib/config.js';

// ============================================
// Starting Confidence Defaults
// ============================================

/** Default starting confidence by observation source */
export const SOURCE_STARTING_CONFIDENCE: Record<string, number> = {
  market: 0.75,    // API data, hard to fake
  tool: 0.70,      // Computed/generated
  earnings: 0.70,  // Official but revisable
  news: 0.55,      // Can be misreported
  email: 0.50,     // Depends on sender
  human: 0.50,     // Memory is fallible
};

/** Default starting confidence by memory type */
export const TYPE_STARTING_CONFIDENCE = {
  think: 0.40,     // General thought
  predict: 0.35,   // Time-bound prediction
  obs: 0.50,       // Observation (fallback)
} as const;

// ============================================
// Configuration
// ============================================

/** Default thresholds for robustness tiers (can be overridden via config) */
export const ROBUSTNESS_THRESHOLDS = {
  /** Below this many times_tested = untested */
  UNTESTED_MAX_TIMES_TESTED: 3,
  /** Below this many times_tested = brittle */
  BRITTLE_MAX_TIMES_TESTED: 10,
  /** Above this confidence = robust (when well-tested) */
  ROBUST_MIN_CONFIDENCE: 0.7,
} as const;

/** Get robustness thresholds from config or use defaults */
export function getRobustnessThresholds(config?: Config) {
  if (config?.robustness) {
    return {
      UNTESTED_MAX_TIMES_TESTED: config.robustness.untestedMaxTimesTested,
      BRITTLE_MAX_TIMES_TESTED: config.robustness.brittleMaxTimesTested,
      ROBUST_MIN_CONFIDENCE: config.robustness.robustMinConfidence,
    };
  }
  return ROBUSTNESS_THRESHOLDS;
}

/** Thresholds for damage level calculation */
export const DAMAGE_THRESHOLDS = {
  /** Memories with centrality above this are "core" */
  CORE_MIN_CENTRALITY: 5,
} as const;

/** Scoring weights */
export const SCORING_WEIGHTS = {
  /** Bonus multiplier for well-tested memories */
  ROBUSTNESS_BONUS: 1.2,
  /** Weight for centrality in score calculation */
  CENTRALITY_WEIGHT: 0.1,
  /** Weight for confidence boost in search scoring */
  CONFIDENCE_BOOST_WEIGHT: 0.5,
  /** Penalty multiplier for incorrect/superseded resolved memories */
  INCORRECT_PENALTY: 0.3,
} as const;

/** Default max_times_tested if not available from system_stats */
export const DEFAULT_MAX_TIMES_TESTED = 10;

// ============================================
// Core Functions
// ============================================

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Calculate evidence weight using log-scale normalization.
 * This determines how much to trust earned evidence vs prior belief.
 *
 * @param timesTested - Number of times this memory was tested
 * @param maxTimesTested - Global max (from system_stats or default)
 * @returns Evidence weight between 0 and 1
 */
export function getEvidenceWeight(timesTested: number, maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED): number {
  // Log-scale evidence weight (self-normalizing)
  return Math.log(timesTested + 1) / Math.log(maxTimesTested + 1);
}

/**
 * Calculate earned confidence from testing history.
 * Earned = confirmations / max(times_tested, 1)
 */
export function getEarnedConfidence(memory: Memory): number {
  return memory.confirmations / Math.max(memory.times_tested, 1);
}

/**
 * Calculate local (non-graph) confidence using Subjective Logic blend.
 *
 * Formula: local = startingConfidence * (1 - evidenceWeight) + earned * evidenceWeight
 *
 * - If never tested: returns starting_confidence (prior)
 * - As testing increases: transitions toward earned confidence
 * - Fully tested: almost entirely earned confidence
 *
 * @param memory - The memory to evaluate
 * @param maxTimesTested - Global max for normalization (from system_stats)
 */
export function getLocalConfidence(memory: Memory, maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED): number {
  const evidenceWeight = getEvidenceWeight(memory.times_tested, maxTimesTested);
  const earned = getEarnedConfidence(memory);

  // Blend prior with evidence
  return clamp01(memory.starting_confidence * (1 - evidenceWeight) + earned * evidenceWeight);
}

/**
 * Calculate effective confidence.
 *
 * If propagated_confidence is present, blend it with local confidence.
 * This keeps confidence grounded in direct evidence while allowing
 * graph-aware propagation to influence ranking and zones.
 */
export function getEffectiveConfidence(memory: Memory, maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED): number {
  const local = getLocalConfidence(memory, maxTimesTested);

  if (memory.propagated_confidence != null) {
    const blended = 0.6 * memory.propagated_confidence + 0.4 * local;
    return clamp01(blended);
  }

  return local;
}

/**
 * Determine robustness tier based on testing history.
 *
 * - untested: < untestedMaxTimesTested (hasn't been tested enough)
 * - brittle: untestedMaxTimesTested - brittleMaxTimesTested (some testing, but could collapse)
 * - tested: > brittleMaxTimesTested but < robustMinConfidence
 * - robust: > brittleMaxTimesTested and >= robustMinConfidence
 *
 * @param memory - The memory to evaluate
 * @param config - Optional config for custom thresholds (uses defaults if not provided)
 */
export function getRobustness(memory: Memory, config?: Config): Robustness {
  const thresholds = getRobustnessThresholds(config);

  if (memory.times_tested < thresholds.UNTESTED_MAX_TIMES_TESTED) {
    return 'untested';
  }

  if (memory.times_tested < thresholds.BRITTLE_MAX_TIMES_TESTED) {
    return 'brittle';
  }

  const confidence = getEffectiveConfidence(memory);
  return confidence >= thresholds.ROBUST_MIN_CONFIDENCE
    ? 'robust'
    : 'tested';
}

/**
 * Get full confidence statistics for a memory.
 *
 * @param memory - The memory to evaluate
 * @param config - Optional config for custom thresholds
 * @param maxTimesTested - Global max for normalization (from system_stats)
 */
export function getConfidenceStats(
  memory: Memory,
  config?: Config,
  maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED
): ConfidenceStats {
  return {
    starting_confidence: memory.starting_confidence,
    effective_confidence: getEffectiveConfidence(memory, maxTimesTested),
    robustness: getRobustness(memory, config),
    times_tested: memory.times_tested,
    confirmations: memory.confirmations,
    contradictions: memory.contradictions,
    centrality: memory.centrality,
    violation_count: memory.violations.length,
    exposure_check_status: memory.exposure_check_status,
  };
}

/**
 * Determine damage level based on centrality.
 * Memories with high centrality are "load-bearing" - violations are more severe.
 */
export function getDamageLevel(centrality: number): DamageLevel {
  return centrality > DAMAGE_THRESHOLDS.CORE_MIN_CENTRALITY
    ? 'core'
    : 'peripheral';
}

// ============================================
// Scoring for Search
// ============================================

/**
 * Calculate search score using new formula.
 *
 * New Formula: score = similarity × (1 + effective_confidence × BOOST_WEIGHT)
 *
 * This replaces the old multiplicative formula which penalized untested memories.
 * Now similarity drives ranking, and confidence provides a boost.
 *
 * @param memory - The memory to score
 * @param similarity - Vectorize similarity score (0-1)
 * @param maxTimesTested - Global max for normalization
 */
export function calculateScore(
  memory: Memory,
  similarity: number,
  maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED
): number {
  const effective = getEffectiveConfidence(memory, maxTimesTested);

  // New formula: similarity with confidence boost
  let score = similarity * (1 + effective * SCORING_WEIGHTS.CONFIDENCE_BOOST_WEIGHT);

  // Penalize resolved-incorrect/superseded memories (still visible but ranked lower)
  if (memory.state === 'resolved' && (memory.outcome === 'incorrect' || memory.outcome === 'superseded')) {
    score *= SCORING_WEIGHTS.INCORRECT_PENALTY;
  }

  return score;
}

/**
 * Smart scoring that handles all memories appropriately.
 * Now just delegates to calculateScore which uses the new formula.
 */
export function smartScore(
  memory: Memory,
  similarity: number,
  maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED
): number {
  return calculateScore(memory, similarity, maxTimesTested);
}

// ============================================
// Analysis Helpers
// ============================================

/**
 * Check if a memory is "brittle" - high confidence but low testing.
 * These are memories that look good but haven't been tested enough.
 *
 * @param memory - The memory to evaluate
 * @param options - Optional overrides for thresholds
 * @param config - Optional config for default thresholds
 */
export function isBrittle(
  memory: Memory,
  options: { maxTimesTested?: number; minConfidence?: number } = {},
  config?: Config
): boolean {
  const thresholds = getRobustnessThresholds(config);
  const maxTimesTested = options.maxTimesTested ?? thresholds.BRITTLE_MAX_TIMES_TESTED;
  const minConfidence = options.minConfidence ?? 0.5;

  if (memory.times_tested >= maxTimesTested) {
    return false; // Well tested
  }

  if (memory.times_tested === 0) {
    return true; // Never tested = brittle
  }

  const confidence = getEffectiveConfidence(memory);
  return confidence >= minConfidence; // High confidence but low testing
}

/**
 * Get a human-readable description of why a memory is brittle.
 */
export function getBrittleReason(memory: Memory): string {
  if (memory.times_tested === 0) {
    return 'Never been tested against observations';
  }

  const confidence = getEffectiveConfidence(memory);
  if (confidence >= 0.8) {
    return `High confidence (${(confidence * 100).toFixed(0)}%) but only ${memory.times_tested} tests`;
  }

  if (memory.times_tested < 3) {
    return `Only tested ${memory.times_tested} time(s)`;
  }

  return `Tested ${memory.times_tested} times but confidence is ${(confidence * 100).toFixed(0)}%`;
}

/**
 * Check if a memory is "failing" - low confidence despite testing.
 */
export function isFailing(memory: Memory, minTimesTested = 5): boolean {
  if (memory.times_tested < minTimesTested) {
    return false; // Not enough data
  }

  const confidence = getEffectiveConfidence(memory);
  return confidence < 0.5; // More violations than confirmations
}

/**
 * Check if a memory is a "hub" - many other memories depend on it.
 */
export function isHub(memory: Memory, minCentrality = 5): boolean {
  return memory.centrality >= minCentrality;
}

/**
 * Check if a memory is "orphaned" - no connections at all.
 */
export function isOrphan(memory: Memory): boolean {
  return memory.centrality === 0;
}

// ============================================
// Batch Operations
// ============================================

/**
 * Sort memories by score (for search results).
 */
export function sortByScore(
  memories: Array<{ memory: Memory; similarity: number }>
): Array<{ memory: Memory; similarity: number; score: number }> {
  return memories
    .map(({ memory, similarity }) => ({
      memory,
      similarity,
      score: smartScore(memory, similarity),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Filter memories to only include brittle ones.
 */
export function filterBrittle(
  memories: Memory[],
  options?: { maxTimesTested?: number; minConfidence?: number }
): Memory[] {
  return memories.filter((m) => isBrittle(m, options));
}

/**
 * Filter memories to only include failing ones.
 */
export function filterFailing(
  memories: Memory[],
  minTimesTested = 5
): Memory[] {
  return memories.filter((m) => isFailing(m, minTimesTested));
}

/**
 * Get memories sorted by centrality (hubs first).
 */
export function sortByCentrality(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => b.centrality - a.centrality);
}
