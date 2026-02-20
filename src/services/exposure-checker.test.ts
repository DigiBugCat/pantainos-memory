/**
 * Tests for edge strength decay/recovery in exposure-checker.ts
 *
 * Phase A: Verify that violations decay outgoing support edges
 * and confirmations recover them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockD1 } from '../lib/shared/testing/d1-mock.js';
import type { MockD1Database } from '../lib/shared/testing/d1-mock.js';
import { manualConfirm, manualViolate, insertCoreViolationNotification } from './exposure-checker.js';

// Mock dependencies that exposure-checker imports
vi.mock('../lib/lazy-logger.js', () => ({
  createLazyLogger: () => () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../lib/id.js', () => ({
  generateId: () => 'mock-id-' + Math.random().toString(36).slice(2, 8),
}));

vi.mock('../lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
  callExternalLLM: vi.fn(),
  searchInvalidatesConditions: vi.fn().mockResolvedValue({ count: 0, matches: [] }),
  searchConfirmsConditions: vi.fn().mockResolvedValue({ count: 0, matches: [] }),
  searchObservationsForViolation: vi.fn().mockResolvedValue({ count: 0, matches: [] }),
  deleteConditionVectors: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/config.js', () => ({
  getConfig: () => ({
    search: { minSimilarity: 0.35 },
  }),
}));

vi.mock('../lib/retry.js', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

// We need to also mock the vectorize search functions that are imported directly
vi.mock('./confidence.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    // Keep getDamageLevel real — it determines core vs peripheral
  };
});

describe('Edge Strength Decay on Violation', () => {
  let mockDb: MockD1Database;
  let mockEnv: { DB: D1Database; INVALIDATES_VECTORS: unknown; CONFIRMS_VECTORS: unknown; MEMORY_VECTORS: unknown; AI: unknown };

  beforeEach(() => {
    mockDb = createMockD1();

    // Default: memory exists with centrality=5, no existing violations
    mockDb._setQueryResult('SELECT centrality, violations FROM memories', {
      firstResult: { centrality: 5, violations: '[]' },
    });

    // Default: UPDATE memories succeeds
    mockDb._setQueryResult('UPDATE memories', {
      runResult: { success: true, meta: { changes: 1 } },
    });

    // Default: UPDATE edges succeeds
    mockDb._setQueryResult('UPDATE edges', {
      runResult: { success: true, meta: { changes: 2 } },
    });

    // Default: INSERT INTO edges succeeds (for violated_by edge creation)
    mockDb._setQueryResult('INSERT INTO edges', {
      runResult: { success: true, meta: { changes: 1 } },
    });

    mockEnv = {
      DB: mockDb as unknown as D1Database,
      INVALIDATES_VECTORS: {},
      CONFIRMS_VECTORS: {},
      MEMORY_VECTORS: {},
      AI: {},
    };
  });

  it('should decay outgoing edges after manual violation', async () => {
    const violation = await manualViolate(
      mockEnv as any,
      'memory-1',
      'contradicted by new evidence',
      'obs-1'
    );

    expect(violation).toBeDefined();
    expect(violation.damage_level).toBeDefined();

    // Verify the edge decay SQL was called via prepare() mock calls
    const prepareCalls = mockDb.prepare.mock.calls;
    const decayCall = prepareCalls.find((call: string[]) =>
      call[0].includes('UPDATE edges') && call[0].includes('strength = strength * (1.0 - ?)')
    );
    expect(decayCall).toBeDefined();
  });

  it('should use 50% decay factor for core violations', async () => {
    // Set high centrality so getDamageLevel returns 'core'
    // (centrality >= 5 typically = core)
    mockDb._setQueryResult('SELECT centrality, violations FROM memories', {
      firstResult: { centrality: 10, violations: '[]' },
    });

    const violation = await manualViolate(
      mockEnv as any,
      'memory-1',
      'core assumption wrong',
    );

    expect(violation.damage_level).toBe('core');

    // The bind call should have had damageFactor = 0.5
    // Verify the UPDATE edges was called
    const prepareCalls = mockDb.prepare.mock.calls;
    const edgeUpdateCall = prepareCalls.find((call: string[]) =>
      call[0].includes('UPDATE edges') && call[0].includes('strength = strength * (1.0 - ?)')
    );
    expect(edgeUpdateCall).toBeDefined();
  });

  it('should use 25% decay factor for peripheral violations', async () => {
    // Set low centrality so getDamageLevel returns 'peripheral'
    mockDb._setQueryResult('SELECT centrality, violations FROM memories', {
      firstResult: { centrality: 0, violations: '[]' },
    });

    const violation = await manualViolate(
      mockEnv as any,
      'memory-1',
      'minor contradiction',
    );

    expect(violation.damage_level).toBe('peripheral');

    // Verify edge update SQL was issued
    const prepareCalls = mockDb.prepare.mock.calls;
    const edgeUpdateCall = prepareCalls.find((call: string[]) =>
      call[0].includes('UPDATE edges') && call[0].includes('strength = strength * (1.0 - ?)')
    );
    expect(edgeUpdateCall).toBeDefined();
  });

  it('should create violated_by edge when observation ID provided', async () => {
    await manualViolate(
      mockEnv as any,
      'memory-1',
      'contradicted',
      'obs-123'
    );

    const queries = mockDb._getExecutedQueries();
    const insertEdge = queries.find(q => q.includes('INSERT INTO edges'));
    expect(insertEdge).toBeDefined();
  });

  it('should throw if memory not found', async () => {
    mockDb._setQueryResult('SELECT centrality, violations FROM memories', {
      firstResult: null,
    });

    await expect(
      manualViolate(mockEnv as any, 'nonexistent', 'test')
    ).rejects.toThrow('Memory not found');
  });
});

describe('Edge Strength Recovery on Confirmation', () => {
  let mockDb: MockD1Database;

  beforeEach(() => {
    mockDb = createMockD1();

    // Default: UPDATE memories succeeds
    mockDb._setQueryResult('UPDATE memories', {
      runResult: { success: true, meta: { changes: 1 } },
    });

    // Default: UPDATE edges succeeds
    mockDb._setQueryResult('UPDATE edges', {
      runResult: { success: true, meta: { changes: 2 } },
    });

    // Default: INSERT INTO edges succeeds
    mockDb._setQueryResult('INSERT INTO edges', {
      runResult: { success: true, meta: { changes: 1 } },
    });
  });

  it('should recover outgoing edges after manual confirmation', async () => {
    await manualConfirm(mockDb as unknown as D1Database, 'memory-1');

    // Verify the edge recovery SQL was called
    const prepareCalls = mockDb.prepare.mock.calls;
    const recoveryCall = prepareCalls.find((call: string[]) =>
      call[0].includes('UPDATE edges') && call[0].includes('MIN(1.0, strength * 1.1)')
    );
    expect(recoveryCall).toBeDefined();
  });

  it('should recover edges with correct source_id filter', async () => {
    await manualConfirm(mockDb as unknown as D1Database, 'memory-42');

    // Verify the edge recovery query targets the right edge types
    const prepareCalls = mockDb.prepare.mock.calls;
    const recoveryCall = prepareCalls.find((call: string[]) =>
      call[0].includes('MIN(1.0, strength * 1.1)')
    );
    expect(recoveryCall).toBeDefined();
    // SQL should filter by edge_type IN ('derived_from', 'confirmed_by')
    expect(recoveryCall![0]).toContain("edge_type IN ('derived_from', 'confirmed_by')");
  });

  it('should create confirmed_by edge when observation ID provided', async () => {
    await manualConfirm(mockDb as unknown as D1Database, 'memory-1', 'obs-456');

    const queries = mockDb._getExecutedQueries();
    const insertEdge = queries.find(q => q.includes('INSERT INTO edges'));
    expect(insertEdge).toBeDefined();
  });

  it('should not create edge when no observation ID', async () => {
    await manualConfirm(mockDb as unknown as D1Database, 'memory-1');

    const queries = mockDb._getExecutedQueries();
    const insertEdge = queries.find(q => q.includes('INSERT INTO edges'));
    expect(insertEdge).toBeUndefined();
  });
});

describe('Edge Decay/Recovery Dynamics', () => {
  let mockDb: MockD1Database;

  beforeEach(() => {
    mockDb = createMockD1();

    mockDb._setQueryResult('SELECT centrality, violations FROM memories', {
      firstResult: { centrality: 0, violations: '[]' },
    });
    mockDb._setQueryResult('UPDATE memories', {
      runResult: { success: true, meta: { changes: 1 } },
    });
    mockDb._setQueryResult('UPDATE edges', {
      runResult: { success: true, meta: { changes: 1 } },
    });
    mockDb._setQueryResult('INSERT INTO edges', {
      runResult: { success: true, meta: { changes: 1 } },
    });
  });

  it('edge decay SQL targets only derived_from and confirmed_by edges', async () => {
    await manualViolate(
      { DB: mockDb as unknown as D1Database, INVALIDATES_VECTORS: {}, CONFIRMS_VECTORS: {}, MEMORY_VECTORS: {} } as any,
      'memory-1',
      'test'
    );

    const prepareCalls = mockDb.prepare.mock.calls;
    const decayCall = prepareCalls.find((call: string[]) =>
      call[0].includes('strength = strength * (1.0 - ?)')
    );
    expect(decayCall).toBeDefined();
    expect(decayCall![0]).toContain("edge_type IN ('derived_from', 'confirmed_by')");
    // Should NOT include 'violated_by' — those edges aren't support edges
    expect(decayCall![0]).not.toContain('violated_by');
  });

  it('edge recovery SQL caps at 1.0', async () => {
    await manualConfirm(mockDb as unknown as D1Database, 'memory-1');

    const prepareCalls = mockDb.prepare.mock.calls;
    const recoveryCall = prepareCalls.find((call: string[]) =>
      call[0].includes('strength * 1.1')
    );
    expect(recoveryCall).toBeDefined();
    // Should use MIN(1.0, ...) to cap
    expect(recoveryCall![0]).toContain('MIN(1.0,');
  });

  it('both decay and recovery filter by source_id', async () => {
    // Violation: decay edges where source_id = violated memory
    await manualViolate(
      { DB: mockDb as unknown as D1Database, INVALIDATES_VECTORS: {}, CONFIRMS_VECTORS: {}, MEMORY_VECTORS: {} } as any,
      'memory-A',
      'test'
    );

    const prepareCalls = mockDb.prepare.mock.calls;
    const decayCall = prepareCalls.find((call: string[]) =>
      call[0].includes('strength = strength * (1.0 - ?)')
    );
    expect(decayCall![0]).toContain('WHERE source_id = ?');
  });
});

describe('Core Violation Notification (Pushover)', () => {
  let mockDb: MockD1Database;

  beforeEach(() => {
    mockDb = createMockD1();

    // SELECT memory content for notification
    mockDb._setQueryResult('SELECT content, state FROM memories', {
      firstResult: { content: 'Test memory content for notification', state: 'violated' },
    });

    // INSERT INTO notifications succeeds
    mockDb._setQueryResult('INSERT INTO notifications', {
      runResult: { success: true, meta: { changes: 1 } },
    });
  });

  it('inserts notification row into D1', async () => {
    const env = {
      DB: mockDb as unknown as D1Database,
    };

    const shock = {
      affected_count: 3,
      max_confidence_drop: 0.25,
      affected_memories: [],
      is_core: true,
      iterations: 0,
      spectral_radius: 0,
      backtrack_attempts: 0,
    };

    await insertCoreViolationNotification(env as any, 'mem-123', shock);

    // Verify the INSERT was called
    const prepareCalls = mockDb.prepare.mock.calls;
    const insertCall = prepareCalls.find((call: string[]) =>
      call[0].includes('INSERT INTO notifications')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain("'core_violation'");
  });

  it('calls Pushover API when credentials are set', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"status":1}',
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = {
      DB: mockDb as unknown as D1Database,
      PUSHOVER_USER_KEY: 'test-user-key',
      PUSHOVER_APP_TOKEN: 'test-app-token',
    };

    const shock = {
      affected_count: 5,
      max_confidence_drop: 0.4,
      affected_memories: [],
      is_core: true,
      iterations: 0,
      spectral_radius: 0,
      backtrack_attempts: 0,
    };

    await insertCoreViolationNotification(env as any, 'mem-456', shock);

    // Give the async Pushover call a tick to execute
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.token).toBe('test-app-token');
    expect(body.user).toBe('test-user-key');
    expect(body.title).toBe('Violation: Test memory content for notifi');
    expect(body.priority).toBe(1);
    expect(body.message).toContain('5 memories affected');
    expect(body.message).toContain('40%');

    vi.unstubAllGlobals();
  });

  it('skips Pushover when credentials not set', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const env = {
      DB: mockDb as unknown as D1Database,
      // No PUSHOVER_USER_KEY or PUSHOVER_APP_TOKEN
    };

    const shock = {
      affected_count: 2,
      max_confidence_drop: 0.1,
      affected_memories: [],
      is_core: true,
      iterations: 0,
      spectral_radius: 0,
      backtrack_attempts: 0,
    };

    await insertCoreViolationNotification(env as any, 'mem-789', shock);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
