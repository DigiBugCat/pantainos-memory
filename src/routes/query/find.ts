/**
 * Find Route - POST /api/find
 *
 * Semantic search across memories using the new confidence model.
 *
 * Flow:
 * 1. Generate embedding for query
 * 2. Search Vectorize
 * 3. Filter by types if specified
 * 4. Score and rank results using confidence model
 * 5. Return ranked results
 */

import { Hono } from 'hono';
import type { Env, FindRequest, FindResponse, RecordAccessParams } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { logField } from '../../lib/shared/logging/index.js';
import { recordAccessBatch } from '../../services/access-service.js';
import { getMaxTimesTested } from '../../jobs/compute-stats.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { findMemories } from '../../usecases/find-memories.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  agentId: string;
  memoryScope: string[];
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');

  // Validate request
  let body: FindRequest;
  try {
    body = await c.req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      logField(c, 'json_parse_warning', error instanceof Error ? error.message : 'unknown');
    }
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.query || typeof body.query !== 'string') {
    return c.json({ success: false, error: 'query is required' }, 400);
  }

  const limit = body.limit || config.search.defaultLimit;
  const minSimilarity = body.min_similarity || config.search.minSimilarity;
  const includeRetracted = body.include_retracted || false;

  // Build type filter from filter object
  // Default: include all types if no filter specified
  const allowObservations = !body.filter || body.filter.observations_only || (!body.filter.thoughts_only && !body.filter.predictions_only);
  const allowThoughts = !body.filter || body.filter.thoughts_only || (!body.filter.observations_only && !body.filter.predictions_only);
  const allowPredictions = !body.filter || body.filter.predictions_only || (!body.filter.observations_only && !body.filter.thoughts_only);

  // Get max_times_tested from system_stats for proper confidence normalization
  const maxTimesTested = await getMaxTimesTested(c.env.DB);

  const memoryScope = c.get('memoryScope');

  const results = await findMemories(c.env, config, {
    query: body.query,
    limit,
    minSimilarity,
    includeRetracted,
    requestId,
    candidateMultiplier: 2,
    maxTimesTested,
    agentIds: memoryScope,
    filter: (row) => {
      const hasSource = row.source != null;
      const hasResolveBy = row.resolves_by != null;
      const hasDerived = row.derived_from != null;
      if (hasSource && !allowObservations) return false;
      if (!hasSource && hasDerived && !hasResolveBy && !allowThoughts) return false;
      if (hasResolveBy && !allowPredictions) return false;
      return true;
    },
  });

  // Record access events for all returned results
  if (results.length > 0) {
    const accessEvents: RecordAccessParams[] = results.map((result, index) => ({
      entityId: result.memory.id,
      entityType: getDisplayType(result.memory),
      accessType: 'find' as const,
      sessionId,
      requestId,
      userAgent,
      ipHash,
      queryText: body.query,
      resultRank: index + 1,
      similarityScore: result.similarity,
    }));
    await recordAccessBatch(c.env.DB, accessEvents);
  }

  const response: FindResponse = {
    results,
    query: body.query,
    total: results.length,
  };

  return c.json(response);
});

export default app;
