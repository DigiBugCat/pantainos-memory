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
import type { Env, FindRequest, FindResponse, ScoredMemory, MemoryRow, MemoryType, RecordAccessParams } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateEmbedding, searchSimilar } from '../../lib/embeddings.js';
import { recordAccessBatch } from '../../services/access-service.js';
import { rowToMemory } from '../../lib/transforms.js';
import { createScoredMemory } from '../../lib/scoring.js';

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
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.query || typeof body.query !== 'string') {
    return c.json({ success: false, error: 'query is required' }, 400);
  }

  const limit = body.limit || config.search.defaultLimit;
  const minSimilarity = body.min_similarity || config.search.minSimilarity;
  const types = body.types || ['obs', 'assumption'];
  const includeRetracted = body.include_retracted || false;

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

  // Fetch memory details and filter
  const results: ScoredMemory[] = [];

  for (const match of searchResults) {
    if (results.length >= limit) break;

    const memoryType = inferMemoryType(match.id);
    if (!types.includes(memoryType)) continue;

    // Fetch from unified memories table
    const row = await c.env.DB.prepare(
      `SELECT * FROM memories WHERE id = ? ${includeRetracted ? '' : 'AND retracted = 0'}`
    ).bind(match.id).first<MemoryRow>();

    if (!row) continue;

    const memory = rowToMemory(row);
    const scoredMemory = createScoredMemory(memory, match.similarity, config);
    results.push(scoredMemory);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Record access events for all returned results
  if (results.length > 0) {
    const accessEvents: RecordAccessParams[] = results.map((result, index) => ({
      entityId: result.memory.id,
      entityType: result.memory.memory_type,
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

/**
 * Infer memory type from ID prefix.
 * v4: Both infer- and pred- prefixes map to 'assumption' type.
 */
function inferMemoryType(id: string): MemoryType {
  if (id.startsWith('obs-')) return 'obs';
  // Both infer- and pred- prefixes are assumptions
  if (id.startsWith('infer-')) return 'assumption';
  if (id.startsWith('pred-')) return 'assumption';
  // Legacy prefixes map to obs or assumption
  if (id.startsWith('mem-')) return 'obs';
  if (id.startsWith('thought-') || id.startsWith('note-')) return 'assumption';
  return 'obs'; // Default
}

export default app;
