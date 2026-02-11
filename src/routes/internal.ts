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
import { getDisplayType } from '../lib/shared/types/index.js';

// Service imports for direct calls
import { generateId } from '../lib/id.js';
import { generateEmbedding, searchSimilar } from '../lib/embeddings.js';
import { storeObservationEmbeddings, storeObservationWithConditions, storeThoughtEmbeddings } from '../services/embedding-tables.js';
import { incrementCentrality } from '../services/exposure-checker.js';
import { TYPE_STARTING_CONFIDENCE } from '../services/confidence.js';
import { getStartingConfidenceForSource } from '../jobs/compute-stats.js';
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

/**
 * Get the filter type from a memory row based on field presence.
 * Maps to the types used in find filters: 'obs' or 'thought'.
 * Predictions are a subtype of thought for filtering purposes.
 */
function getFilterType(row: MemoryRow): 'obs' | 'thought' {
  // Observation: has source
  if (row.source != null) return 'obs';
  // Thought (including predictions): has derived_from
  return 'thought';
}

// =============================================================================
// Write Path - Create and Modify Memories
// =============================================================================

/**
 * POST /internal/observe
 * Unified memory creation endpoint.
 * Creates observations, thoughts/predictions, or hybrids (source + derived_from).
 */
internalRouter.post('/observe', async (c) => {
  const body = await c.req.json<{
    content: string;
    source?: string;
    derived_from?: string[];
    assumes?: string[];
    invalidates_if?: string[];
    confirms_if?: string[];
    outcome_condition?: string;
    resolves_by?: number;
    tags?: string[];
    session_id?: string;
  }>();

  const {
    content,
    source,
    derived_from,
    assumes,
    invalidates_if,
    confirms_if,
    outcome_condition,
    resolves_by,
    tags,
    session_id: sessionId,
  } = body;

  if (!content) {
    return errorResponse(c, 'content is required');
  }

  // Validate origin: at least one of source or derived_from
  const hasSource = source !== undefined && source !== null;
  const hasDerivedFrom = derived_from !== undefined && derived_from !== null && derived_from.length > 0;

  if (!hasSource && !hasDerivedFrom) {
    return errorResponse(c, 'Either "source" or "derived_from" is required');
  }

  // Field-specific validation
  if (hasSource) {
    if (!VALID_SOURCES.includes(source as typeof VALID_SOURCES[number])) {
      return errorResponse(c, `source must be one of: ${VALID_SOURCES.join(', ')}`);
    }
  }

  if (hasDerivedFrom) {
    const placeholders = derived_from!.map(() => '?').join(',');
    const sources = await c.env.DB.prepare(
      `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
    ).bind(...derived_from!).all<{ id: string }>();

    if (!sources.results || sources.results.length !== derived_from!.length) {
      const foundIds = new Set(sources.results?.map((r) => r.id) || []);
      const missing = derived_from!.filter((id) => !foundIds.has(id));
      return errorResponse(c, `Source memories not found: ${missing.join(', ')}`, 404);
    }
  }

  // Time-bound validation
  const timeBound = resolves_by !== undefined;
  if (timeBound && !outcome_condition) {
    return errorResponse(c, 'outcome_condition is required when resolves_by is set');
  }

  const config = c.get('config');
  const requestId = c.get('requestId') || `internal-${Date.now()}`;
  const now = Date.now();
  const id = generateId();

  // Determine starting confidence
  let startingConfidence: number;
  if (hasSource) {
    startingConfidence = await getStartingConfidenceForSource(c.env.DB, source!);
  } else {
    startingConfidence = timeBound ? TYPE_STARTING_CONFIDENCE.predict : TYPE_STARTING_CONFIDENCE.think;
  }

  // Unified INSERT into memories table
  await c.env.DB.prepare(
    `INSERT INTO memories (
      id, content, source, derived_from,
      assumes, invalidates_if, confirms_if,
      outcome_condition, resolves_by,
      starting_confidence, confirmations, times_tested, contradictions,
      centrality, state, violations,
      retracted, tags, session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
  ).bind(
    id,
    content,
    hasSource ? source : null,
    hasDerivedFrom ? JSON.stringify(derived_from) : null,
    assumes ? JSON.stringify(assumes) : null,
    invalidates_if ? JSON.stringify(invalidates_if) : null,
    confirms_if ? JSON.stringify(confirms_if) : null,
    outcome_condition || null,
    resolves_by || null,
    startingConfidence,
    tags ? JSON.stringify(tags) : null,
    sessionId || null,
    now
  ).run();

  // For thoughts: create derivation edges and increment centrality
  if (hasDerivedFrom) {
    for (const sourceId of derived_from!) {
      const edgeId = generateId();
      await c.env.DB.prepare(
        `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
         VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
      ).bind(edgeId, sourceId, id, now).run();

      await incrementCentrality(c.env.DB, sourceId);
    }
  }

  // Record version for audit trail
  const entityType = hasSource ? 'observation' : (timeBound ? 'prediction' : 'thought');
  await recordVersion(c.env.DB, {
    entityId: id,
    entityType,
    changeType: 'created',
    contentSnapshot: {
      id,
      content,
      source: hasSource ? source : undefined,
      derived_from: hasDerivedFrom ? derived_from : undefined,
      assumes,
      invalidates_if,
      confirms_if,
      outcome_condition,
      resolves_by,
      tags,
      starting_confidence: startingConfidence,
    },
    sessionId,
    requestId,
  });

  // Store embeddings based on mode
  const hasConditions = (invalidates_if && invalidates_if.length > 0) ||
    (confirms_if && confirms_if.length > 0);

  let embedding: number[];

  if (hasSource) {
    // Observation mode
    if (hasConditions) {
      const result = await storeObservationWithConditions(c.env, c.env.AI, config, {
        id,
        content,
        source: source!,
        invalidates_if,
        confirms_if,
        requestId,
      });
      embedding = result.embedding;
    } else {
      const result = await storeObservationEmbeddings(c.env, c.env.AI, config, {
        id,
        content,
        source: source!,
        requestId,
      });
      embedding = result.embedding;
    }
  } else {
    // Thought mode
    const result = await storeThoughtEmbeddings(c.env, c.env.AI, config, {
      id,
      content,
      invalidates_if,
      confirms_if,
      assumes,
      resolves_by,
      requestId,
    });
    embedding = result.embedding;
  }

  // Queue exposure check
  const exposureJob: ExposureCheckJob = {
    memory_id: id,
    is_observation: hasSource,
    content,
    embedding,
    session_id: sessionId,
    request_id: requestId,
    timestamp: now,
    invalidates_if: hasConditions ? invalidates_if : undefined,
    confirms_if: hasConditions ? confirms_if : undefined,
    time_bound: timeBound,
  };

  await c.env.DETECTION_QUEUE.send(exposureJob);

  return c.json({
    success: true,
    id,
    time_bound: timeBound || undefined,
    exposure_check: 'queued',
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
  const memoryTypes = types || ['obs', 'thought'];

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(c.env.AI, query, config, requestId);

  // Search Vectorize
  const searchResults = await searchSimilar(c.env, queryEmbedding, limit * 2, minSimilarity, requestId);

  // Fetch memory details and filter
  const results: ScoredMemory[] = [];

  for (const match of searchResults) {
    if (results.length >= limit) break;

    const row = await c.env.DB.prepare(`SELECT * FROM memories WHERE id = ? AND retracted = 0`)
      .bind(match.id)
      .first<MemoryRow>();

    if (!row) continue;

    // Filter by type using field presence
    const filterType = getFilterType(row);
    if (!memoryTypes.includes(filterType)) continue;

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
      entityType: getDisplayType(result.memory),
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
      type: getDisplayType(r.memory),
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
  // Count memories by type using field presence
  const obsCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NOT NULL`
  ).first<{ count: number }>();

  const thoughtCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NULL AND derived_from IS NOT NULL AND resolves_by IS NULL`
  ).first<{ count: number }>();

  const predictionCount = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND source IS NULL AND resolves_by IS NOT NULL`
  ).first<{ count: number }>();

  // Count edges
  const edgeCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM edges').first<{ count: number }>();

  const obs = obsCount?.count || 0;
  const thoughts = thoughtCount?.count || 0;
  const predictions = predictionCount?.count || 0;

  return c.json({
    memories: {
      observation: obs,
      thought: thoughts,
      prediction: predictions,
      total: obs + thoughts + predictions,
    },
    edges: edgeCount?.count || 0,
  });
});

export default internalRouter;
