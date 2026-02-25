import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { getConfig } from '../../lib/config.js';
import findRoute from './find.js';
import recallRoute from './recall.js';
import { createMockD1 } from '../../lib/shared/testing/d1-mock.js';
import type { MemoryRow, EdgeRow } from '../../types/index.js';

vi.mock('../../lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  searchSimilar: vi.fn().mockResolvedValue([{ id: 'm1', similarity: 0.91 }]),
}));

vi.mock('../../jobs/compute-stats.js', () => ({
  getMaxTimesTested: vi.fn().mockResolvedValue(10),
}));

vi.mock('../../services/access-service.js', () => ({
  recordAccessBatch: vi.fn().mockResolvedValue(undefined),
  recordAccess: vi.fn().mockResolvedValue(undefined),
}));

function buildMemoryRow(id: string, content: string): MemoryRow {
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

function createRouteApp(routePath: string, route: Hono<any>) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('config', getConfig({}));
    c.set('requestId', 'req-1');
    c.set('sessionId', 'session-1');
    c.set('agentId', '_global');
    c.set('memoryScope', ['_global']);
    c.set('userAgent', 'vitest');
    c.set('ipHash', 'hash-1');
    await next();
  });
  app.route(routePath, route);
  return app;
}

describe('query route response contracts', () => {
  it('/api/find keeps result envelope shape', async () => {
    const db = createMockD1();
    db._setQueryResult('SELECT * FROM memories WHERE id IN (', {
      allResults: [buildMemoryRow('m1', 'Test memory') as unknown as Record<string, unknown>],
    });

    const app = createRouteApp('/api/find', findRoute);
    const res = await app.request('http://localhost/api/find', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    }, {
      DB: db as unknown as D1Database,
      AI: {},
      MEMORY_VECTORS: {},
      INVALIDATES_VECTORS: {},
      CONFIRMS_VECTORS: {},
      DETECTION_QUEUE: {},
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['query', 'results', 'total']);
    expect(Array.isArray(json.results)).toBe(true);
  });

  it('/api/recall/:id keeps memory/stats/edges/connections shape', async () => {
    const db = createMockD1();
    db._setQueryResult('SELECT * FROM memories WHERE id = ?', {
      firstResult: buildMemoryRow('m1', 'Test memory') as unknown as Record<string, unknown>,
    });
    db._setQueryResult('SELECT * FROM edges WHERE source_id IN (', {
      allResults: [
        { id: 'e1', source_id: 'm1', target_id: 'm2', edge_type: 'derived_from', strength: 1, created_at: 1 } satisfies EdgeRow,
      ],
    });
    db._setQueryResult('SELECT * FROM edges WHERE target_id IN (', {
      allResults: [],
    });
    db._setQueryResult('SELECT * FROM memories WHERE id IN (', {
      allResults: [buildMemoryRow('m2', 'Connected memory') as unknown as Record<string, unknown>],
    });

    const app = createRouteApp('/api/recall', recallRoute);
    const res = await app.request('http://localhost/api/recall/m1', {}, {
      DB: db as unknown as D1Database,
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['connections', 'edges', 'memory', 'stats']);
  });
});
