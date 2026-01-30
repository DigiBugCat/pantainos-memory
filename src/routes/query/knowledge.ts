/**
 * Knowledge Route - GET /api/knowledge
 *
 * Assess knowledge depth on a topic using semantic search
 * and connectivity analysis.
 *
 * Query params:
 *   - topic: the topic to assess (required)
 *   - limit: max key memories to return (default: 10)
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

export interface KnowledgeAssessment {
  topic: string;
  memoryCount: number;
  connectionDensity: number; // average connections per memory
  isolatedCount: number; // memories with no connections
  keyMemories: Array<{
    id: string;
    type: EntityType;
    content: string;
    similarity: number;
    connectionCount: number;
  }>;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');

  const topic = c.req.query('topic');
  const limit = parseInt(c.req.query('limit') || '10', 10);

  if (!topic) {
    return c.json({ success: false, error: 'topic query parameter is required' }, 400);
  }

  // Generate embedding for topic
  const topicEmbedding = await generateEmbedding(c.env.AI, topic, config, requestId);

  // Search for related memories
  const searchResults = await searchSimilar(
    c.env,
    topicEmbedding,
    limit * 2, // Get more to analyze
    0.4, // Lower threshold to capture more related content
    requestId
  );

  if (searchResults.length === 0) {
    const response: KnowledgeAssessment = {
      topic,
      memoryCount: 0,
      connectionDensity: 0,
      isolatedCount: 0,
      keyMemories: [],
    };
    return c.json(response);
  }

  // Analyze connectivity for each result
  const keyMemories: KnowledgeAssessment['keyMemories'] = [];
  let totalConnections = 0;
  let isolatedCount = 0;

  for (const match of searchResults) {
    if (keyMemories.length >= limit) break;

    // Get entity details from memories table
    const entity = await getEntityDetails(c.env.DB, match.id);

    if (!entity) continue;

    // Count connections (as source or target in edges)
    const connectionCount = await countConnections(c.env.DB, match.id);
    totalConnections += connectionCount;

    if (connectionCount === 0) {
      isolatedCount++;
    }

    keyMemories.push({
      id: match.id,
      type: entity.type,
      content: entity.content,
      similarity: match.similarity,
      connectionCount,
    });
  }

  // Sort by connection count (most connected first)
  keyMemories.sort((a, b) => b.connectionCount - a.connectionCount);

  const connectionDensity = keyMemories.length > 0
    ? totalConnections / keyMemories.length
    : 0;

  const response: KnowledgeAssessment = {
    topic,
    memoryCount: keyMemories.length,
    connectionDensity: Math.round(connectionDensity * 100) / 100,
    isolatedCount,
    keyMemories,
  };

  return c.json(response);
});

/**
 * Count connections for an entity (as source or target).
 * v3: uses edges table
 */
async function countConnections(db: D1Database, entityId: string): Promise<number> {
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM (
      SELECT source_id as id FROM edges WHERE source_id = ?
      UNION ALL
      SELECT target_id as id FROM edges WHERE target_id = ?
    )
  `).bind(entityId, entityId).first<{ count: number }>();

  return result?.count || 0;
}

/**
 * Get entity details from memories table.
 * v3: single unified table for all memory types
 */
async function getEntityDetails(
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
