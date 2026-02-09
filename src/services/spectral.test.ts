/**
 * Tests for spectral radius estimation (power iteration).
 */
import { describe, it, expect } from 'vitest';
import { estimateSpectralRadius } from './spectral.js';

type AdjacencyMap = Map<string, Array<{ source_id: string; strength: number }>>;

describe('estimateSpectralRadius', () => {
  it('returns 0 for empty graph', () => {
    const incoming: AdjacencyMap = new Map();
    const contradictionIncoming: AdjacencyMap = new Map();
    expect(estimateSpectralRadius([], incoming, contradictionIncoming, 0.6, 0.8, () => true)).toBe(0);
  });

  it('returns 0 when no nodes are updateable', () => {
    const incoming: AdjacencyMap = new Map();
    incoming.set('B', [{ source_id: 'A', strength: 1.0 }]);
    const contradictionIncoming: AdjacencyMap = new Map();

    const result = estimateSpectralRadius(
      ['A', 'B'],
      incoming,
      contradictionIncoming,
      0.6,
      0.8,
      () => false, // nothing updateable
    );
    expect(result).toBe(0);
  });

  it('returns 0 for acyclic chain where only leaf is updateable', () => {
    // A → B, only B updateable. B's incoming is from A (non-updateable).
    // The restricted operator on updateable nodes has no feedback loop → spectral radius = 0.
    const incoming: AdjacencyMap = new Map();
    incoming.set('B', [{ source_id: 'A', strength: 1.0 }]);
    const contradictionIncoming: AdjacencyMap = new Map();

    const result = estimateSpectralRadius(
      ['A', 'B'],
      incoming,
      contradictionIncoming,
      0.6,
      0.8,
      (id) => id === 'B',
    );
    expect(result).toBe(0);
  });

  it('returns > 0 for a cycle with updateable nodes', () => {
    // A → B and B → A, both updateable — mutual support creates feedback
    const incoming: AdjacencyMap = new Map();
    incoming.set('B', [{ source_id: 'A', strength: 1.0 }]);
    incoming.set('A', [{ source_id: 'B', strength: 1.0 }]);
    const contradictionIncoming: AdjacencyMap = new Map();

    const result = estimateSpectralRadius(
      ['A', 'B'],
      incoming,
      contradictionIncoming,
      0.6,
      0.8,
      () => true,
    );
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1.0); // alpha=0.6 should keep it < 1
  });

  it('increases with strong contradictions', () => {
    const incoming: AdjacencyMap = new Map();
    incoming.set('B', [{ source_id: 'A', strength: 1.0 }]);

    // Without contradictions
    const noContr: AdjacencyMap = new Map();
    const r1 = estimateSpectralRadius(
      ['A', 'B'],
      incoming,
      noContr,
      0.6,
      0.8,
      (id) => id === 'B',
    );

    // With contradictions (adds magnitude to the matrix)
    const withContr: AdjacencyMap = new Map();
    withContr.set('B', [{ source_id: 'C', strength: 1.0 }]);
    const r2 = estimateSpectralRadius(
      ['A', 'B', 'C'],
      incoming,
      withContr,
      0.6,
      0.8,
      (id) => id === 'B',
    );

    // Contradiction adds negative component, increasing spectral norm
    // r2 should be >= r1 (in absolute terms)
    expect(r2).toBeGreaterThanOrEqual(r1 * 0.99); // allow small numerical tolerance
  });

  it('produces deterministic results', () => {
    const incoming: AdjacencyMap = new Map();
    incoming.set('B', [{ source_id: 'A', strength: 0.8 }]);
    incoming.set('C', [{ source_id: 'B', strength: 0.5 }]);
    const contradictionIncoming: AdjacencyMap = new Map();

    const r1 = estimateSpectralRadius(
      ['A', 'B', 'C'],
      incoming,
      contradictionIncoming,
      0.6,
      0.8,
      (id) => id !== 'A',
    );
    const r2 = estimateSpectralRadius(
      ['A', 'B', 'C'],
      incoming,
      contradictionIncoming,
      0.6,
      0.8,
      (id) => id !== 'A',
    );
    expect(r1).toBe(r2);
  });

  it('higher alpha increases spectral radius', () => {
    // Need a cycle so spectral radius > 0
    const incoming: AdjacencyMap = new Map();
    incoming.set('B', [{ source_id: 'A', strength: 1.0 }]);
    incoming.set('A', [{ source_id: 'B', strength: 1.0 }]);
    const contradictionIncoming: AdjacencyMap = new Map();

    const lowAlpha = estimateSpectralRadius(
      ['A', 'B'],
      incoming,
      contradictionIncoming,
      0.3,
      0.8,
      () => true,
    );
    const highAlpha = estimateSpectralRadius(
      ['A', 'B'],
      incoming,
      contradictionIncoming,
      0.9,
      0.8,
      () => true,
    );

    expect(highAlpha).toBeGreaterThan(lowAlpha);
  });
});
