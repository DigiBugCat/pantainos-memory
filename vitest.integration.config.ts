import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/integration/**/*.integration.test.ts'],
    globals: true,
    testTimeout: 30000, // 30s for network calls
    hookTimeout: 60000, // 60s for setup/teardown
    sequence: {
      concurrent: false, // Run tests sequentially to avoid race conditions
    },
  },
});
