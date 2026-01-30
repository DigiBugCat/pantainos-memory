/**
 * Internal API Routes for pantainos-memory
 *
 * These routes are called via service binding (e.g., from n8n).
 * They expose memory operations as simple HTTP endpoints.
 *
 * No authentication required - service bindings are trusted internal connections.
 *
 * All routes return JSON responses with consistent error handling.
 */

import { Hono } from 'hono';
import type { LoggingEnv } from '../lib/shared/hono/index.js';
import type { Env as BaseEnv, MemoryRow, ScoredMemory, RecordAccessParams } from '../types/index.js';
import type { Config } from '../lib/config.js';
import type { ExposureCheckJob } from '../lib/shared/types/index.js';

// Service imports for direct calls
import { generateId } from '../lib/id.js';
import { generateEmbedding, searchSimilar } from '../lib/embeddings.js';
import { storeObservationEmbeddings } from '../services/embedding-tables.js';
import { recordVersion } from '../services/history-service.js';
import { recordAccessBatch } from '../services/access-service.js';
import { rowToMemory } from '../lib/transforms.js';
import { createScoredMemory } from '../lib/scoring.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
};

const internalRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// Valid observation sources
const VALID_SOURCES = ['market', 'news', 'earnings', 'email', 'human', 'tool'] as const;

// =============================================================================
// Helper Functions
// =============================================================================

function errorResponse(c: { json: (data: unknown, status?: number) => Response }, message: string, status: number = 400) {
  return c.json({ success: false, error: message }, status);
}

function inferMemoryType(id: string): string {
  if (id.startsWith('obs-')) return 'obs';
  if (id.startsWith('infer-')) return 'assumption';
  if (id.startsWith('pred-')) return 'assumption';
  if (id.startsWith('assum-')) return 'assumption';
  return 'obs';
}

// =============================================================================
// Write Path - Create and Modify Memories
// =============================================================================

/**
 * POST /internal/observe
 * Record an observation from reality.
 */
