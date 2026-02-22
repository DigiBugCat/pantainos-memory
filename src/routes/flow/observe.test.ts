import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { getConfig } from '../../lib/config.js';

vi.mock('../../lib/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  checkDuplicate: vi.fn().mockResolvedValue({ id: null, similarity: 0 }),
  checkDuplicateWithLLM: vi.fn().mockResolvedValue({ isDuplicate: false, confidence: 0, reasoning: '' }),
}));

vi.mock('../../services/classification-challenge.js', () => ({
  checkMemoryCompleteness: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/history-service.js', () => ({
  recordVersion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../jobs/compute-stats.js', () => ({
  getStartingConfidenceForSource: vi.fn().mockResolvedValue(0.75),
}));

function createDbMock() {
  const executedRuns: string[] = [];
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn(async () => {
        executedRuns.push(sql);
        return { success: true, meta: { changes: 1 } };
      }),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
    };
    return stmt;
  });

  return { prepare, executedRuns, batch: vi.fn().mockResolvedValue([]) };
}

async function createObserveApp() {
  const observeModule = await import('./observe.js');
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('config', getConfig({}));
    c.set('requestId', 'req-test');
    c.set('sessionId', 'session-test');
    c.set('userAgent', 'vitest');
    c.set('ipHash', 'abc123');
    await next();
  });
  app.route('/api/observe', observeModule.default);
  return app;
}

describe('POST /api/observe', () => {
  it('returns 201 immediately for active memories (optimistic)', async () => {
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const waitUntilFns: Promise<unknown>[] = [];

    const db = createDbMock();
    const env = {
      DB: db as unknown as D1Database,
      AI: {},
      MEMORY_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue({ matches: [] }) },
      INVALIDATES_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      CONFIRMS_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      DETECTION_QUEUE: { send: queueSend },
    };

    const app = await createObserveApp();

    // Patch executionCtx to capture waitUntil
    const originalFetch = app.fetch.bind(app);
    const patchedApp = {
      request: async (url: string, init: any, envArg: any) => {
        // Hono's app.request doesn't provide executionCtx, so the route
        // will use the default. We verify via response status.
        return app.request(url, init, envArg);
      }
    };

    const res = await app.request(
      'http://localhost/api/observe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'Revenue rose 5% YoY.',
          source: 'market',
        }),
      },
      env as any
    );

    // Response should be 201 immediately
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('active');
    expect(body.id).toBeDefined();
  });

  it('returns 201 with draft status and warnings when completeness check fails', async () => {
    const { checkMemoryCompleteness } = await import('../../services/classification-challenge.js');
    (checkMemoryCompleteness as any).mockResolvedValueOnce({
      is_complete: false,
      missing_fields: [{ field: 'invalidates_if', reason: 'no falsifiability conditions' }],
      reasoning: 'Missing conditions',
    });

    const db = createDbMock();
    const env = {
      DB: db as unknown as D1Database,
      AI: {},
      MEMORY_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue({ matches: [] }) },
      INVALIDATES_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      CONFIRMS_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      DETECTION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    };

    const app = await createObserveApp();
    const res = await app.request(
      'http://localhost/api/observe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'A thought without conditions',
          source: 'agent',
        }),
      },
      env as any
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('draft');
    expect(body.warnings).toBeDefined();
    expect(body.warnings.missing_fields).toHaveLength(1);
    // Draft path is blocking — D1 insert should have happened
    expect(db.executedRuns.some((sql: string) => sql.includes('INSERT'))).toBe(true);
  });
});
