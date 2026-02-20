/**
 * Surprise Score Service — Predictive Coding Prediction Error
 *
 * Computes how much a new memory deviates from the knowledge graph's
 * existing expectations. Based on predictive coding principles:
 *
 * - The closest existing memory IS the system's best "prediction" for this topic
 * - surprise = 1 - weighted_avg_similarity (weighted by neighbor confidence)
 * - High surprise = the system didn't see this coming = high prediction error
 * - Low surprise = the system already expected this
 *
 * Confidence-weighted: errors against confident, well-tested beliefs are
 * more informative than deviations from untested guesses (precision-weighted
 * prediction errors from predictive coding theory).
 *
 * Performance: One Vectorize query + one small D1 batch. No LLM calls.
 */

import type { Env, MemoryRow } from '../types/index.js';
import type { Memory } from '../lib/shared/types/index.js';
import { rowToMemory } from '../lib/transforms.js';
import { createLazyLogger } from '../lib/lazy-logger.js';

const getLog = createLazyLogger('Surprise', 'surprise-init');

/** Minimal fields needed for confidence-weighted surprise */
interface NeighborConfidenceRow {
  id: string;
  starting_confidence: number;
  confirmations: number;
  times_tested: number;
  propagated_confidence: number | null;
}

/** Default max_times_tested if not available */
const DEFAULT_MAX_TIMES_TESTED = 10;

/** Structural integration context — derived from memory row fields.
 * When provided, surprise decays as a memory becomes more connected. */
export interface StructuralContext {
  /** Count of incoming derived_from edges (pre-computed on memory row) */
  centrality: number;
  /** Number of times this memory has been tested against observations */
  times_tested: number;
}

/** Controls how aggressively structural integration decays surprise.
 * At k=0.1, a memory with depth=10 has its surprise halved. */
const STRUCTURAL_DECAY_K = 0.1;

/**
 * Compute effective confidence for a neighbor (inline, avoids importing full Memory type).
 * Mirrors getEffectiveConfidence from confidence.ts but works on raw rows.
 */
function neighborEffectiveConfidence(row: NeighborConfidenceRow, maxTimesTested: number): number {
  const evidenceWeight = Math.log(row.times_tested + 1) / Math.log(maxTimesTested + 1);
  const earned = row.confirmations / Math.max(row.times_tested, 1);
  const local = row.starting_confidence * (1 - evidenceWeight) + earned * evidenceWeight;
  const clampedLocal = Math.max(0, Math.min(1, local));

  if (row.propagated_confidence != null) {
    return Math.max(0, Math.min(1, 0.6 * row.propagated_confidence + 0.4 * clampedLocal));
  }

  return clampedLocal;
}

/**
 * Compute surprise score for a memory based on its embedding.
 *
 * Algorithm:
 * 1. Query MEMORY_VECTORS for top-5 most similar existing memories (excluding self)
 * 2. Fetch confidence for those neighbors
 * 3. Compute confidence-weighted average similarity
 * 4. surprise = 1 - weighted_avg_similarity
 *
 * @returns Surprise score between 0 and 1 (higher = more novel)
 */
export async function computeSurprise(
  env: Env,
  memoryId: string,
  embedding: number[],
  structural?: StructuralContext,
): Promise<number> {
  // Query top-6 (self might be in results since it was just upserted)
  const results = await env.MEMORY_VECTORS.query(embedding, {
    topK: 6,
    returnMetadata: 'none',
  });

  // Exclude self from neighbors
  const neighbors = results.matches.filter(m => m.id !== memoryId);
  if (neighbors.length === 0) {
    getLog().debug('surprise_no_neighbors', { memory_id: memoryId });
    return 1.0; // Maximally novel — nothing similar exists
  }

  const topN = neighbors.slice(0, 5);
  const ids = topN.map(n => n.id);

  // Fetch confidence data for neighbors (single batch query)
  const placeholders = ids.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, starting_confidence, confirmations, times_tested, propagated_confidence
     FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
  ).bind(...ids).all<NeighborConfidenceRow>();

  const confidenceMap = new Map<string, number>();
  if (rows.results) {
    // Get max_times_tested for normalization (quick single query)
    const statsRow = await env.DB.prepare(
      `SELECT value FROM system_stats WHERE key = 'max_times_tested'`
    ).first<{ value: number }>();
    const maxTimesTested = statsRow?.value ?? DEFAULT_MAX_TIMES_TESTED;

    for (const row of rows.results) {
      confidenceMap.set(row.id, neighborEffectiveConfidence(row, maxTimesTested));
    }
  }

  // Confidence-weighted average similarity
  let weightedSum = 0;
  let totalWeight = 0;

  for (const neighbor of topN) {
    // Default confidence of 0.5 for neighbors not found in DB (shouldn't happen but safe)
    const confidence = confidenceMap.get(neighbor.id) ?? 0.5;
    // Weight = confidence (higher confidence neighbors have more say)
    const weight = Math.max(confidence, 0.1); // Floor at 0.1 to avoid zero-weight
    weightedSum += neighbor.score * weight;
    totalWeight += weight;
  }

  const weightedAvgSimilarity = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const rawSurprise = 1 - weightedAvgSimilarity;

  // Apply structural integration decay: connected memories are less surprising
  let surprise = rawSurprise;
  if (structural) {
    const depth = structural.centrality + structural.times_tested;
    surprise = rawSurprise * (1 / (1 + STRUCTURAL_DECAY_K * depth));
  }

  getLog().debug('surprise_computed', {
    memory_id: memoryId,
    neighbor_count: topN.length,
    weighted_avg_similarity: weightedAvgSimilarity,
    raw_surprise: rawSurprise,
    structural_depth: structural ? structural.centrality + structural.times_tested : 0,
    surprise,
  });

  return Math.max(0, Math.min(1, surprise));
}

