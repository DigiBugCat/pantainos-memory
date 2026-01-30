/**
 * Experiment API Routes (Placeholder)
 *
 * This is a minimal placeholder for the experiments framework.
 * The full implementation can be ported from the archive when needed.
 *
 * The experiments framework provides:
 * - LLM-judge accuracy testing across models
 * - Prompt variant comparison
 * - Thinking level analysis
 * - Baseline comparison and regression detection
 */

import { Hono } from 'hono';
import type { Env } from '../types/index.js';

const experiments = new Hono<{ Bindings: Env }>();

/**
 * GET /api/experiments/info
 * Returns available options and placeholder status
 */
experiments.get('/info', (c) => {
  return c.json({
    status: 'placeholder',
    message: 'Full experiments framework not yet ported. See the archive (cassandra-toolkit-dev/archive/main/apps/cassandra-memory/src/experiments/) for full implementation.',
    availableEndpoints: [
      '/api/experiments/info - This endpoint',
      '/api/experiments/run - Run experiments (not yet implemented)',
      '/api/experiments/quick - Quick test (not yet implemented)',
      '/api/experiments/history - View past runs (not yet implemented)',
    ],
  });
});

/**
 * GET /api/experiments/run
 * Placeholder - returns not implemented
 */
experiments.get('/run', (c) => {
  return c.json({
    error: 'Not implemented',
    message: 'Port experiments from the archive (cassandra-toolkit-dev/archive/main/apps/cassandra-memory/src/experiments/) to enable this endpoint.',
  }, 501);
});

/**
 * GET /api/experiments/quick
 * Placeholder - returns not implemented
 */
experiments.get('/quick', (c) => {
  return c.json({
    error: 'Not implemented',
    message: 'Port experiments from the archive (cassandra-toolkit-dev/archive/main/apps/cassandra-memory/src/experiments/) to enable this endpoint.',
  }, 501);
});

export default experiments;
