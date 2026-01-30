/**
 * Vectorize mock helpers for testing
 *
 * Provides a mock VectorizeIndex for unit testing workers that use Cloudflare Vectorize.
 * Uses an in-memory Map to store vectors and supports query, upsert, and delete operations.
 */
import { vi } from 'vitest';

interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
  namespace?: string;
}

interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, unknown>;
}

interface VectorizeQueryOptions {
  topK?: number;
  filter?: Record<string, unknown>;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  namespace?: string;
}

interface VectorizeQueryResult {
  count: number;
  matches: VectorizeMatch[];
}

interface VectorizeMutationResult {
  count: number;
  ids: string[];
}

// Use simplified types that work with vitest mocks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = ReturnType<typeof vi.fn> & ((...args: any[]) => any);

export interface MockVectorizeIndex {
  // Standard Vectorize methods
  query: AnyMock;
  upsert: AnyMock;
  insert: AnyMock;
  deleteByIds: AnyMock;
  getByIds: AnyMock;
  describe: AnyMock;

  // Test helpers
  _vectors: Map<string, VectorizeVector>;
  _getVector: (id: string) => VectorizeVector | undefined;
  _setVectors: (vectors: VectorizeVector[]) => void;
  _clear: () => void;
  _setQueryResults: (results: VectorizeMatch[]) => void;
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Creates a mock VectorizeIndex for testing.
 *
 * @param options Configuration options
 * @param options.useRealSimilarity If true, calculates actual cosine similarity (default: true)
 * @returns MockVectorizeIndex with helper methods for testing
 */
export function createMockVectorize(
  options: { useRealSimilarity?: boolean } = {}
): MockVectorizeIndex {
  const { useRealSimilarity = true } = options;
  const storage = new Map<string, VectorizeVector>();
  let overrideResults: VectorizeMatch[] | null = null;

  const mockIndex: MockVectorizeIndex = {
    query: vi
      .fn()
      .mockImplementation(
        async (
          vector: number[],
          opts: VectorizeQueryOptions = {}
        ): Promise<VectorizeQueryResult> => {
          const { topK = 10, returnValues = false, returnMetadata = 'none' } = opts;

          // Return override results if set
          if (overrideResults !== null) {
            const results = overrideResults.slice(0, topK);
            return { count: results.length, matches: results };
          }

          // Calculate similarity against all stored vectors
          const matches: VectorizeMatch[] = [];

          for (const [id, stored] of storage) {
            const score = useRealSimilarity
              ? cosineSimilarity(vector, stored.values)
              : 0.8; // Default mock score

            const match: VectorizeMatch = { id, score };

            if (returnValues) {
              match.values = stored.values;
            }

            if (returnMetadata !== 'none' && stored.metadata) {
              match.metadata = stored.metadata;
            }

            matches.push(match);
          }

          // Sort by score descending and take topK
          matches.sort((a, b) => b.score - a.score);
          const topMatches = matches.slice(0, topK);

          return { count: topMatches.length, matches: topMatches };
        }
      ),

    upsert: vi
      .fn()
      .mockImplementation(
        async (vectors: VectorizeVector[]): Promise<VectorizeMutationResult> => {
          const ids: string[] = [];

          for (const vec of vectors) {
            storage.set(vec.id, { ...vec });
            ids.push(vec.id);
          }

          return { count: ids.length, ids };
        }
      ),

    insert: vi
      .fn()
      .mockImplementation(
        async (vectors: VectorizeVector[]): Promise<VectorizeMutationResult> => {
          const ids: string[] = [];

          for (const vec of vectors) {
            if (!storage.has(vec.id)) {
              storage.set(vec.id, { ...vec });
              ids.push(vec.id);
            }
          }

          return { count: ids.length, ids };
        }
      ),

    deleteByIds: vi
      .fn()
      .mockImplementation(
        async (ids: string[]): Promise<VectorizeMutationResult> => {
          const deletedIds: string[] = [];

          for (const id of ids) {
            if (storage.delete(id)) {
              deletedIds.push(id);
            }
          }

          return { count: deletedIds.length, ids: deletedIds };
        }
      ),

    getByIds: vi.fn().mockImplementation(async (ids: string[]): Promise<VectorizeVector[]> => {
      const results: VectorizeVector[] = [];

      for (const id of ids) {
        const vec = storage.get(id);
        if (vec) {
          results.push({ ...vec });
        }
      }

      return results;
    }),

    describe: vi.fn().mockResolvedValue({
      dimensions: 768, // Default for embeddinggemma-300m
      count: storage.size,
      description: 'Mock Vectorize Index',
    }),

    // Test helpers
    _vectors: storage,

    _getVector: (id: string) => storage.get(id),

    _setVectors: (vectors: VectorizeVector[]) => {
      for (const vec of vectors) {
        storage.set(vec.id, { ...vec });
      }
    },

    _clear: () => {
      storage.clear();
      overrideResults = null;
    },

    _setQueryResults: (results: VectorizeMatch[]) => {
      overrideResults = results;
    },
  };

  return mockIndex;
}

/**
 * Creates a simple embedding for testing purposes.
 * Generates a deterministic embedding based on the input text hash.
 *
 * @param text Text to generate embedding for
 * @param dimensions Number of dimensions (default: 768 for embeddinggemma-300m)
 * @returns A normalized vector of the specified dimensions
 */
export function createTestEmbedding(text: string, dimensions: number = 768): number[] {
  // Create deterministic values based on text hash
  const values: number[] = [];
  let hash = 0;

  // Simple string hash
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }

  // Generate pseudo-random values from hash
  for (let i = 0; i < dimensions; i++) {
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    hash ^= hash >>> 16;
    values.push((hash % 1000) / 1000);
  }

  // Normalize the vector
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / norm);
}
