import { describe, it, expect } from 'vitest';
import { createMockD1 } from '../lib/shared/testing/d1-mock.js';
import type { EdgeRow, MemoryRow } from '../types/index.js';
import { recallMemory } from './recall-memory.js';

function memoryRow(id: string, content: string): MemoryRow {
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
    starting_confidence: 0.5,
    confirmations: 1,
    times_tested: 1,
    contradictions: 0,
    centrality: 0,
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
    agent_id: '_global',
    tags: null,
    obsidian_sources: null,
    session_id: null,
    created_at: Date.now(),
    updated_at: null,
  };
}

describe('recallMemory', () => {
  it('fetches connected memories in bulk query', async () => {
    const db = createMockD1();
    db._setQueryResult('SELECT * FROM memories WHERE id = ?', {
      firstResult: memoryRow('m-root', 'Root') as unknown as Record<string, unknown>,
    });
    db._setQueryResult('SELECT * FROM edges WHERE source_id IN (', {
      allResults: [
        {
          id: 'e1',
          source_id: 'm-root',
          target_id: 'm-a',
          edge_type: 'derived_from',
          strength: 1,
          created_at: 1,
        } satisfies EdgeRow,
      ],
    });
    db._setQueryResult('SELECT * FROM edges WHERE target_id IN (', {
      allResults: [
        {
          id: 'e2',
          source_id: 'm-b',
          target_id: 'm-root',
          edge_type: 'confirmed_by',
          strength: 1,
          created_at: 2,
        } satisfies EdgeRow,
      ],
    });
    db._setQueryResult('SELECT * FROM memories WHERE id IN (', {
      allResults: [
        memoryRow('m-a', 'Child A') as unknown as Record<string, unknown>,
        memoryRow('m-b', 'Parent B') as unknown as Record<string, unknown>,
      ],
    });

    const recalled = await recallMemory(db as unknown as D1Database, 'm-root');
    expect(recalled).not.toBeNull();
    expect(recalled!.connections).toHaveLength(2);

    const executed = db._getExecutedQueries();
    expect(executed.some((q) => q.includes('SELECT * FROM memories WHERE id IN ('))).toBe(true);
    expect(executed.filter((q) => q.includes('SELECT * FROM memories WHERE id = ?')).length).toBe(1);
  });
});