internalRouter.post('/observe', async (c) => {
  const body = await c.req.json<{
    content: string;
    source: string;
    tags?: string[];
    session_id?: string;
  }>();

  const { content, source, tags, session_id: sessionId } = body;

  if (!content || !source) {
    return errorResponse(c, 'content and source are required');
  }

  if (!VALID_SOURCES.includes(source as typeof VALID_SOURCES[number])) {
    return errorResponse(c, `source must be one of: ${VALID_SOURCES.join(', ')}`);
  }

  const config = c.get('config');
  const requestId = c.get('requestId') || `internal-${Date.now()}`;
  const now = Date.now();
  const id = generateId('obs');

  // Store in D1
  await c.env.DB.prepare(
    `INSERT INTO memories (
      id, memory_type, content, source,
      confirmations, exposures, centrality, state, violations,
      retracted, tags, session_id, created_at
    ) VALUES (?, 'obs', ?, ?, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
  )
    .bind(id, content, source, tags ? JSON.stringify(tags) : null, sessionId || null, now)
    .run();

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: id,
    entityType: 'obs',
    changeType: 'created',
    contentSnapshot: {
      id,
      memory_type: 'obs',
      content,
      source,
      tags,
      confirmations: 0,
      exposures: 0,
      centrality: 0,
      state: 'active',
      violations: [],
      retracted: false,
    },
    sessionId,
    requestId,
  });

  // Generate embedding and store
  const { embedding } = await storeObservationEmbeddings(c.env, c.env.AI, config, {
    id,
    content,
    source,
    requestId,
  });

  // Queue exposure check
  const exposureJob: ExposureCheckJob = {
    memory_id: id,
    memory_type: 'obs',
    content,
    embedding,
    session_id: sessionId,
    request_id: requestId,
    timestamp: now,
  };

  await c.env.DETECTION_QUEUE.send(exposureJob);

  return c.json({
    success: true,
    id,
    exposure_check: 'queued',
  });
});

/**
 * POST /internal/assume
 * Create an assumption (derived belief that can be tested).
 */
internalRouter.post('/assume', async (c) => {
  const body = await c.req.json<{
    content: string;
    derived_from?: string[];
    invalidates_if?: string;
    confirms_if?: string;
    resolves_by?: number;
    tags?: string[];
    session_id?: string;
  }>();

  const { content, derived_from, invalidates_if, confirms_if, resolves_by, tags, session_id: sessionId } = body;

  if (!content) {
    return errorResponse(c, 'content is required');
  }

  const config = c.get('config');
  const requestId = c.get('requestId') || `internal-${Date.now()}`;
  const now = Date.now();
  // Use 'pred' for time-bound assumptions (with deadline), 'infer' for general
  const id = generateId(resolves_by ? 'pred' : 'infer');

  // Store in D1
  await c.env.DB.prepare(
    `INSERT INTO memories (
      id, memory_type, content,
      invalidates_if, confirms_if, resolves_by,
      confirmations, exposures, centrality, state, violations,
      retracted, tags, session_id, created_at
    ) VALUES (?, 'assumption', ?, ?, ?, ?, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
  )
    .bind(
      id,
      content,
      invalidates_if || null,
      confirms_if || null,
      resolves_by || null,
      tags ? JSON.stringify(tags) : null,
      sessionId || null,
      now
    )
    .run();

  // Create edges for derivations
  if (derived_from && derived_from.length > 0) {
    for (const sourceId of derived_from) {
      await c.env.DB.prepare(
        `INSERT INTO edges (source_id, target_id, strength, created_at)
        VALUES (?, ?, 1.0, ?)`
      )
        .bind(sourceId, id, now)
        .run();
    }
  }

  // Record version
  await recordVersion(c.env.DB, {
    entityId: id,
    entityType: 'assumption',
    changeType: 'created',
    contentSnapshot: { id, content, derived_from, invalidates_if, confirms_if, resolves_by, tags },
    sessionId,
    requestId,
  });

  // Generate embedding and store
  const embedding = await generateEmbedding(c.env.AI, content, config, requestId);

  // Store in MEMORY_VECTORS
  await c.env.MEMORY_VECTORS.upsert([
    {
      id,
      values: embedding,
      metadata: { type: 'assumption' },
    },
  ]);

  // Store invalidates_if in INVALIDATES_VECTORS if present
  if (invalidates_if) {
    const invEmbedding = await generateEmbedding(c.env.AI, invalidates_if, config, requestId);
    await c.env.INVALIDATES_VECTORS.upsert([
      {
        id: `${id}:inv`,
        values: invEmbedding,
        metadata: { memory_id: id },
      },
    ]);
  }

  // Store confirms_if in CONFIRMS_VECTORS if present
  if (confirms_if) {
    const confEmbedding = await generateEmbedding(c.env.AI, confirms_if, config, requestId);
    await c.env.CONFIRMS_VECTORS.upsert([
      {
        id: `${id}:conf`,
        values: confEmbedding,
        metadata: { memory_id: id },
      },
    ]);
  }

  return c.json({
    success: true,
    id,
    derived_from: derived_from || [],
  });
});

/**
 * POST /internal/find
 * Semantic search across all memories.
 */
internalRouter.post('/find', async (c) => {
  const body = await c.req.json<{
    query: string;
    types?: string[];
    limit?: number;
    min_similarity?: number;
    session_id?: string;
  }>();

  const { query, types, limit: requestedLimit, min_similarity, session_id: sessionId } = body;

  if (!query) {
    return errorResponse(c, 'query is required');
  }

  const config = c.get('config');
  const requestId = c.get('requestId') || `internal-${Date.now()}`;

  const limit = requestedLimit || config.search.defaultLimit;
  const minSimilarity = min_similarity || config.search.minSimilarity;
  const memoryTypes = types || ['obs', 'assumption'];

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(c.env.AI, query, config, requestId);

  // Search Vectorize
  const searchResults = await searchSimilar(c.env, queryEmbedding, limit * 2, minSimilarity, requestId);

  // Fetch memory details and filter
  const results: ScoredMemory[] = [];

  for (const match of searchResults) {
    if (results.length >= limit) break;

    const memoryType = inferMemoryType(match.id);
    if (!memoryTypes.includes(memoryType as string)) continue;

    const row = await c.env.DB.prepare(`SELECT * FROM memories WHERE id = ? AND retracted = 0`)
      .bind(match.id)
      .first<MemoryRow>();

    if (!row) continue;

    const memory = rowToMemory(row);
    const scoredMemory = createScoredMemory(memory, match.similarity, config);
    results.push(scoredMemory);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Record access events
  if (results.length > 0) {
    const accessEvents: RecordAccessParams[] = results.map((result, index) => ({
      entityId: result.memory.id,
      entityType: result.memory.memory_type,
      accessType: 'find' as const,
      sessionId,
      requestId,
      queryText: query,
      resultRank: index + 1,
      similarityScore: result.similarity,
    }));
    await recordAccessBatch(c.env.DB, accessEvents);
  }

  return c.json({
    results: results.map((r) => ({
      id: r.memory.id,
      content: r.memory.content,
      type: r.memory.memory_type,
      score: r.score,
      similarity: r.similarity,
      confidence: r.confidence,
    })),
    query,
    total: results.length,
  });
});

/**
 * POST /internal/recall
 * Retrieve a specific memory by ID.
 */
internalRouter.post('/recall', async (c) => {
  const body = await c.req.json<{ memory_id: string }>();
  const { memory_id } = body;

  if (!memory_id) {
    return errorResponse(c, 'memory_id is required');
  }

  const row = await c.env.DB.prepare(`SELECT * FROM memories WHERE id = ?`).bind(memory_id).first<MemoryRow>();

  if (!row) {
    return errorResponse(c, `Memory not found: ${memory_id}`, 404);
  }

  const memory = rowToMemory(row);

  // Get connected memories
  const edges = await c.env.DB.prepare(`SELECT target_id, strength FROM edges WHERE source_id = ?`)
    .bind(memory_id)
    .all<{ target_id: string; strength: number }>();

  return c.json({
    memory,
    connections: edges.results || [],
  });
});

/**
 * GET /internal/stats
 * Get memory statistics.
 */
internalRouter.get('/stats', async (c) => {
  // Count memories by type
  const memoryCounts = await c.env.DB.prepare(
    `SELECT memory_type, COUNT(*) as count FROM memories WHERE retracted = 0 GROUP BY memory_type`
  ).all<{ memory_type: string; count: number }>();

  const counts = Object.fromEntries((memoryCounts.results || []).map((r) => [r.memory_type, r.count]));

  // Count edges
  const edgeCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM edges').first<{ count: number }>();

  return c.json({
    memories: {
      obs: counts.obs || 0,
      assumption: counts.assumption || 0,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
    },
    edges: edgeCount?.count || 0,
  });
});

export default internalRouter;
