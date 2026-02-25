import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockD1 } from '../lib/shared/testing/d1-mock.js';
import type { MockD1Database } from '../lib/shared/testing/d1-mock.js';
import { claimEventsForDispatch } from './event-queue.js';

vi.mock('../lib/lazy-logger.js', () => ({
  createLazyLogger: () => () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('claimEventsForDispatch', () => {
  let db: MockD1Database;
  let env: { DB: D1Database };

  beforeEach(() => {
    db = createMockD1();
    env = { DB: db as unknown as D1Database };
  });

  it('returns empty when no undispatched events were claimed', async () => {
    db._setQueryResult('UPDATE memory_events', {
      runResult: { success: true, meta: { changes: 0 } },
    });

    const claimed = await claimEventsForDispatch(env as any, 'session-a', 'claim-1');

    expect(claimed).toEqual([]);
    const executed = db._getExecutedQueries();
    expect(executed.some((q) => q.includes('UPDATE memory_events'))).toBe(true);
    expect(executed.some((q) => q.includes('WHERE session_id = ? AND workflow_id = ?'))).toBe(false);
  });

  it('claims first by workflow id, then selects only rows owned by that claim', async () => {
    db._setQueryResult('UPDATE memory_events', {
      runResult: { success: true, meta: { changes: 2 } },
    });
    db._setQueryResult('WHERE session_id = ? AND workflow_id = ? AND dispatched = 1', {
      allResults: [
        {
          id: 'evt-1',
          session_id: 'session-a',
          event_type: 'violation',
          memory_id: 'mem-1',
          violated_by: 'obs-1',
          damage_level: 'core',
          context: '{}',
          created_at: 1,
        },
        {
          id: 'evt-2',
          session_id: 'session-a',
          event_type: 'thought:pending_resolution',
          memory_id: 'mem-2',
          violated_by: null,
          damage_level: null,
          context: '{}',
          created_at: 2,
        },
      ],
    });

    const claimed = await claimEventsForDispatch(env as any, 'session-a', 'claim-42');

    expect(claimed).toHaveLength(2);
    expect(claimed.map((e) => e.id)).toEqual(['evt-1', 'evt-2']);

    const executed = db._getExecutedQueries();
    const updateIdx = executed.findIndex((q) => q.includes('UPDATE memory_events'));
    const selectIdx = executed.findIndex((q) => q.includes('WHERE session_id = ? AND workflow_id = ? AND dispatched = 1'));
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(updateIdx);
  });
});
