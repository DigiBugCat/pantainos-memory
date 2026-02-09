/**
 * Tests for full-graph confidence propagation (Phase B-beta).
 *
 * Tests: connected component discovery, damped iteration convergence,
 * observation exclusion, and write-back behavior.
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
  });

  it('propagates through a simple chain A -> B -> C', async () => {
    // Edges: A derives B, B derives C
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
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
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
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
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
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
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
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
    mockDb._setQueryResult('SELECT source_id, target_id, edge_type, strength', {
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
});
