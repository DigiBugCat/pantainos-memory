/**
 * Embedding Tables Service - Three-Table Architecture
 *
 * Manages embeddings across three separate Vectorize indexes:
 *
 * 1. MEMORY_VECTORS - Memory content embeddings
 *    - Used for: Finding observations when checking new claims
 *    - Contains: All memory content (obs, infer, pred)
 *
 * 2. INVALIDATES_VECTORS - Invalidation condition embeddings
 *    - Used for: Finding predictions an observation might break
 *    - Contains: invalidates_if conditions from infer/pred
 *    - Key insight: "AAPL dropped to $145" might not be close to
 *      "Apple is in bullish trend" but IS close to "AAPL drops below $150"
 *
 * 3. CONFIRMS_VECTORS - Confirmation condition embeddings
 *    - Used for: Finding predictions an observation might support
 *    - Contains: confirms_if conditions from pred
 *
 * Why separate tables?
 * Conditions are the semantic bridge. The observation content might not
 * match the prediction content semantically, but it WILL match the
 * conditions that would violate or confirm the prediction.
 */

import type { Env } from '../types/index.js';
import type { Config } from '../lib/config.js';
import { generateEmbedding } from '../lib/embeddings.js';

// ============================================
// Types
// ============================================

/**
 * Metadata stored with memory content embeddings.
 */
export interface MemoryVectorMetadata {
  type: 'obs' | 'assumption';
  source?: string;
  has_invalidates_if: boolean;
  has_assumes?: boolean;
  has_confirms_if?: boolean;
  has_outcome?: boolean;
  /** Presence indicates time-bound assumption */
  resolves_by?: number;
  /** Whether this is a time-bound assumption */
  time_bound?: boolean;
}

/**
 * Metadata stored with condition embeddings.
 */
export interface ConditionVectorMetadata {
  /** The memory ID this condition belongs to */
  memory_id: string;
  /** Type of memory ('assumption') */
  memory_type: 'assumption';
  /** Index of this condition in the array (for multiple conditions) */
  condition_index: number;
  /** The condition text (for debugging) */
  condition_text: string;
  /** Whether from a time-bound assumption */
  time_bound?: boolean;
}

/** Result of storing embeddings */
export interface EmbeddingStoreResult {
  memory_id: string;
  content_stored: boolean;
  invalidates_if_stored: number;
  confirms_if_stored: number;
}

// ============================================
// Store Operations
// ============================================

/**
 * Store observation embeddings.
 * Observations only go into the memory content table.
 */
export async function storeObservationEmbeddings(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    id: string;
    content: string;
    source: string;
    requestId?: string;
  }
): Promise<{ embedding: number[] }> {
  // Generate embedding for content
  const embedding = await generateEmbedding(ai, params.content, config, params.requestId);

  // Store in memory vectors
  // Note: Using 'as any' for Vectorize metadata type compatibility
  await env.MEMORY_VECTORS.upsert([
    {
      id: params.id,
      values: embedding,
      metadata: {
        type: 'obs',
        source: params.source,
        has_invalidates_if: false,
      } as any,
    },
  ]);

  return { embedding };
}

/**
 * Store assumption embeddings (unified for all assumptions).
 * Content goes to memory table, conditions go to respective condition tables.
 *
 * Time-bound assumptions (has resolves_by) store confirms_if conditions.
 * General assumptions (no resolves_by) only store invalidates_if conditions.
 */
export async function storeAssumptionEmbeddings(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    id: string;
    content: string;
    invalidates_if?: string[];
    confirms_if?: string[];
    assumes?: string[];
    resolves_by?: number;
    requestId?: string;
  }
): Promise<{
  embedding: number[];
  invalidatesEmbeddings: number[][];
  confirmsEmbeddings: number[][];
}> {
  const invalidatesEmbeddings: number[][] = [];
  const confirmsEmbeddings: number[][] = [];
  const timeBound = params.resolves_by !== undefined;

  // Generate embedding for content
  const embedding = await generateEmbedding(ai, params.content, config, params.requestId);

  // Store content in memory vectors
  await env.MEMORY_VECTORS.upsert([
    {
      id: params.id,
      values: embedding,
      metadata: {
        type: 'assumption',
        has_invalidates_if: Boolean(params.invalidates_if?.length),
        has_assumes: Boolean(params.assumes?.length),
        has_confirms_if: Boolean(params.confirms_if?.length),
        has_outcome: timeBound,
        resolves_by: params.resolves_by,
        time_bound: timeBound,
      } as any,
    },
  ]);

  // Store invalidates_if conditions
  if (params.invalidates_if && params.invalidates_if.length > 0) {
    const conditionVectors = await Promise.all(
      params.invalidates_if.map(async (condition, index) => {
        const condEmbedding = await generateEmbedding(ai, condition, config, params.requestId);
        invalidatesEmbeddings.push(condEmbedding);
        return {
          id: `${params.id}:inv:${index}`,
          values: condEmbedding,
          metadata: {
            memory_id: params.id,
            memory_type: 'assumption',
            condition_index: index,
            condition_text: condition,
            time_bound: timeBound,
          } as any,
        };
      })
    );

    await env.INVALIDATES_VECTORS.upsert(conditionVectors as any);
  }

  // Store confirms_if conditions (time-bound assumptions only)
  if (params.confirms_if && params.confirms_if.length > 0) {
    const conditionVectors = await Promise.all(
      params.confirms_if.map(async (condition, index) => {
        const condEmbedding = await generateEmbedding(ai, condition, config, params.requestId);
        confirmsEmbeddings.push(condEmbedding);
        return {
          id: `${params.id}:conf:${index}`,
          values: condEmbedding,
          metadata: {
            memory_id: params.id,
            memory_type: 'assumption',
            condition_index: index,
            condition_text: condition,
            time_bound: true,
          } as any,
        };
      })
    );

    await env.CONFIRMS_VECTORS.upsert(conditionVectors as any);
  }

  return { embedding, invalidatesEmbeddings, confirmsEmbeddings };
}

