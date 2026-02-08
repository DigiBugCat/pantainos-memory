/**
 * Global test setup for vitest.
 * Referenced by vitest.config.ts setupFiles.
 */

// Stub Cloudflare Workers globals that aren't available in Node.js
// @ts-expect-error - globalThis augmentation for tests
globalThis.Response ??= class Response {
  status: number;
  body: unknown;
  constructor(body?: unknown, init?: { status?: number }) {
    this.body = body;
    this.status = init?.status ?? 200;
  }
};

// @ts-expect-error - globalThis augmentation for tests
globalThis.Request ??= class Request {
  url: string;
  method: string;
  constructor(url: string, init?: { method?: string }) {
    this.url = url;
    this.method = init?.method ?? 'GET';
  }
};
