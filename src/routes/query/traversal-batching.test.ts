import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import referenceRoute from './reference.js';
import rootsRoute from './roots.js';
import { getConfig } from '../../lib/config.js';
import type { EdgeRow, MemoryRow } from '../../types/index.js';

type FakeDb = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      all: <T>() => Promise<{ results: T[] }>;
      run: () => Promise<{ success: boolean; meta: { changes: number } }>;
    };
  };
  executed: string[];
};

function buildMemoryRow(id: string, content: string, derivedFrom?: string[] | null): MemoryRow {
  return {
    id,
    content,
    source: derivedFrom ? null : 'market',
    source_url: null,
    derived_from: derivedFrom ? JSON.stringify(derivedFrom) : null,
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
    agent_id: '_default',
    tags: null,
    obsidian_sources: null,
    session_id: null,
    created_at: Date.now(),
    updated_at: null,
  };
}

function createGraphDb(memories: MemoryRow[], edges: EdgeRow[]): FakeDb {
  const memoryMap = new Map(memories.map((m) => [m.id, m]));
  const executed: string[] = [];
  const edgeTypes = new Set(['derived_from', 'violated_by', 'confirmed_by', 'supersedes']);

  return {
    executed,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          first: async <T>() => {
            executed.push(sql);
            if (sql.includes('SELECT * FROM memories WHERE id = ?')) {
              const id = args[0] as string;
              return (memoryMap.get(id) as unknown as T) ?? null;
            }
            return null;
          },
          all: async <T>() => {
            executed.push(sql);

            if (sql.includes('SELECT * FROM edges WHERE source_id IN (')) {
              const ids = (args as string[]).filter((v) => !edgeTypes.has(v));
              const types = (args as string[]).filter((v) => edgeTypes.has(v));
              const rows = edges.filter((e) =>
                ids.includes(e.source_id) && (types.length === 0 || types.includes(e.edge_type))
              );
              return { results: rows as unknown as T[] };
            }

            if (sql.includes('SELECT * FROM edges WHERE target_id IN (')) {
              const ids = (args as string[]).filter((v) => !edgeTypes.has(v));
              const types = (args as string[]).filter((v) => edgeTypes.has(v));
              const rows = edges.filter((e) =>
                ids.includes(e.target_id) && (types.length === 0 || types.includes(e.edge_type))
              );
              return { results: rows as unknown as T[] };
            }

            if (sql.includes('SELECT * FROM memories WHERE id IN (')) {
              const ids = args as string[];
              const rows = ids
                .map((id) => memoryMap.get(id))
                .filter((m): m is MemoryRow => Boolean(m))
                .filter((m) => m.retracted === 0);
              return { results: rows as unknown as T[] };
            }

            return { results: [] as T[] };
          },
          run: async () => ({ success: true, meta: { changes: 0 } }),
        }),
      };
    },
  };
}

function createTestApp(routePath: string, route: Hono<any>) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('config', getConfig({}));
    c.set('requestId', 'req-1');
    c.set('sessionId', 'session-1');
    c.set('agentId', '_default');
    c.set('memoryScope', ['_default']);
    await next();
  });
  app.route(routePath, route);
  return app;
}

describe('batched traversal routes', () => {
  const memories = [
    buildMemoryRow('m1', 'Root memory'),
    buildMemoryRow('m2', 'Middle memory', ['m1']),
    buildMemoryRow('m3', 'Leaf memory', ['m2']),
    buildMemoryRow('m4', 'Sibling leaf', ['m2']),
  ];
  const edges: EdgeRow[] = [
    { id: 'e1', source_id: 'm1', target_id: 'm2', edge_type: 'derived_from', strength: 1, created_at: 1 },
    { id: 'e2', source_id: 'm2', target_id: 'm3', edge_type: 'derived_from', strength: 1, created_at: 2 },
    { id: 'e3', source_id: 'm2', target_id: 'm4', edge_type: 'derived_from', strength: 1, created_at: 3 },
  ];

  it('reference traverses deep graph via batched edge/memory fetches', async () => {
    const db = createGraphDb(memories, edges);
    const app = createTestApp('/api/reference', referenceRoute);

    const res = await app.request('http://localhost/api/reference/m2?depth=2&direction=both', {}, {
      DB: db as unknown as D1Database,
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json() as { nodes: Array<{ id: string }> };
    expect(new Set(json.nodes.map((n) => n.id))).toEqual(new Set(['m1', 'm2', 'm3', 'm4']));

    expect(db.executed.some((q) => q.includes('target_id IN ('))).toBe(true);
    expect(db.executed.some((q) => q.includes('source_id IN ('))).toBe(true);
    expect(db.executed.some((q) => q.includes('SELECT * FROM memories WHERE id = ? AND retracted = 0'))).toBe(false);
  });

  it('roots traces to ancestors using batched depth traversal', async () => {
    const db = createGraphDb(memories, edges);
    const app = createTestApp('/api/roots', rootsRoute);

    const res = await app.request('http://localhost/api/roots/m3', {}, {
      DB: db as unknown as D1Database,
    } as any);

    expect(res.status).toBe(200);
    const json = await res.json() as { roots: Array<{ id: string }>; pathDepth: number };
    expect(json.roots.map((r) => r.id)).toEqual(['m1']);
    expect(json.pathDepth).toBe(2);

    expect(db.executed.some((q) => q.includes('target_id IN ('))).toBe(true);
    expect(db.executed.some((q) => q.includes('SELECT * FROM memories WHERE id IN ('))).toBe(true);
    expect(db.executed.some((q) => q.includes('SELECT * FROM memories WHERE id = ? AND retracted = 0'))).toBe(false);
  });
});
