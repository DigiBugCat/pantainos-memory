/**
 * Flow Routes - Cognitive Loop Architecture (v4)
 *
 * Write path for the 2-primitive model:
 * - /observe - Create observations (intake from reality)
 * - /assume - Create assumptions (unified: general or time-bound)
 * - /confirm/:id - Manual confirmation
 * - /violate/:id - Manual violation
 * - /retract/:id - Retract an observation
 */

import { Hono } from 'hono';
import { bodyLimitPresets, memoryFieldLimits } from '../../lib/shared/middleware/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import observeRoute from './observe.js';
import assumeRoute from './assume.js';
import confirmRoute from './confirm.js';
import violateRoute from './violate.js';
import retractRoute from './retract.js';
import cascadeEventsRoute from './cascade-events.js';
import cascadeApplyRoute from './cascade-apply.js';
import reclassifyToObservationRoute from './reclassify-to-observation.js';
import reclassifyToAssumptionRoute from './reclassify-to-assumption.js';

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

// Mount flow routes (v4 architecture)
app.route('/observe', observeRoute);
app.route('/assume', assumeRoute);
app.route('/confirm', confirmRoute);
app.route('/violate', violateRoute);
app.route('/retract', retractRoute);

// Cascade routes (for processing cascade events)
app.route('/cascade', cascadeEventsRoute);
app.route('/cascade', cascadeApplyRoute);

// Reclassify routes (for converting between memory types)
app.route('/reclassify-to-observation', reclassifyToObservationRoute);
app.route('/reclassify-to-assumption', reclassifyToAssumptionRoute);

export default app;
