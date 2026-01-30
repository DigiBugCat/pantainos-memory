/**
 * Scoring Module - Cognitive Loop Architecture (v3)
 *
 * New scoring formula based on confidence model:
 *   score = similarity × confidence × centralityBonus × robustnessBonus
 *
 * Where:
 * - confidence = confirmations / max(exposures, 1)
 * - centralityBonus = 1 + log(centrality + 1) × 0.1
 * - robustnessBonus = 1.2 if exposures > 10, else 1.0
 */

import type { Memory, ScoredMemory } from './shared/types/index.js';
import { getConfidence, getRobustness } from '../services/confidence.js';
import type { Config } from './config.js';

/**
 * Calculate centrality bonus based on how many memories depend on this one.
 * More dependents = more valuable if damaged.
 */
function calculateCentralityBonus(centrality: number): number {
  // Log scale to prevent extreme values
  return 1 + Math.log(centrality + 1) * 0.1;
}

/**
 * Calculate robustness bonus - well-tested memories deserve boost.
 */
function calculateRobustnessBonus(memory: Memory): number {
  const robustness = getRobustness(memory);
  return robustness === 'robust' ? 1.2 : 1.0;
}

/**
 * Calculate final score for a memory based on similarity and confidence model.
 *
 * Formula: similarity × confidence × centralityBonus × robustnessBonus
 */
export function calculateScore(
  similarity: number,
  memory: Memory,
  _config?: Config
): number {
  const confidence = getConfidence(memory);
  const centralityBonus = calculateCentralityBonus(memory.centrality);
  const robustnessBonus = calculateRobustnessBonus(memory);

  return similarity * confidence * centralityBonus * robustnessBonus;
}

/**
 * Sort search results by calculated score.
 * Returns results with score and confidence metadata.
 */
export function rankResults<T extends { similarity: number; memory: Memory }>(
  results: T[],
  config?: Config
): (T & { score: number; confidence: number })[] {
  return results
    .map(r => ({
      ...r,
      score: calculateScore(r.similarity, r.memory, config),
      confidence: getConfidence(r.memory),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Create a ScoredMemory from a Memory and similarity.
 */
export function createScoredMemory(
  memory: Memory,
  similarity: number,
  config?: Config
): ScoredMemory {
  const confidence = getConfidence(memory);
  const robustness = getRobustness(memory);
  const score = calculateScore(similarity, memory, config);

  return {
    memory,
    similarity,
    score,
    confidence,
    robustness,
  };
}