/** Result from findMostSurprising with revalidation metadata */
export interface SurprisingMemory {
  memory: Memory;
  surprise: number;
  stale: boolean; // true if stored surprise differed from recomputed
  structural_depth: number; // centrality + times_tested at revalidation time
}

/**
 * Find the most surprising memories with live revalidation.
 *
 * Stored surprise is a cheap index for candidate selection, but the graph
 * evolves over time. This function:
 * 1. Fetches candidates from DB ordered by stored surprise
 * 2. Retrieves their embeddings via MEMORY_VECTORS.getByIds()
 * 3. Recomputes surprise against the current graph (parallel)
 * 4. Discards candidates that fall below minSurprise
 * 5. Backfills with more candidates if too few survive
 * 6. Fire-and-forget updates stale stored values
 *
 * @param env - Worker environment bindings
 * @param limit - Max results to return (default 10)
 * @param minSurprise - Minimum recomputed surprise threshold (default 0.3)
 */
export async function findMostSurprising(
  env: Env,
  limit: number = 10,
  minSurprise: number = 0.3,
): Promise<SurprisingMemory[]> {
  const log = getLog();
  const results: SurprisingMemory[] = [];
  const seenIds = new Set<string>();
  let offset = 0;
  const batchSize = limit * 2; // Fetch 2x buffer for revalidation losses
  const maxPages = 3; // Safety cap: don't scan the entire DB

  for (let page = 0; page < maxPages && results.length < limit; page++) {
    // 1. Fetch candidates by stored surprise (descending)
    const candidates = await env.DB.prepare(
      `SELECT * FROM memories
       WHERE retracted = 0 AND surprise IS NOT NULL AND state = 'active'
       ORDER BY surprise DESC
       LIMIT ? OFFSET ?`
    ).bind(batchSize, offset).all<MemoryRow>();

    if (!candidates.results || candidates.results.length === 0) break;
    offset += candidates.results.length;

    // Deduplicate (shouldn't happen but safe)
    const newCandidates = candidates.results.filter(r => !seenIds.has(r.id));
    for (const r of newCandidates) seenIds.add(r.id);

    if (newCandidates.length === 0) break;

    // 2. Retrieve stored embeddings for all candidates in one call
    const ids = newCandidates.map(r => r.id);
    const vectors = await env.MEMORY_VECTORS.getByIds(ids);

    // Build id → embedding map (convert typed arrays to number[])
    const embeddingMap = new Map<string, number[]>();
    for (const vec of vectors) {
      if (vec.values && vec.values.length > 0) {
        embeddingMap.set(vec.id, Array.isArray(vec.values) ? vec.values : [...vec.values] as number[]);
      }
    }

    // 3. Recompute surprise in parallel for all candidates with embeddings
    const recomputeResults = await Promise.all(
      newCandidates.map(async (row): Promise<{ row: MemoryRow; surprise: number; stale: boolean } | null> => {
        const embedding = embeddingMap.get(row.id);
        if (!embedding) {
          log.warn('surprise_missing_embedding', { memory_id: row.id });
          return null;
        }

        const fresh = await computeSurprise(env, row.id, embedding, {
          centrality: row.centrality,
          times_tested: row.times_tested,
        });
        const storedSurprise = row.surprise ?? 0;
        const stale = Math.abs(fresh - storedSurprise) > 0.05;

        return { row, surprise: fresh, stale };
      })
    );

    // 4. Filter by minSurprise, collect stale updates
    const staleUpdates: Array<{ id: string; surprise: number }> = [];

    for (const result of recomputeResults) {
      if (!result) continue;

      // Update stale stored values
      if (result.stale) {
        staleUpdates.push({ id: result.row.id, surprise: result.surprise });
      }

      // Only include if recomputed surprise meets threshold
      if (result.surprise >= minSurprise && results.length < limit) {
        const memory = rowToMemory(result.row);
        // Update the memory object's surprise to the fresh value
        (memory as Memory & { surprise: number }).surprise = result.surprise;
        results.push({
          memory,
          surprise: result.surprise,
          stale: result.stale,
          structural_depth: result.row.centrality + result.row.times_tested,
        });
      }
    }

    // 5. Fire-and-forget: batch update stale surprise values in D1
    if (staleUpdates.length > 0) {
      const now = Date.now();
      const stmts = staleUpdates.map(u =>
        env.DB.prepare('UPDATE memories SET surprise = ?, updated_at = ? WHERE id = ?')
          .bind(u.surprise, now, u.id)
      );
      env.DB.batch(stmts).catch(err => {
        log.warn('surprise_stale_update_failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  log.debug('find_most_surprising', {
    requested: limit,
    returned: results.length,
    scanned: seenIds.size,
  });

  return results;
}
