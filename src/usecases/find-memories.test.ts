import { describe, it, expect, vi } from 'vitest';
import { createMockD1 } from '../lib/shared/testing/d1-mock.js';
import { defaultConfig } from '../lib/config.js';
import { findMemories } from './find-memories.js';
import type { MemoryRow } from '../types/index.js';

vi.mock('../lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  searchSimilar: vi.fn().mockResolvedValue([
    { id: 'm1', similarity: 0.95 },
    { id: 'm2', similarity: 0.9 },
    { id: 'm3', similarity: 0.85 },
  ]),
}));

function row(id: string, content: string): MemoryRow {
  return {
    id,
    content,
    source: 'market',
    source_url: null,
    derived_from: null,
    assumes: null,
    invalidates_if: null,
    confirms_if: null,
    outcome_condition: null,
    resolves_by: null,
    starting_confidence: 0.7,
    confirmations: 2,
    times_tested: 3,
    contradictions: 0,
    centrality: 1,
    propagated_confidence: null,
    state: 'active',
    outcome: null,
    resolved_at: null,
    violations: '[]',
    retracted: 0,
    retracted_at: null,
    retraction_reason: null,
    surprise: null,
    exposure_check_status: 'completed',
    exposure_check_completed_at: null,
    agent_id: '_default',
    tags: null,
    obsidian_sources: null,
    session_id: null,
    created_at: Date.now(),
    updated_at: null,
  };
}

describe('findMemories', () => {
  it('uses bulk memory fetch (no per-result SELECT by id)', async () => {
    const db = createMockD1();
    db._setQueryResult('SELECT * FROM memories WHERE id IN (', {
      allResults: [
        row('m1', 'Memory one') as unknown as Record<string, unknown>,
        row('m2', 'Memory two') as unknown as Record<string, unknown>,
        row('m3', 'Memory three') as unknown as Record<string, unknown>,
      ],
    });

    const env = {
      DB: db as unknown as D1Database,
      AI: {},
      MEMORY_VECTORS: {},
      INVALIDATES_VECTORS: {},
      CONFIRMS_VECTORS: {},
      DETECTION_QUEUE: {},
    };

    const results = await findMemories(env as any, defaultConfig, {
      query: 'memory',
      limit: 2,
      minSimilarity: 0,
      requestId: 'req-1',
    });

    expect(results).toHaveLength(2);
    const executed = db._getExecutedQueries();
    expect(executed.some((q) => q.includes('SELECT * FROM memories WHERE id IN ('))).toBe(true);
    expect(executed.some((q) => q.includes('SELECT * FROM memories WHERE id = ?'))).toBe(false);
  });
});
