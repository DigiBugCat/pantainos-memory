/**
 * Testing utilities for Cloudflare Workers
 *
 * Provides mocks for D1 and Vectorize to enable unit testing
 * without requiring actual Cloudflare infrastructure.
 */

export { createMockD1, TEST_ENCRYPTION_KEY } from './d1-mock.js';
export type { MockD1Database, MockD1Statement } from './d1-mock.js';

export { createMockVectorize, createTestEmbedding } from './vectorize-mock.js';
export type { MockVectorizeIndex } from './vectorize-mock.js';
