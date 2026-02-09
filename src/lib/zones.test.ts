/**
 * Tests for reasoning zones pure functions.
 *
 * Tests scoreZone, formatZone, isOverwhelminglyViolated, parseViolationCount.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreZone,
  formatZone,
  formatConfidence,
  truncate,
  parseViolationCount,
  isOverwhelminglyViolated,
  addBoundaryReason,
  type SafetyRow,
} from './zones.js';
import type { Memory } from './shared/types/memory.js';

// ============================================
// Test Fixtures
// ============================================

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test-id',
    content: 'Test memory content',
    starting_confidence: 0.7,
    confirmations: 8,
    times_tested: 10,
    contradictions: 0,
    centrality: 3,
    state: 'active',
    violations: [],
    retracted: false,
    exposure_check_status: 'completed',
    cascade_boosts: 0,
    cascade_damages: 0,
    created_at: Date.now(),
    ...overrides,
  };
}

function makeSafetyRow(overrides: Partial<SafetyRow> = {}): SafetyRow {
  return {
    id: 'test-id',
    state: 'active',
    outcome: null,
    retracted: 0,
    violations: '[]',
    times_tested: 10,
    confirmations: 8,
    ...overrides,
  };
}

// ============================================
// scoreZone
// ============================================

describe('scoreZone', () => {
  it('returns 0 for empty zone', () => {
    expect(scoreZone([], 0, 0)).toBe(0);
  });

  it('returns mean confidence with no penalties', () => {
    const members = [
      makeMemory({ confirmations: 8, times_tested: 10 }), // 0.8
      makeMemory({ confirmations: 6, times_tested: 10 }), // 0.6
    ];
    const score = scoreZone(members, 0, 0);
    expect(score).toBeCloseTo(0.7, 2); // mean of 0.8 and 0.6
  });

  it('uses starting_confidence when untested', () => {
    const members = [
      makeMemory({ starting_confidence: 0.5, confirmations: 0, times_tested: 0 }),
    ];
    expect(scoreZone(members, 0, 0)).toBeCloseTo(0.5, 2);
  });

  it('prefers propagated_confidence when present', () => {
    const members = [
      makeMemory({ confirmations: 10, times_tested: 10, propagated_confidence: 0.2 }), // local=1.0, propagated=0.2
    ];
    expect(scoreZone(members, 0, 0)).toBeCloseTo(0.2, 2);
  });

  it('penalizes boundary contradictions (cut-)', () => {
    const members = [
      makeMemory({ confirmations: 8, times_tested: 10 }), // 0.8
    ];
    const withoutPenalty = scoreZone(members, 0, 0);
    const withPenalty = scoreZone(members, 5, 0);
    expect(withPenalty).toBeLessThan(withoutPenalty);
    // lambda=0.2, 5 contradictions / 1 member = 0.2 * 5 = 1.0 penalty
    // score = 0.8 - 1.0 = -0.2, clamped to 0
    expect(withPenalty).toBe(0);
  });

  it('penalizes external support leakage (loss+)', () => {
    const members = [
      makeMemory({ confirmations: 8, times_tested: 10 }), // 0.8
    ];
    const withoutPenalty = scoreZone(members, 0, 0);
    const withPenalty = scoreZone(members, 0, 3);
    expect(withPenalty).toBeLessThan(withoutPenalty);
    // rho=0.1, 3 leakages / 1 member = 0.1 * 3 = 0.3 penalty
    // score = 0.8 - 0.3 = 0.5
    expect(withPenalty).toBeCloseTo(0.5, 2);
  });

  it('clamps to [0, 1]', () => {
    const highConf = [makeMemory({ confirmations: 10, times_tested: 10 })]; // 1.0
    expect(scoreZone(highConf, 0, 0)).toBeLessThanOrEqual(1);

    const heavyPenalty = [makeMemory({ confirmations: 1, times_tested: 10 })]; // 0.1
    expect(scoreZone(heavyPenalty, 10, 10, )).toBeGreaterThanOrEqual(0);
  });

  it('handles mixed tested and untested members', () => {
    const members = [
      makeMemory({ confirmations: 10, times_tested: 10 }), // 1.0
      makeMemory({ starting_confidence: 0.4, confirmations: 0, times_tested: 0 }), // 0.4
    ];
    expect(scoreZone(members, 0, 0)).toBeCloseTo(0.7, 2); // mean of 1.0 and 0.4
  });
});

// ============================================
// isOverwhelminglyViolated
// ============================================

describe('isOverwhelminglyViolated', () => {
  it('returns false when no violations', () => {
    expect(isOverwhelminglyViolated(makeSafetyRow({ violations: '[]' }))).toBe(false);
  });

  it('returns false for null violations', () => {
    expect(isOverwhelminglyViolated(makeSafetyRow({ violations: null }))).toBe(false);
  });

  it('returns true when violations exist but no confirmations', () => {
    expect(isOverwhelminglyViolated(makeSafetyRow({
      violations: '[{"condition":"test"}]',
      confirmations: 0,
      times_tested: 5,
    }))).toBe(true);
  });

  it('returns true when survival rate < 50%', () => {
    expect(isOverwhelminglyViolated(makeSafetyRow({
      violations: '[{"condition":"test"}]',
      confirmations: 2,
      times_tested: 10, // 20% survival
    }))).toBe(true);
  });

  it('returns false when survival rate >= 50%', () => {
    expect(isOverwhelminglyViolated(makeSafetyRow({
      violations: '[{"condition":"test"}]',
      confirmations: 8,
      times_tested: 10, // 80% survival
    }))).toBe(false);
  });

  it('returns false at exactly 50% survival', () => {
    expect(isOverwhelminglyViolated(makeSafetyRow({
      violations: '[{"condition":"test"}]',
      confirmations: 5,
      times_tested: 10, // exactly 50%
    }))).toBe(false);
  });
});

// ============================================
// parseViolationCount
// ============================================

describe('parseViolationCount', () => {
  it('returns 0 for null', () => {
    expect(parseViolationCount(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(parseViolationCount(undefined)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(parseViolationCount('[]')).toBe(0);
  });

  it('counts violations in array', () => {
    expect(parseViolationCount('[{"condition":"a"},{"condition":"b"}]')).toBe(2);
  });

  it('returns 0 for invalid JSON', () => {
    // Defensive — invalid JSON should not crash
    expect(parseViolationCount('not json')).toBe(0);
  });

  it('returns 0 for non-array JSON', () => {
    expect(parseViolationCount('{"key":"val"}')).toBe(0);
  });
});

// ============================================
// addBoundaryReason
// ============================================

describe('addBoundaryReason', () => {
  it('creates new set for first reason', () => {
    const map = new Map<string, Set<string>>();
    addBoundaryReason(map, 'mem-1', 'excluded: violated');
    expect(map.has('mem-1')).toBe(true);
    expect(map.get('mem-1')!.size).toBe(1);
    expect(map.get('mem-1')!.has('excluded: violated')).toBe(true);
  });

  it('adds to existing set', () => {
    const map = new Map<string, Set<string>>();
    addBoundaryReason(map, 'mem-1', 'reason A');
    addBoundaryReason(map, 'mem-1', 'reason B');
    expect(map.get('mem-1')!.size).toBe(2);
  });

  it('deduplicates identical reasons', () => {
    const map = new Map<string, Set<string>>();
    addBoundaryReason(map, 'mem-1', 'same reason');
    addBoundaryReason(map, 'mem-1', 'same reason');
    expect(map.get('mem-1')!.size).toBe(1);
  });
});

// ============================================
// formatConfidence
// ============================================

describe('formatConfidence', () => {
  it('returns "untested" for zero tests', () => {
    expect(formatConfidence({ confirmations: 0, times_tested: 0 })).toBe('untested');
  });

  it('formats percentage with counts', () => {
    expect(formatConfidence({ confirmations: 8, times_tested: 10 })).toBe('80% (8/10)');
  });

  it('rounds percentage', () => {
    expect(formatConfidence({ confirmations: 1, times_tested: 3 })).toBe('33% (1/3)');
  });

  it('handles undefined fields', () => {
    expect(formatConfidence({})).toBe('untested');
  });
});

// ============================================
// truncate
// ============================================

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings with ellipsis', () => {
    // max=10, slices to 7 chars + "..." = "a very ..."
    expect(truncate('a very long string indeed', 10)).toBe('a very ...');
  });

  it('handles empty string', () => {
    expect(truncate('', 10)).toBe('');
  });

  it('trims whitespace', () => {
    expect(truncate('  hello  ', 10)).toBe('hello');
  });
});

// ============================================
// formatZone
// ============================================

describe('formatZone', () => {
  it('formats a consistent zone', () => {
    const result = formatZone({
      seedId: 'abc123',
      query: 'test query',
      zoneMembers: [
        makeMemory({ id: 'abc123', content: 'Observation about X', source: 'market' }),
        makeMemory({ id: 'def456', content: 'Thought derived from X', derived_from: ['abc123'] }),
      ],
      semanticMemberIds: new Set(),
      internalEdges: [
        { source_id: 'abc123', target_id: 'def456', edge_type: 'derived_from', strength: 1.0 },
      ],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).toContain('=== REASONING ZONE ===');
    expect(result).toContain('seed: [abc123]');
    expect(result).toContain('2 memories | consistent');
    expect(result).toContain('quality:');
    expect(result).toContain('ZONE MEMBERS');
    expect(result).toContain('[abc123]');
    expect(result).toContain('[def456]');
    expect(result).toContain('EDGES (within zone)');
    expect(result).toContain('derived_from');
    expect(result).toContain('safe for inference');
  });

  it('marks unsafe zones', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [makeMemory({ id: 'abc123' })],
      semanticMemberIds: new Set(),
      internalEdges: [],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: ['seed state=violated'],
    });

    expect(result).toContain('unsafe');
    expect(result).toContain('NOT safe for inference');
    expect(result).toContain('seed state=violated');
  });

  it('shows edge strength when decayed', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [
        makeMemory({ id: 'abc123' }),
        makeMemory({ id: 'def456' }),
      ],
      semanticMemberIds: new Set(),
      internalEdges: [
        { source_id: 'abc123', target_id: 'def456', edge_type: 'derived_from', strength: 0.75 },
      ],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).toContain('(0.75)');
  });

  it('hides edge strength when full (1.0)', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [
        makeMemory({ id: 'abc123' }),
        makeMemory({ id: 'def456' }),
      ],
      semanticMemberIds: new Set(),
      internalEdges: [
        { source_id: 'abc123', target_id: 'def456', edge_type: 'derived_from', strength: 1.0 },
      ],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).not.toContain('(1.00)');
  });

  it('marks semantic expansion members', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [
        makeMemory({ id: 'abc123' }),
        makeMemory({ id: 'sem789' }),
      ],
      semanticMemberIds: new Set(['sem789']),
      internalEdges: [],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).toContain('(semantic)');
  });

  it('shows boundary with reasons', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [makeMemory({ id: 'abc123' })],
      semanticMemberIds: new Set(),
      internalEdges: [],
      boundary: [{
        memory: makeMemory({ id: 'bad999', content: 'Contradicting memory' }),
        reasons: ['contradicts [abc123] (violated_by)'],
      }],
      cutMinusEdges: [
        { source_id: 'abc123', target_id: 'bad999', edge_type: 'violated_by' as const },
      ],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).toContain('1 boundary');
    expect(result).toContain('[bad999]');
    expect(result).toContain('contradicts [abc123]');
    expect(result).toContain('boundary contradictions (cut-): 1');
  });

  it('shows external support dependency (loss+)', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [makeMemory({ id: 'abc123' })],
      semanticMemberIds: new Set(),
      internalEdges: [],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [
        { source_id: 'ext001', target_id: 'abc123', edge_type: 'derived_from' as const },
      ],
      unsafeReasons: [],
    });

    expect(result).toContain('external support dependency (loss+): 1');
    expect(result).toContain('loss+ (external support crossings)');
    expect(result).toContain('[ext001]');
  });

  it('handles empty zone', () => {
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [],
      semanticMemberIds: new Set(),
      internalEdges: [],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).toContain('0 memories');
    expect(result).toContain('(none)');
  });

  it('includes quality score based on zone scoring formula', () => {
    // Zone with perfect confidence and no penalties → high quality
    const result = formatZone({
      seedId: 'abc123',
      zoneMembers: [
        makeMemory({ id: 'abc123', confirmations: 10, times_tested: 10 }),
      ],
      semanticMemberIds: new Set(),
      internalEdges: [],
      boundary: [],
      cutMinusEdges: [],
      lossPlusEdges: [],
      unsafeReasons: [],
    });

    expect(result).toContain('quality: 100%');
  });
});
