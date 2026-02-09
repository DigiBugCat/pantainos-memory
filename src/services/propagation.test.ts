/**
 * Tests for full-graph confidence propagation (Phase B-beta).
 *
 * Tests: connected component discovery, damped iteration convergence,
 * observation exclusion, contradiction handling, and write-back behavior.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockD1 } from '../lib/shared/testing/d1-mock.js';
import type { MockD1Database } from '../lib/shared/testing/d1-mock.js';
import { runFullGraphPropagation } from './propagation.js';

// Mock logger
vi.mock('../lib/shared/logging/index.js', () => ({
  createStandaloneLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('Full Graph Propagation', () => {
  let mockDb: MockD1Database;
  let env: { DB: D1Database };

  beforeEach(() => {
    mockDb = createMockD1();
    env = { DB: mockDb as unknown as D1Database };

    // Default: UPDATE succeeds
    mockDb._setQueryResult('UPDATE memories SET propagated_confidence', {
      runResult: { success: true, meta: { changes: 1 } },
    });

    // Default: no contradiction edges
    mockDb._setQueryResult("edge_type IN ('violated_by')", {
      allResults: [],
    });
  });

  it('propagates through a simple chain A -> B -> C', async () => {
    // Edges: A derives B, B derives C
    mockDb._setQueryResult("edge_type IN ('derived_from', 'confirmed_by')", {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 1.0 },
        { source_id: 'B', target_id: 'C', edge_type: 'derived_from', strength: 1.0 },
      ],
    });

    // All thoughts, no observations
    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.4, confirmations: 2, times_tested: 10, propagated_confidence: null },
        { id: 'B', source: null, starting_confidence: 0.5, confirmations: 5, times_tested: 10, propagated_confidence: null },
        { id: 'C', source: null, starting_confidence: 0.6, confirmations: 6, times_tested: 10, propagated_confidence: null },
      ],
    });

    const result = await runFullGraphPropagation(env as any, 'test-req');

    expect(result.total_memories).toBe(3);
    expect(result.components_processed).toBeGreaterThanOrEqual(1);
    expect(result.total_updated).toBeGreaterThan(0);
  });

  it('skips observations (source != null)', async () => {
    mockDb._setQueryResult("edge_type IN ('derived_from', 'confirmed_by')", {
      allResults: [
        { source_id: 'obs-1', target_id: 'thought-1', edge_type: 'confirmed_by', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence', {
      allResults: [
        { id: 'obs-1', source: 'market', starting_confidence: 0.75, confirmations: 0, times_tested: 0, propagated_confidence: null },
        { id: 'thought-1', source: null, starting_confidence: 0.5, confirmations: 3, times_tested: 10, propagated_confidence: null },
      ],
    });

    const result = await runFullGraphPropagation(env as any, 'test-req');

    // Only thought-1 should be updated, not obs-1
    const updateStmt = mockDb._statements.get('UPDATE memories SET propagated_confidence');
    if (updateStmt) {
      const bindCalls = updateStmt.bind.mock.calls;
      for (const call of bindCalls) {
        // Third arg is the memory ID
        expect(call[2]).not.toBe('obs-1');
      }
    }
  });

  it('handles empty graph', async () => {
    mockDb._setQueryResult("edge_type IN ('derived_from', 'confirmed_by')", {
      allResults: [],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence', {
      allResults: [],
    });

    const result = await runFullGraphPropagation(env as any, 'test-req');
    expect(result.total_memories).toBe(0);
    expect(result.total_updated).toBe(0);
    expect(result.components_processed).toBe(0);
  });

  it('handles disconnected components independently', async () => {
    // Two separate chains: A->B and X->Y
    mockDb._setQueryResult("edge_type IN ('derived_from', 'confirmed_by')", {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 1.0 },
        { source_id: 'X', target_id: 'Y', edge_type: 'derived_from', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.4, confirmations: 2, times_tested: 10, propagated_confidence: null },
        { id: 'B', source: null, starting_confidence: 0.5, confirmations: 5, times_tested: 10, propagated_confidence: null },
        { id: 'X', source: null, starting_confidence: 0.8, confirmations: 8, times_tested: 10, propagated_confidence: null },
        { id: 'Y', source: null, starting_confidence: 0.3, confirmations: 3, times_tested: 10, propagated_confidence: null },
      ],
    });

    const result = await runFullGraphPropagation(env as any, 'test-req');

    // Should process 2 components
    expect(result.components_processed).toBe(2);
    expect(result.total_memories).toBe(4);
  });

  it('respects min edge strength threshold', async () => {
    // Edge with strength below MIN_STRENGTH (0.1) should be ignored
    mockDb._setQueryResult("edge_type IN ('derived_from', 'confirmed_by')", {
      allResults: [], // D1 mock returns this for the query with strength >= 0.1
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.5, confirmations: 5, times_tested: 10, propagated_confidence: null },
      ],
    });

    const result = await runFullGraphPropagation(env as any, 'test-req');
    // No edges means no components, no updates
    expect(result.total_updated).toBe(0);
  });

  it('subtractive contradiction drives confidence below support-only level (Paper Eq. 5)', async () => {
    // Chain: A → B (support). V contradicts B.
    // Without contradiction, B's propagated confidence would be pulled toward A's confidence.
    // With contradiction from high-confidence V, B should be pushed down further.
    mockDb._setQueryResult("edge_type IN ('derived_from', 'confirmed_by')", {
      allResults: [
        { source_id: 'A', target_id: 'B', edge_type: 'derived_from', strength: 1.0 },
      ],
    });

    // V is a high-confidence observation contradicting B
    mockDb._setQueryResult("edge_type IN ('violated_by')", {
      allResults: [
        { source_id: 'V', target_id: 'B', edge_type: 'violated_by', strength: 1.0 },
      ],
    });

    mockDb._setQueryResult('SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence', {
      allResults: [
        { id: 'A', source: null, starting_confidence: 0.4, confirmations: 2, times_tested: 10, propagated_confidence: null },
        { id: 'B', source: null, starting_confidence: 0.7, confirmations: 7, times_tested: 10, propagated_confidence: null },
        { id: 'V', source: 'market', starting_confidence: 0.9, confirmations: 0, times_tested: 0, propagated_confidence: null },
      ],
    });

    const result = await runFullGraphPropagation(env as any, 'test-req');

    // B should have been updated (pulled down by contradiction)
    expect(result.total_updated).toBeGreaterThan(0);

    // Verify the written value: check the UPDATE bind calls
    const updateStmt = mockDb._statements.get('UPDATE memories SET propagated_confidence');
    expect(updateStmt).toBeDefined();

    // Find the update for B
    const bUpdate = updateStmt!.bind.mock.calls.find((call: unknown[]) => call[2] === 'B');
    expect(bUpdate).toBeDefined();

    const bNewConfidence = bUpdate![0] as number;
    // B's local confidence with 7/10 confirmations and starting 0.7:
    // evidenceWeight ≈ 0.5 (from getEvidenceWeight), earned = 0.7
    // local ≈ 0.7*(1-0.5) + 0.7*0.5 = 0.7
    // A's local ≈ 0.4*(1-0.5) + 0.2*0.5 = 0.3 (support value)
    // V's local = 0.9 (observation, starting_confidence used directly)
    // influence = support - η*contradiction = 0.3 - 0.8*0.9 = 0.3 - 0.72 = -0.42
    // updated = clamp01(0.4*0.7 + 0.6*(-0.42)) = clamp01(0.28 - 0.252) = clamp01(0.028) = 0.028
    // After multiple iterations this converges near the floor.
    // Key assertion: with contradiction, B ends up well below its prior of 0.7
    expect(bNewConfidence).toBeLessThan(0.5);
  });
});
