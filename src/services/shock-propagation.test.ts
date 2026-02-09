import { describe, it, expect, beforeEach } from 'vitest';
import { createMockD1 } from '../lib/shared/testing/d1-mock.js';
import type { MockD1Database } from '../lib/shared/testing/d1-mock.js';
import { applyShock } from './shock-propagation.js';

describe('Shock Propagation (applyShock)', () => {
  let mockDb: MockD1Database;
  let env: { DB: D1Database };

  beforeEach(() => {
    mockDb = createMockD1();
    env = { DB: mockDb as unknown as D1Database };

    mockDb._setQueryResult('UPDATE memories SET propagated_confidence', {
      runResult: { success: true, meta: { changes: 1 } },
    });
  });

  it('propagates along a chain A -> B -> C (2 hops)', async () => {
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 1.0 },
        { source_id: 'B', target_id: 'C', edge_type: 'derived_from', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence, retracted', {
      allResults: [
        // Seed (excluded from writes)
        { id: 'A', source: null, starting_confidence: 0.4, confirmations: 2, times_tested: 10, propagated_confidence: null, retracted: 0 },
        // Neighbors to be updated
        { id: 'B', source: null, starting_confidence: 0.8, confirmations: 8, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'C', source: null, starting_confidence: 0.7, confirmations: 7, times_tested: 10, propagated_confidence: null, retracted: 0 },
      ],
    });

    const result = await applyShock(env as any, 'A', 'peripheral');

    expect(result.is_core).toBe(false);
    expect(result.affected_count).toBe(2);

    const ids = new Set(result.affected_memories.map((m) => m.id));
    expect(ids.has('B')).toBe(true);
    expect(ids.has('C')).toBe(true);
    expect(ids.has('A')).toBe(false);

    for (const m of result.affected_memories) {
      expect(m.new_confidence).toBeGreaterThanOrEqual(0);
      expect(m.new_confidence).toBeLessThanOrEqual(1);
    }

    const updateStmt = mockDb._statements.get('UPDATE memories SET propagated_confidence');
    expect(updateStmt).toBeDefined();
    expect(updateStmt!.run.mock.calls.length).toBe(2);
  });

  it('does not update the seed or observations', async () => {
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 1.0 },
        { source_id: 'B', target_id: 'C', edge_type: 'derived_from', strength: 1.0 },
        // Observation supports B but should never be updated itself
        { source_id: 'O', target_id: 'B', edge_type: 'confirmed_by', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence, retracted', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.4, confirmations: 2, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'B', source: null, starting_confidence: 0.8, confirmations: 8, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'C', source: null, starting_confidence: 0.7, confirmations: 7, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'O', source: 'market', starting_confidence: 0.9, confirmations: 0, times_tested: 0, propagated_confidence: null, retracted: 0 },
      ],
    });

    const result = await applyShock(env as any, 'A', 'core');
    expect(result.is_core).toBe(true);

    const ids = new Set(result.affected_memories.map((m) => m.id));
    expect(ids.has('A')).toBe(false);
    expect(ids.has('O')).toBe(false);
  });
});

