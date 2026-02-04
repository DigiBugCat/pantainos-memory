/**
 * Scoring Module - Unified Thought Model (v4)
 *
 * New scoring formula using Subjective Logic:
 *   score = similarity × (1 + effective_confidence × BOOST_WEIGHT)
 *
 * Where:
 * - effective_confidence = blend of starting_confidence + earned evidence
 * - BOOST_WEIGHT = 0.5 (configurable)
 *
 * Key change: Similarity drives ranking, confidence provides boost.
 * Untested memories use their starting_confidence (prior), not 0.
 */

import type { Memory, ScoredMemory } from './shared/types/index.js';
import {
  getEffectiveConfidence,
  getRobustness,
  SCORING_WEIGHTS,
  DEFAULT_MAX_TIMES_TESTED,
} from '../services/confidence.js';
import type { Config } from './config.js';

/**
 * Calculate final score for a memory based on similarity and confidence model.
 *
 * New Formula: similarity × (1 + effective_confidence × BOOST_WEIGHT)
 *
 * @param similarity - Vectorize similarity score (0-1)
 * @param memory - The memory to score
 * @param _config - Optional config (reserved for future use)
 * @param maxTimesTested - Global max for normalization (from system_stats)
 */
export function calculateScore(
  similarity: number,
  memory: Memory,
  _config?: Config,
  maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED
): number {
  const effective = getEffectiveConfidence(memory, maxTimesTested);

  // New formula: similarity with confidence boost
  return similarity * (1 + effective * SCORING_WEIGHTS.CONFIDENCE_BOOST_WEIGHT);
}

/**
 * Sort search results by calculated score.
 * Returns results with score and confidence metadata.
 */
export function rankResults<T extends { similarity: number; memory: Memory }>(
  results: T[],
  config?: Config,
  maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED
): (T & { score: number; confidence: number })[] {
  return results
    .map(r => ({
      ...r,
      score: calculateScore(r.similarity, r.memory, config, maxTimesTested),
      confidence: getEffectiveConfidence(r.memory, maxTimesTested),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Create a ScoredMemory from a Memory and similarity.
 */
export function createScoredMemory(
  memory: Memory,
  similarity: number,
  config?: Config,
  maxTimesTested: number = DEFAULT_MAX_TIMES_TESTED
): ScoredMemory {
  const confidence = getEffectiveConfidence(memory, maxTimesTested);
  const robustness = getRobustness(memory, config);
  const score = calculateScore(similarity, memory, config, maxTimesTested);

  return {
    memory,
    similarity,
    score,
    confidence,
    robustness,
  };
}
