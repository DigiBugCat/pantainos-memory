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
 * Note: Uses internal shorthand for Vectorize - 'obs' for observation, 'thought' for derived
 */
export interface MemoryVectorMetadata {
  /** Internal type marker: 'obs' = observation (has source), 'thought' = derived (has derived_from) */
  type: 'obs' | 'thought';
  source?: string;
  has_invalidates_if: boolean;
  has_assumes?: boolean;
  has_confirms_if?: boolean;
  has_outcome?: boolean;
  /** Presence indicates time-bound thought */
  resolves_by?: number;
  /** Whether this is a time-bound thought */
  time_bound?: boolean;
}

/**
 * Metadata stored with condition embeddings.
 */
export interface ConditionVectorMetadata {
  /** The memory ID this condition belongs to */
  memory_id: string;
  /** Index of this condition in the array (for multiple conditions) */
  condition_index: number;
  /** The condition text (for debugging) */
  condition_text: string;
  /** Whether from a time-bound thought */
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
// Batch Embedding Generation
// ============================================

/** Result of generating all embeddings for a memory in parallel */
export interface AllEmbeddings {
  content: number[];
  invalidates: number[][];
  confirms: number[][];
}

/**
 * Generate all embeddings needed for a memory in a single parallel batch.
 * Content + all condition embeddings are generated concurrently via Promise.all.
 */
export async function generateAllEmbeddings(
  ai: Ai,
  config: Config,
  params: {
    content: string;
    invalidates_if?: string[];
    confirms_if?: string[];
    requestId?: string;
  }
): Promise<AllEmbeddings> {
  const tasks: Promise<number[]>[] = [
    generateEmbedding(ai, params.content, config, params.requestId),
  ];

  const invalidatesCount = params.invalidates_if?.length ?? 0;
  const confirmsCount = params.confirms_if?.length ?? 0;

  for (const condition of params.invalidates_if ?? []) {
    tasks.push(generateEmbedding(ai, condition, config, params.requestId));
  }
  for (const condition of params.confirms_if ?? []) {
    tasks.push(generateEmbedding(ai, condition, config, params.requestId));
  }

  const results = await Promise.all(tasks);

  return {
    content: results[0],
    invalidates: results.slice(1, 1 + invalidatesCount),
    confirms: results.slice(1 + invalidatesCount, 1 + invalidatesCount + confirmsCount),
  };
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
    embedding?: number[]; // Optional pre-computed embedding (for dedup optimization)
  }
): Promise<{ embedding: number[] }> {
  // Use pre-computed embedding or generate new one
  const embedding = params.embedding ?? await generateEmbedding(ai, params.content, config, params.requestId);

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
 * Store observation embeddings with conditions.
 * For observations that have invalidates_if or confirms_if:
 * - Content goes to MEMORY_VECTORS (with metadata indicating conditions exist)
 * - invalidates_if conditions go to INVALIDATES_VECTORS
 * - confirms_if conditions go to CONFIRMS_VECTORS
 */
export async function storeObservationWithConditions(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    id: string;
    content: string;
    source: string;
    invalidates_if?: string[];
    confirms_if?: string[];
    requestId?: string;
    embedding?: number[]; // Optional pre-computed embedding (for dedup optimization)
  }
): Promise<{
  embedding: number[];
  invalidatesEmbeddings: number[][];
  confirmsEmbeddings: number[][];
}> {
  const invalidatesEmbeddings: number[][] = [];
  const confirmsEmbeddings: number[][] = [];

  // Use pre-computed embedding or generate new one
  const embedding = params.embedding ?? await generateEmbedding(ai, params.content, config, params.requestId);

  // Store content in memory vectors with metadata indicating conditions
  await env.MEMORY_VECTORS.upsert([
    {
      id: params.id,
      values: embedding,
      metadata: {
        type: 'obs',
        source: params.source,
        has_invalidates_if: Boolean(params.invalidates_if?.length),
        has_confirms_if: Boolean(params.confirms_if?.length),
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
            condition_index: index,
            condition_text: condition,
            time_bound: false, // Observations are not time-bound
          } as any,
        };
      })
    );

    await env.INVALIDATES_VECTORS.upsert(conditionVectors as any);
  }

  // Store confirms_if conditions
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
            condition_index: index,
            condition_text: condition,
            time_bound: false, // Observations are not time-bound
          } as any,
        };
      })
    );

    await env.CONFIRMS_VECTORS.upsert(conditionVectors as any);
  }

  return { embedding, invalidatesEmbeddings, confirmsEmbeddings };
}

/**
 * Store thought embeddings (unified for all thoughts).
 * Content goes to memory table, conditions go to respective condition tables.
 *
 * Time-bound thoughts (has resolves_by) store confirms_if conditions.
 * General thoughts (no resolves_by) only store invalidates_if conditions.
 */
export async function storeThoughtEmbeddings(
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
    embedding?: number[]; // Optional pre-computed embedding (for dedup optimization)
  }
): Promise<{
  embedding: number[];
  invalidatesEmbeddings: number[][];
  confirmsEmbeddings: number[][];
}> {
  const invalidatesEmbeddings: number[][] = [];
  const confirmsEmbeddings: number[][] = [];
  const timeBound = params.resolves_by !== undefined;

  // Use pre-computed embedding or generate new one
  const embedding = params.embedding ?? await generateEmbedding(ai, params.content, config, params.requestId);

  // Store content in memory vectors
  await env.MEMORY_VECTORS.upsert([
    {
      id: params.id,
      values: embedding,
      metadata: {
        type: 'thought',
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
            condition_index: index,
            condition_text: condition,
            time_bound: timeBound,
          } as any,
        };
      })
    );

    await env.INVALIDATES_VECTORS.upsert(conditionVectors as any);
  }

  // Store confirms_if conditions (time-bound thoughts only)
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

