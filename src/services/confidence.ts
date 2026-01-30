/**
 * Confidence Service - Cognitive Loop Architecture (v3)
 *
 * Implements the confidence model where memories are weighted bets:
 * - Confidence = survival rate under test (confirmations / exposures)
 * - Robustness = tier based on exposure history
 * - Score = similarity × confidence × centrality for search ranking
 */

import type {
  Memory,
  ConfidenceStats,
  Robustness,
  DamageLevel,
} from '../lib/shared/types/index.js';
import type { Config } from '../lib/config.js';

// ============================================
// Configuration
// ============================================

/** Default thresholds for robustness tiers (can be overridden via config) */
export const ROBUSTNESS_THRESHOLDS = {
  /** Below this many exposures = untested */
  UNTESTED_MAX_EXPOSURES: 3,
  /** Below this many exposures = brittle */
  BRITTLE_MAX_EXPOSURES: 10,
  /** Above this confidence = robust (when well-tested) */
  ROBUST_MIN_CONFIDENCE: 0.7,
} as const;

/** Get robustness thresholds from config or use defaults */
export function getRobustnessThresholds(config?: Config) {
  if (config?.robustness) {
    return {
      UNTESTED_MAX_EXPOSURES: config.robustness.untestedMaxExposures,
      BRITTLE_MAX_EXPOSURES: config.robustness.brittleMaxExposures,
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
} as const;

// ============================================
// Core Functions
// ============================================

/**
 * Calculate raw confidence from confirmations/exposures.
 * Confidence = confirmations / max(exposures, 1)
 *
 * A memory that has never been tested has 0 confidence.
 * A memory with 10 confirmations and 10 exposures has 1.0 confidence.
 */
export function getConfidence(memory: Memory): number {
  return memory.confirmations / Math.max(memory.exposures, 1);
}

/**
 * Determine robustness tier based on exposure history.
 *
 * - untested: < untestedMaxExposures (hasn't been tested enough)
 * - brittle: untestedMaxExposures - brittleMaxExposures (some testing, but could collapse)
 * - tested: > brittleMaxExposures but < robustMinConfidence
 * - robust: > brittleMaxExposures and >= robustMinConfidence
 *
 * @param memory - The memory to evaluate
 * @param config - Optional config for custom thresholds (uses defaults if not provided)
 */
export function getRobustness(memory: Memory, config?: Config): Robustness {
  const thresholds = getRobustnessThresholds(config);

  if (memory.exposures < thresholds.UNTESTED_MAX_EXPOSURES) {
    return 'untested';
  }

  if (memory.exposures < thresholds.BRITTLE_MAX_EXPOSURES) {
    return 'brittle';
  }

  const confidence = getConfidence(memory);
  return confidence >= thresholds.ROBUST_MIN_CONFIDENCE
    ? 'robust'
    : 'tested';
}

/**
 * Get full confidence statistics for a memory.
 *
 * @param memory - The memory to evaluate
 * @param config - Optional config for custom thresholds
 */
export function getConfidenceStats(memory: Memory, config?: Config): ConfidenceStats {
  return {
    confidence: getConfidence(memory),
    robustness: getRobustness(memory, config),
    exposures: memory.exposures,
    confirmations: memory.confirmations,
    centrality: memory.centrality,
    violation_count: memory.violations.length,
    exposure_check_status: memory.exposure_check_status,
    cascade_boosts: memory.cascade_boosts,
    cascade_damages: memory.cascade_damages,
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
 * Calculate search score combining similarity, confidence, and centrality.
 *
 * Formula: score = similarity × confidence × centralityFactor × robustnessBonus
 *
 * Where:
 * - similarity: from Vectorize (0-1)
 * - confidence: confirmations / exposures (0-1)
 * - centralityFactor: 1 + log(centrality + 1) × weight
 * - robustnessBonus: 1.2 if well-tested, 1.0 otherwise
 */
export function calculateScore(memory: Memory, similarity: number): number {
  const confidence = getConfidence(memory);
  const centralityFactor =
    1 + Math.log(memory.centrality + 1) * SCORING_WEIGHTS.CENTRALITY_WEIGHT;
  const robustnessBonus =
    memory.exposures >= ROBUSTNESS_THRESHOLDS.BRITTLE_MAX_EXPOSURES
      ? SCORING_WEIGHTS.ROBUSTNESS_BONUS
      : 1.0;

  return similarity * confidence * centralityFactor * robustnessBonus;
}

/**
 * Calculate score for a memory that has never been tested.
 * Uses a default confidence of 0.5 to not completely bury new content.
 */
export function calculateUntestedScore(
  memory: Memory,
  similarity: number
): number {
  const defaultConfidence = 0.5;
  const centralityFactor =
    1 + Math.log(memory.centrality + 1) * SCORING_WEIGHTS.CENTRALITY_WEIGHT;

  return similarity * defaultConfidence * centralityFactor;
}

/**
 * Smart scoring that handles untested memories appropriately.
 */
export function smartScore(memory: Memory, similarity: number): number {
  if (memory.exposures === 0) {
    return calculateUntestedScore(memory, similarity);
  }
  return calculateScore(memory, similarity);
}

// ============================================
// Analysis Helpers
// ============================================

/**
 * Check if a memory is "brittle" - high confidence but low exposures.
 * These are memories that look good but haven't been tested enough.
 *
 * @param memory - The memory to evaluate
 * @param options - Optional overrides for thresholds
 * @param config - Optional config for default thresholds
 */
export function isBrittle(
  memory: Memory,
  options: { maxExposures?: number; minConfidence?: number } = {},
  config?: Config
): boolean {
  const thresholds = getRobustnessThresholds(config);
  const maxExposures = options.maxExposures ?? thresholds.BRITTLE_MAX_EXPOSURES;
  const minConfidence = options.minConfidence ?? 0.5;

  if (memory.exposures >= maxExposures) {
    return false; // Well tested
  }

  if (memory.exposures === 0) {
    return true; // Never tested = brittle
  }

  const confidence = getConfidence(memory);
  return confidence >= minConfidence; // High confidence but low exposure
}

/**
 * Get a human-readable description of why a memory is brittle.
 */
export function getBrittleReason(memory: Memory): string {
  if (memory.exposures === 0) {
    return 'Never been tested against observations';
  }

  const confidence = getConfidence(memory);
  if (confidence >= 0.8) {
    return `High confidence (${(confidence * 100).toFixed(0)}%) but only ${memory.exposures} exposures`;
  }

  if (memory.exposures < 3) {
    return `Only tested ${memory.exposures} time(s)`;
  }

  return `Tested ${memory.exposures} times but confidence is ${(confidence * 100).toFixed(0)}%`;
}

/**
 * Check if a memory is "failing" - low confidence despite testing.
 */
export function isFailing(memory: Memory, minExposures = 5): boolean {
  if (memory.exposures < minExposures) {
    return false; // Not enough data
  }

  const confidence = getConfidence(memory);
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
  options?: { maxExposures?: number; minConfidence?: number }
): Memory[] {
  return memories.filter((m) => isBrittle(m, options));
}

/**
 * Filter memories to only include failing ones.
 */
export function filterFailing(
  memories: Memory[],
  minExposures = 5
): Memory[] {
  return memories.filter((m) => isFailing(m, minExposures));
}

/**
 * Get memories sorted by centrality (hubs first).
 */
export function sortByCentrality(memories: Memory[]): Memory[] {
  return [...memories].sort((a, b) => b.centrality - a.centrality);
}
