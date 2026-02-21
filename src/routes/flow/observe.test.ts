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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createDbMock(runHandlers: Array<(sql: string) => Promise<unknown>>) {
  const executedRuns: string[] = [];
  const prepare = vi.fn((sql: string) => {
    const stmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn(async () => {
        executedRuns.push(sql);
        for (const handler of runHandlers) {
          const maybe = await handler(sql);
          if (maybe !== undefined) return maybe;
        }
        return { success: true, meta: { changes: 1 } };
      }),
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
    };
    return stmt;
  });

  return { prepare, executedRuns };
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

describe('POST /api/observe ordering', () => {
  it('enqueues only after D1 write and vector upsert finish', async () => {
    const d1 = deferred<{ success: true; meta: { changes: number } }>();
    const vector = deferred<void>();
    const queueSend = vi.fn().mockResolvedValue(undefined);

    const db = createDbMock([
      async (sql) => {
        if (sql.includes('INSERT INTO memories')) return d1.promise;
        return undefined;
      },
    ]);

    const env = {
      DB: db as unknown as D1Database,
      AI: {},
      MEMORY_VECTORS: { upsert: vi.fn().mockImplementation(() => vector.promise), query: vi.fn().mockResolvedValue({ matches: [] }) },
      INVALIDATES_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      CONFIRMS_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      DETECTION_QUEUE: { send: queueSend },
    };

    const app = await createObserveApp();
    const reqPromise = app.request(
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

    await Promise.resolve();
    expect(queueSend).not.toHaveBeenCalled();

    d1.resolve({ success: true, meta: { changes: 1 } });
    await Promise.resolve();
    expect(queueSend).not.toHaveBeenCalled();

    vector.resolve();
    const res = await reqPromise;
    expect(res.status).toBe(201);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it('keeps exposure status pending if queue enqueue fails after persistence', async () => {
    const queueSend = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const db = createDbMock([
      async (_sql) => undefined,
    ]);

    const env = {
      DB: db as unknown as D1Database,
      AI: {},
      MEMORY_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue({ matches: [] }) },
      INVALIDATES_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      CONFIRMS_VECTORS: { upsert: vi.fn().mockResolvedValue(undefined) },
      DETECTION_QUEUE: { send: queueSend },
    };

    const app = await createObserveApp();
    const res = await app.request(
      'http://localhost/api/observe',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: 'A new observation',
          source: 'market',
        }),
      },
      env as any
    );

    expect(res.status).toBe(500);
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(db.executedRuns.some((sql) => sql.includes("SET exposure_check_status = 'pending'"))).toBe(true);
  });
});
