/**
 * Between Route - GET /api/between
 *
 * Find memories that conceptually bridge two or more given memories.
 * Uses embedding centroid to find semantically related concepts.
 *
 * Query params:
 *   - ids: comma-separated list of memory IDs (required, minimum 2)
 *   - limit: max bridges to return (default 5)
 */

import { Hono } from 'hono';
import type { Env, EntityType } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateEmbedding, searchSimilar } from '../../lib/embeddings.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export interface BetweenResponse {
  bridges: Array<{
    id: string;
    type: EntityType;
    content: string;
    relevanceScore: number;
  }>;
  inputIds: string[];
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');

  // Parse query params
  const idsParam = c.req.query('ids');
  const limit = parseInt(c.req.query('limit') || '5', 10);

  if (!idsParam) {
    return c.json({ success: false, error: 'ids query parameter is required' }, 400);
  }

  const inputIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);

  if (inputIds.length < 2) {
    return c.json({ success: false, error: 'At least 2 memory IDs are required' }, 400);
  }

  // Fetch content for all input memories from unified memories table
  const contents: Array<{ id: string; content: string }> = [];

  for (const id of inputIds) {
    const memory = await getMemoryContent(c.env.DB, id);

    if (!memory) {
      return c.json({ success: false, error: `Memory ${id} not found` }, 404);
    }

    contents.push({ id, content: memory.content });
  }

  // Generate embeddings for all input memories
  const embeddings: number[][] = [];

  for (const item of contents) {
    const embedding = await generateEmbedding(c.env.AI, item.content, config, requestId);
    embeddings.push(embedding);
  }

  // Compute centroid of all embeddings
  const centroid = computeCentroid(embeddings);

  // Search for memories near centroid
  const searchResults = await searchSimilar(
    c.env,
    centroid,
    limit * 3 + inputIds.length, // Get extras to filter out inputs
    0.3, // Lower threshold since we're looking for bridges
    requestId
  );

  // Filter out input memories and fetch details
  const inputIdSet = new Set(inputIds);
  const bridges: BetweenResponse['bridges'] = [];

  for (const match of searchResults) {
    if (bridges.length >= limit) break;
    if (inputIdSet.has(match.id)) continue;

    const memory = await getMemoryContent(c.env.DB, match.id);

    if (!memory) continue;

    bridges.push({
      id: match.id,
      type: memory.type,
      content: memory.content,
      relevanceScore: match.similarity,
    });
  }

  const response: BetweenResponse = {
    bridges,
    inputIds,
  };

  return c.json(response);
});

/**
 * Compute centroid of multiple embeddings.
 */
function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return embeddings[0];

  const dimensions = embeddings[0].length;
  const centroid = new Array(dimensions).fill(0);

  for (const embedding of embeddings) {
    for (let i = 0; i < dimensions; i++) {
      centroid[i] += embedding[i];
    }
  }

  // Average
  for (let i = 0; i < dimensions; i++) {
    centroid[i] /= embeddings.length;
  }

  return centroid;
}

/**
 * Get memory content from unified memories table.
 * v3: single table for all memory types
 */
async function getMemoryContent(
  db: D1Database,
  id: string
): Promise<{ content: string; type: EntityType } | null> {
  const result = await db.prepare(`
    SELECT content, memory_type
    FROM memories
    WHERE id = ? AND retracted = 0
  `).bind(id).first<{ content: string; memory_type: string }>();

  if (!result) return null;

  return {
    content: result.content,
    type: result.memory_type as EntityType,
  };
}

export default app;
