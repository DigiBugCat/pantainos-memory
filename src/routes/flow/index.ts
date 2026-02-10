/**
 * Flow Routes - Unified Memory Model
 *
 * Write path for the memory system:
 * - /observe - Create memories (unified: observations OR thoughts based on field presence)
 * - /confirm/:id - Manual confirmation
 * - /violate/:id - Manual violation
 * - /retract/:id - Retract an observation
 *
 * Memory type is determined by field presence:
 * - source → observation
 * - derived_from → thought
 * - derived_from + resolves_by → time-bound thought (prediction)
 */

import { Hono } from 'hono';
import { bodyLimitPresets, memoryFieldLimits } from '../../lib/shared/middleware/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import observeRoute from './observe.js';
import confirmRoute from './confirm.js';
import violateRoute from './violate.js';
import retractRoute from './retract.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Note: Rate limiting removed - will use metrics/alarms instead
// Embedding generation costs are tracked via AI Gateway metrics

// Body size limit: 50KB max for memory operations
// Prevents DoS via large payloads that generate expensive embeddings
app.use('*', bodyLimitPresets.memory());

// Field length limits: prevent oversized content fields
// Content is limited to 10K chars, which is ~40KB of embedding data
app.use('*', memoryFieldLimits);

// Mount flow routes
// /observe handles both observations (source) and thoughts (derived_from)
app.route('/observe', observeRoute);
app.route('/confirm', confirmRoute);
app.route('/violate', violateRoute);
app.route('/retract', retractRoute);

export default app;