/**
 * @deprecated Use storeAssumptionEmbeddings - kept for migration compatibility
 */
export async function storeInferenceEmbeddings(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    id: string;
    content: string;
    invalidates_if?: string[];
    assumes?: string[];
    requestId?: string;
  }
): Promise<{ embedding: number[]; conditionEmbeddings: number[][] }> {
  const result = await storeAssumptionEmbeddings(env, ai, config, params);
  return { embedding: result.embedding, conditionEmbeddings: result.invalidatesEmbeddings };
}

/**
 * @deprecated Use storeAssumptionEmbeddings with resolves_by - kept for migration compatibility
 */
export async function storePredictionEmbeddings(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    id: string;
    content: string;
    invalidates_if?: string[];
    confirms_if?: string[];
    assumes?: string[];
    resolves_by: number;
    requestId?: string;
  }
): Promise<{
  embedding: number[];
  invalidatesEmbeddings: number[][];
  confirmsEmbeddings: number[][];
}> {
  return storeAssumptionEmbeddings(env, ai, config, params);
}

// ============================================
// Search Operations
// ============================================

/** Candidate from condition search */
export interface ConditionCandidate {
  /** Composite ID (memory_id:type:index) */
  vector_id: string;
  /** The memory this condition belongs to */
  memory_id: string;
  /** Type of memory */
  memory_type: 'assumption';
  /** Which condition in the array */
  condition_index: number;
  /** The condition text */
  condition_text: string;
  /** Similarity score */
  similarity: number;
  /** Whether from a time-bound assumption */
  time_bound?: boolean;
}

/**
 * Search for invalidates_if conditions that an observation might match.
 * Used when a new observation is created to find predictions it might violate.
 */
export async function searchInvalidatesConditions(
  env: Env,
  observationEmbedding: number[],
  topK: number = 20,
  minSimilarity: number = 0.5
): Promise<ConditionCandidate[]> {
  const results = await env.INVALIDATES_VECTORS.query(observationEmbedding, {
    topK,
    returnMetadata: 'all',
  });

  if (!results.matches) {
    return [];
  }

  return results.matches
    .filter((m) => m.score >= minSimilarity)
    .map((m) => {
      const meta = m.metadata as unknown as ConditionVectorMetadata;
      return {
        vector_id: m.id,
        memory_id: meta.memory_id,
        memory_type: meta.memory_type,
        condition_index: meta.condition_index,
        condition_text: meta.condition_text,
        similarity: m.score,
      };
    });
}

/**
 * Search for confirms_if conditions that an observation might match.
 * Used when a new observation is created to find predictions it might confirm.
 */
export async function searchConfirmsConditions(
  env: Env,
  observationEmbedding: number[],
  topK: number = 20,
  minSimilarity: number = 0.5
): Promise<ConditionCandidate[]> {
  const results = await env.CONFIRMS_VECTORS.query(observationEmbedding, {
    topK,
    returnMetadata: 'all',
  });

  if (!results.matches) {
    return [];
  }

  return results.matches
    .filter((m) => m.score >= minSimilarity)
    .map((m) => {
      const meta = m.metadata as unknown as ConditionVectorMetadata;
      return {
        vector_id: m.id,
        memory_id: meta.memory_id,
        memory_type: meta.memory_type,
        condition_index: meta.condition_index,
        condition_text: meta.condition_text,
        similarity: m.score,
      };
    });
}

/** Candidate from memory content search */
export interface MemoryCandidate {
  id: string;
  type: 'obs' | 'assumption';
  similarity: number;
  source?: string;
  time_bound?: boolean;
}

/**
 * Search for observations that might violate a new assumption.
 * Used for bi-directional checking: when creating assumption, find existing obs that might violate it.
 */
export async function searchObservationsForViolation(
  env: Env,
  conditionEmbedding: number[],
  topK: number = 20,
  minSimilarity: number = 0.5
): Promise<MemoryCandidate[]> {
  const results = await env.MEMORY_VECTORS.query(conditionEmbedding, {
    topK,
    returnMetadata: 'all',
    filter: {
      type: 'obs',
    },
  });

  if (!results.matches) {
    return [];
  }

  return results.matches
    .filter((m) => m.score >= minSimilarity)
    .map((m) => {
      const meta = m.metadata as unknown as MemoryVectorMetadata;
      return {
        id: m.id,
        type: meta.type,
        similarity: m.score,
        source: meta.source,
      };
    });
}

// ============================================
// Delete Operations
// ============================================

/**
 * Delete all embeddings for a memory.
 * Removes content and all condition embeddings.
 */
export async function deleteMemoryEmbeddings(
  env: Env,
  memoryId: string,
  invalidatesCount: number = 10,
  confirmsCount: number = 10
): Promise<void> {
  // Delete content embedding
  await env.MEMORY_VECTORS.deleteByIds([memoryId]);

  // Delete condition embeddings (try all possible indices)
  const invalidateIds = Array.from({ length: invalidatesCount }, (_, i) => `${memoryId}:inv:${i}`);
  const confirmIds = Array.from({ length: confirmsCount }, (_, i) => `${memoryId}:conf:${i}`);

  if (invalidateIds.length > 0) {
    await env.INVALIDATES_VECTORS.deleteByIds(invalidateIds);
  }

  if (confirmIds.length > 0) {
    await env.CONFIRMS_VECTORS.deleteByIds(confirmIds);
  }
}
