import type { Config } from '../lib/config.js';
import type { Env, Memory, MemoryRow, ScoredMemory } from '../types/index.js';
import { generateEmbedding, searchSimilar } from '../lib/embeddings.js';
import { rowToMemory } from '../lib/transforms.js';
import { createScoredMemory } from '../lib/scoring.js';
import { fetchMemoriesByIds } from '../lib/sql-utils.js';

export interface FindMemoriesOptions {
  query: string;
  limit: number;
  minSimilarity: number;
  includeRetracted?: boolean;
  requestId?: string;
  candidateMultiplier?: number;
  maxTimesTested?: number;
  /** Agent IDs to include in results. If undefined, no agent filtering. */
  agentIds?: string[];
  filter?: (row: MemoryRow, memory: Memory) => boolean;
}

export async function findMemories(
  env: Env,
  config: Config,
  options: FindMemoriesOptions
): Promise<ScoredMemory[]> {
  const {
    query,
    limit,
    minSimilarity,
    includeRetracted = false,
    requestId,
    candidateMultiplier = 2,
    maxTimesTested,
    agentIds,
    filter,
  } = options;

  const queryEmbedding = await generateEmbedding(env.AI, query, config, requestId);
  const searchResults = await searchSimilar(
    env,
    queryEmbedding,
    limit * candidateMultiplier,
    minSimilarity,
    requestId
  );

  const candidateIds = searchResults.map((m) => m.id);
  const candidateRows = await fetchMemoriesByIds<MemoryRow>(env.DB, candidateIds, { includeRetracted });
  const byId = new Map(candidateRows.map((row) => [row.id, row]));

  const results: ScoredMemory[] = [];
  for (const match of searchResults) {
    if (results.length >= limit) break;
    const row = byId.get(match.id);
    if (!row) continue;

    if (agentIds && !agentIds.includes(row.agent_id)) continue;
    const memory = rowToMemory(row);
    if (filter && !filter(row, memory)) continue;

    results.push(createScoredMemory(memory, match.similarity, config, maxTimesTested));
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
