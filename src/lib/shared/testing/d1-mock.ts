/**
 * D1 Database mock helpers for testing
 *
 * Provides a mock D1Database for unit testing workers that use Cloudflare D1.
 * Supports configurable query results and tracks all executed queries.
 */
import { vi } from 'vitest';

type FirstResult = Record<string, unknown> | null;
type AllResults = Record<string, unknown>[];
type RunResult = { success: boolean; meta: { changes: number } };

interface MockStatementOptions {
  firstResult?: FirstResult;
  allResults?: AllResults;
  runResult?: RunResult;
}

// Use simplified types that work with vitest mocks
// For test utilities, we use 'any' to avoid complex mock type gymnastics
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface MockD1Statement {
  bind: any;
  first: any;
  all: any;
  run: any;
  raw: any;
}

export interface MockD1Database {
  prepare: any;
  batch: any;
  exec: any;
  dump: any;
  _statements: Map<string, MockD1Statement>;
  _getMockStatement: (sql: string) => MockD1Statement;
  _setQueryResult: (sqlPattern: string, result: MockStatementOptions) => void;
  _getExecutedQueries: () => string[];
  _reset: () => void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Creates a mock D1 database for testing.
 *
 * @returns MockD1Database with helper methods for setting up query results
 */
export function createMockD1(): MockD1Database {
  const statements = new Map<string, MockD1Statement>();
  const executedQueries: string[] = [];

  // Default statement factory
  const createMockStatement = (
    options: MockStatementOptions = {},
    sql?: string
  ): MockD1Statement => {
    const mockStatement: MockD1Statement = {
      bind: vi.fn(),
      first: vi.fn().mockImplementation(async () => {
        if (sql) executedQueries.push(sql);
        return options.firstResult ?? null;
      }),
      all: vi.fn().mockImplementation(async () => {
        if (sql) executedQueries.push(sql);
        return { results: options.allResults ?? [] };
      }),
      run: vi.fn().mockImplementation(async () => {
        if (sql) executedQueries.push(sql);
        return options.runResult ?? { success: true, meta: { changes: 0 } };
      }),
      raw: vi.fn().mockResolvedValue([]),
    };

    // Make bind return this for chaining
    mockStatement.bind.mockReturnValue(mockStatement);

    return mockStatement;
  };

  const mockDb: MockD1Database = {
    prepare: vi.fn((sql: string) => {
      // Check if we have a configured mock for this SQL (pattern matching)
      for (const [pattern, statement] of statements) {
        if (sql.includes(pattern)) {
          return statement;
        }
      }
      // Return default statement that tracks the query
      return createMockStatement({}, sql);
    }),

    batch: vi.fn().mockImplementation(async (stmts: MockD1Statement[]) => {
      // Execute all statements and return results
      const results = [];
      for (const stmt of stmts) {
        // Cast to callable function since vitest Mock types can be tricky
        const allFn = stmt.all as unknown as () => Promise<unknown>;
        results.push(await allFn());
      }
      return results;
    }),

    exec: vi.fn().mockResolvedValue({ count: 1, duration: 0 }),

    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),

    _statements: statements,

    _getMockStatement: (sql: string) => {
      const existing = statements.get(sql);
      if (existing) return existing;

      const statement = createMockStatement({}, sql);
      statements.set(sql, statement);
      return statement;
    },

    _setQueryResult: (sqlPattern: string, result: MockStatementOptions) => {
      const statement = createMockStatement(result, sqlPattern);
      statements.set(sqlPattern, statement);
    },

    _getExecutedQueries: () => [...executedQueries],

    _reset: () => {
      statements.clear();
      executedQueries.length = 0;
    },
  };

  return mockDb;
}

/**
 * Create a test encryption key (64 hex chars = 32 bytes)
 * For use in tests that need TOKEN_ENCRYPTION_KEY
 */
export const TEST_ENCRYPTION_KEY = 'a'.repeat(64);
