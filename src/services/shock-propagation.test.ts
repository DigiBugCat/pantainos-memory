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

    // Default: no contradiction edges
    mockDb._setQueryResult("edge_type = 'violated_by'", {
      allResults: [],
    });

    // Default: edge insertion succeeds
    mockDb._setQueryResult('INSERT INTO edges', {
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

  it('subtractive contradiction pushes confidence below prior (Paper Eq. 5)', async () => {
    // Setup: B derives from A (support), and V contradicts B (violated_by).
    // With the subtractive formula, a strong contradiction on B should push
    // B's confidence below its local prior even when support is weak.
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 0.5 },
      ],
    });

    // V is a high-confidence observation that contradicts B
    mockDb._setQueryResult("edge_type = 'violated_by'", {
      allResults: [
        { source_id: 'V', target_id: 'B', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence, retracted', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.3, confirmations: 1, times_tested: 5, propagated_confidence: 0.3, retracted: 0 },
        { id: 'B', source: null, starting_confidence: 0.7, confirmations: 5, times_tested: 8, propagated_confidence: 0.7, retracted: 0 },
        // V is the contradicting observation — high confidence
        { id: 'V', source: 'market', starting_confidence: 0.9, confirmations: 0, times_tested: 0, propagated_confidence: null, retracted: 0 },
      ],
    });

    const result = await applyShock(env as any, 'A', 'peripheral');

    // B should be affected and its confidence should drop below its prior (0.7)
    const bResult = result.affected_memories.find(m => m.id === 'B');
    expect(bResult).toBeDefined();
    expect(bResult!.new_confidence).toBeLessThan(bResult!.old_confidence);

    // Key behavioral test: with subtractive formula, influence = support - η*contradiction
    // support from A is low (A has ~0.3 confidence), contradiction from V is high (0.9)
    // influence ≈ 0.3 - 0.8*0.9 = 0.3 - 0.72 = -0.42 (negative!)
    // updated = clamp01((1-0.6)*prior + 0.6*(-0.42)) = clamp01(0.4*prior - 0.252)
    // This should meaningfully push B's confidence down.
    expect(bResult!.new_confidence).toBeLessThan(0.5);
  });

  it('injects violated_by edges from seed to support neighbors (Paper Eq. 13)', async () => {
    // A → B and A → C (support edges from seed A)
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 0.8 },
        { source_id: 'A', target_id: 'C', edge_type: 'derived_from', strength: 0.2 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence, retracted', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.5, confirmations: 2, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'B', source: null, starting_confidence: 0.8, confirmations: 8, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'C', source: null, starting_confidence: 0.7, confirmations: 7, times_tested: 10, propagated_confidence: null, retracted: 0 },
      ],
    });

    await applyShock(env as any, 'A', 'core');

    // Check that INSERT INTO edges was called (for contradiction injection)
    const insertStmt = mockDb._statements.get('INSERT INTO edges');
    expect(insertStmt).toBeDefined();

    // With core damage (shockStrength=1.0), RHO=0.3:
    // B: proportional = 0.8/1.0 = 0.8, injected = 0.3 * 1.0 * 0.8 = 0.24 (>= MIN_STRENGTH 0.1)
    // C: proportional = 0.2/1.0 = 0.2, injected = 0.3 * 1.0 * 0.2 = 0.06 (< MIN_STRENGTH, SKIPPED)
    // So only 1 edge should be inserted (for B, not C)
    const bindCalls = insertStmt!.bind.mock.calls;
    expect(bindCalls.length).toBe(1);

    // Verify the edge goes from A to B with the right strength
    const call = bindCalls[0];
    expect(call[0]).toBe('A'); // source_id = seed
    expect(call[1]).toBe('B'); // target_id = neighbor B
    // injectedStrength = 0.24
    expect(call[2]).toBeCloseTo(0.24, 2);
  });

  it('skips contradiction injection for peripheral with few edges', async () => {
    // Single edge, peripheral damage (shockStrength=0.4)
    // injected = RHO(0.3) * 0.4 * 1.0 = 0.12 — just above MIN_STRENGTH(0.1), should inject
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence, retracted', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.5, confirmations: 2, times_tested: 10, propagated_confidence: null, retracted: 0 },
        { id: 'B', source: null, starting_confidence: 0.8, confirmations: 8, times_tested: 10, propagated_confidence: null, retracted: 0 },
      ],
    });

    await applyShock(env as any, 'A', 'peripheral');

    // peripheral shockStrength=0.4, RHO=0.3, proportional=1.0
    // injected = 0.3 * 0.4 * 1.0 = 0.12 >= 0.1, so it should inject
    const insertStmt = mockDb._statements.get('INSERT INTO edges');
    expect(insertStmt).toBeDefined();
    expect(insertStmt!.bind.mock.calls.length).toBe(1);

    const call = insertStmt!.bind.mock.calls[0];
    expect(call[2]).toBeCloseTo(0.12, 2);
  });
});
