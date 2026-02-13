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
import type { Env, FindRequest, FindResponse, ScoredMemory, MemoryRow, RecordAccessParams } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateEmbedding, searchSimilar } from '../../lib/embeddings.js';
import { logField } from '../../lib/shared/logging/index.js';
import { recordAccessBatch } from '../../services/access-service.js';
import { rowToMemory } from '../../lib/transforms.js';
import { createScoredMemory } from '../../lib/scoring.js';
import { getMaxTimesTested } from '../../jobs/compute-stats.js';
import { getDisplayType } from '../../lib/shared/types/index.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
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

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(c.env.AI, body.query, config, requestId);

  // Search Vectorize
  const searchResults = await searchSimilar(
    c.env,
    queryEmbedding,
    limit * 2, // Get more to allow for filtering
    minSimilarity,
    requestId
  );

  // Get max_times_tested from system_stats for proper confidence normalization
  const maxTimesTested = await getMaxTimesTested(c.env.DB);

  // Fetch memory details and filter
  const results: ScoredMemory[] = [];

  for (const match of searchResults) {
    if (results.length >= limit) break;

    // Fetch from unified memories table
    const row = await c.env.DB.prepare(
      `SELECT * FROM memories WHERE id = ? ${includeRetracted ? '' : 'AND retracted = 0'}`
    ).bind(match.id).first<MemoryRow>();

    if (!row) continue;

    // Filter by field presence (legacy type filters)
    const hasSource = row.source != null;
    const hasResolveBy = row.resolves_by != null;
    const hasDerived = row.derived_from != null;
    if (hasSource && !allowObservations) continue;
    if (!hasSource && hasDerived && !hasResolveBy && !allowThoughts) continue;
    if (hasResolveBy && !allowPredictions) continue;

    const memory = rowToMemory(row);
    const scoredMemory = createScoredMemory(memory, match.similarity, config, maxTimesTested);
    results.push(scoredMemory);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

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
