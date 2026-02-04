/**
 * Query Routes - Cognitive Loop Architecture (v4)
 *
 * Read path for the 2-primitive model:
 * - /find - Semantic search across memories
 * - /recall/:id - Retrieve a memory with connections
 * - /reference/:id - Graph traversal (ancestors/descendants)
 * - /between - Find bridging memories
 * - /pending - List overdue predictions
 * - /insights/:view - Analytical views
 * - /knowledge - Topic depth assessment
 * - /brittle - Low-exposure thoughts
 * - /graveyard - Retracted/violated memories
 * - /collisions - Duplicate detection
 * - /roots/:id - Find root observations
 * - /stats - System statistics
 * - /history/:id - Version history
 * - /access-log/:id - Access audit trail
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import findRoute from './find.js';
import recallRoute from './recall.js';
import referenceRoute from './reference.js';
import betweenRoute from './between.js';
import pendingRoute from './pending.js';
import collisionsRoute from './collisions.js';
import insightsRoute from './insights.js';
import rootsRoute from './roots.js';
import knowledgeRoute from './knowledge.js';
import brittleRoute from './brittle.js';
import graveyardRoute from './graveyard.js';
import historyRoute from './history.js';
import accessLogRoute from './access-log.js';
import statsRoute from './stats.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Mount query routes
app.route('/find', findRoute);
app.route('/recall', recallRoute);
app.route('/reference', referenceRoute);
app.route('/between', betweenRoute);
app.route('/pending', pendingRoute);
app.route('/collisions', collisionsRoute);
app.route('/insights', insightsRoute);
app.route('/roots', rootsRoute);
app.route('/knowledge', knowledgeRoute);
app.route('/brittle', brittleRoute);
app.route('/graveyard', graveyardRoute);

// History and audit routes
app.route('/history', historyRoute);
app.route('/access-log', accessLogRoute);

// Stats route
app.route('/stats', statsRoute);

export default app;