// ============================================
// Search Operations
// ============================================

/** Candidate from condition search */
export interface ConditionCandidate {
  /** Composite ID (memory_id:type:index) */
  vector_id: string;
  /** The memory this condition belongs to */
  memory_id: string;
  /** Which condition in the array */
  condition_index: number;
  /** The condition text */
  condition_text: string;
  /** Similarity score */
  similarity: number;
  /** Whether from a time-bound thought */
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
        condition_index: meta.condition_index,
        condition_text: meta.condition_text,
        similarity: m.score,
      };
    });
}

/** Candidate from memory content search */
export interface MemoryCandidate {
  id: string;
  type: 'obs' | 'thought';
  similarity: number;
  source?: string;
  time_bound?: boolean;
}

/**
 * Search for observations that might violate a new thought.
 * Used for bi-directional checking: when creating thought, find existing obs that might violate it.
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

/**
 * Delete only condition vectors for a memory (invalidates_if + confirms_if).
 * Unlike deleteMemoryEmbeddings, this preserves the content vector in MEMORY_VECTORS
 * so the memory remains searchable. Called when a memory transitions to
 * violated/resolved/confirmed state to prevent future exposure check matches.
 */
export async function deleteConditionVectors(
  env: Env,
  memoryId: string,
  invalidatesCount: number = 10,
  confirmsCount: number = 10
): Promise<void> {
  const invalidateIds = Array.from({ length: invalidatesCount }, (_, i) => `${memoryId}:inv:${i}`);
  const confirmIds = Array.from({ length: confirmsCount }, (_, i) => `${memoryId}:conf:${i}`);

  if (invalidateIds.length > 0) {
    await env.INVALIDATES_VECTORS.deleteByIds(invalidateIds);
  }

  if (confirmIds.length > 0) {
    await env.CONFIRMS_VECTORS.deleteByIds(confirmIds);
  }
}

// ============================================
// Update Operations (for reclassification)
// ============================================

/**
 * Update embeddings when a memory's type changes.
 *
 * For observation → thought/prediction:
 * - Update MEMORY_VECTORS metadata to reflect new type
 * - Add condition embeddings to INVALIDATES_VECTORS and CONFIRMS_VECTORS
 *
 * For thought/prediction → observation:
 * - Update MEMORY_VECTORS metadata to reflect new type
 * - Delete condition embeddings from INVALIDATES_VECTORS and CONFIRMS_VECTORS
 */
export async function updateMemoryTypeEmbeddings(
  env: Env,
  ai: Ai,
  config: Config,
  params: {
    id: string;
    content: string;
    newType: 'observation' | 'thought' | 'prediction';
    // For observation:
    source?: string;
    // For thought/prediction:
    invalidates_if?: string[];
    confirms_if?: string[];
    resolves_by?: number;
    requestId?: string;
  }
): Promise<void> {
  // Generate embedding for content (needed for metadata update)
  const embedding = await generateEmbedding(ai, params.content, config, params.requestId);

  if (params.newType === 'observation') {
    // Converting to observation
    // 1. Update MEMORY_VECTORS with obs metadata
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

    // Delete any condition embeddings (try common indices - we don't know previous count during type conversion)
    const invalidateIds = Array.from({ length: 10 }, (_, i) => `${params.id}:inv:${i}`);
    const confirmIds = Array.from({ length: 10 }, (_, i) => `${params.id}:conf:${i}`);

    await env.INVALIDATES_VECTORS.deleteByIds(invalidateIds);
    await env.CONFIRMS_VECTORS.deleteByIds(confirmIds);
  } else {
    // Converting to thought
    const timeBound = params.resolves_by !== undefined;

    // 1. Update MEMORY_VECTORS with thought metadata
    await env.MEMORY_VECTORS.upsert([
      {
        id: params.id,
        values: embedding,
        metadata: {
          type: 'thought',
          has_invalidates_if: Boolean(params.invalidates_if?.length),
          has_confirms_if: Boolean(params.confirms_if?.length),
          has_outcome: timeBound,
          resolves_by: params.resolves_by,
          time_bound: timeBound,
        } as any,
      },
    ]);

    // 2. Add invalidates_if condition embeddings
    if (params.invalidates_if && params.invalidates_if.length > 0) {
      const conditionVectors = await Promise.all(
        params.invalidates_if.map(async (condition, index) => {
          const condEmbedding = await generateEmbedding(ai, condition, config, params.requestId);
          return {
            id: `${params.id}:inv:${index}`,
            values: condEmbedding,
            metadata: {
              memory_id: params.id,
              condition_index: index,
              condition_text: condition,
              time_bound: timeBound,
            } as any,
          };
        })
      );

      await env.INVALIDATES_VECTORS.upsert(conditionVectors as any);
    }

    // 3. Add confirms_if condition embeddings (time-bound only)
    if (params.confirms_if && params.confirms_if.length > 0) {
      const conditionVectors = await Promise.all(
        params.confirms_if.map(async (condition, index) => {
          const condEmbedding = await generateEmbedding(ai, condition, config, params.requestId);
          return {
            id: `${params.id}:conf:${index}`,
            values: condEmbedding,
            metadata: {
              memory_id: params.id,
              condition_index: index,
              condition_text: condition,
              time_bound: true,
            } as any,
          };
        })
      );

      await env.CONFIRMS_VECTORS.upsert(conditionVectors as any);
    }
  }
}
