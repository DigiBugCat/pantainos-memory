/**
 * MCP (Model Context Protocol) routes for pantainos-memory.
 *
 * Exposes the memory system's functionality as MCP tools, enabling
 * Claude Code and other MCP clients to interact with the knowledge graph.
 *
 * Endpoint: POST /mcp
 *
 * Authentication: Cloudflare Access headers expected.
 * The CF-Access-Authenticated-User-Email header provides user identity.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv, MemoryRow, ScoredMemory, RecordAccessParams, HistoryEntityType } from '../types/index.js';
import type { Config } from '../lib/config.js';
import type { ExposureCheckJob } from '../lib/shared/types/index.js';
import {
  handleMcpMessage,
  parseJsonRpcRequest,
  createToolRegistry,
  defineTool,
  jsonResult,
  errorResult,
  type ToolContext,
} from '../lib/shared/mcp/index.js';
import type { LoggingEnv } from '../lib/shared/hono/index.js';

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
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

/** Valid observation sources */
const VALID_SOURCES = ['market', 'news', 'earnings', 'email', 'human', 'tool'] as const;

// ============================================
// Tool Definitions
// ============================================

const createMemoryTools = (config: Config, requestId: string) => createToolRegistry<Env>([
  // ----------------------------------------
  // Write Path - Create and modify memories
  // ----------------------------------------

  defineTool({
    name: 'observe',
    description: 'Record an observation from reality. Observations are anchored facts that form the foundation of the knowledge graph.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The observation content (what was observed)' },
        source: { type: 'string', description: 'Source of the observation (market, news, earnings, email, human, tool)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
      },
      required: ['content', 'source'],
    },
    handler: async (args, ctx) => {
      const { content, source, tags } = args as { content: string; source: string; tags?: string[] };

      if (!VALID_SOURCES.includes(source as typeof VALID_SOURCES[number])) {
        return errorResult(`source must be one of: ${VALID_SOURCES.join(', ')}`);
      }

      const now = Date.now();
      const id = generateId('obs');
      const sessionId = ctx.sessionId;

      // Store in D1
      await ctx.env.DB.prepare(
        `INSERT INTO memories (
          id, memory_type, content, source,
          confirmations, exposures, centrality, state, violations,
          retracted, tags, session_id, created_at
        ) VALUES (?, 'obs', ?, ?, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
      ).bind(
        id,
        content,
        source,
        tags ? JSON.stringify(tags) : null,
        sessionId || null,
        now
      ).run();

      // Record version for audit trail
      await recordVersion(ctx.env.DB, {
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
      const { embedding } = await storeObservationEmbeddings(ctx.env, ctx.env.AI, config, {
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

      await ctx.env.DETECTION_QUEUE.send(exposureJob);

      return jsonResult({
        success: true,
        id,
        exposure_check: 'queued',
      });
    },
  }),

  defineTool({
    name: 'find',
    description: 'Semantic search across all memories. Results are ranked by similarity × confidence × centrality.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter by memory types (obs, assumption)' },
        limit: { type: 'integer', description: 'Max results to return (default: 10)', minimum: 1, maximum: 100 },
        min_similarity: { type: 'number', description: 'Minimum similarity threshold (0-1)' },
      },
      required: ['query'],
    },
    handler: async (args, ctx) => {
      const { query, types, limit: requestedLimit, min_similarity } = args as {
        query: string;
        types?: string[];
        limit?: number;
        min_similarity?: number;
      };

      const limit = requestedLimit || config.search.defaultLimit;
      const minSimilarity = min_similarity || config.search.minSimilarity;
      const memoryTypes = types || ['obs', 'assumption'];

      // Generate embedding for query
      const queryEmbedding = await generateEmbedding(ctx.env.AI, query, config, requestId);

      // Search Vectorize
      const searchResults = await searchSimilar(
        ctx.env,
        queryEmbedding,
        limit * 2,
        minSimilarity,
        requestId
      );

      // Fetch memory details and filter
      const results: ScoredMemory[] = [];

      for (const match of searchResults) {
        if (results.length >= limit) break;

        const memoryType = inferMemoryType(match.id);
        if (!memoryTypes.includes(memoryType as string)) continue;

        const row = await ctx.env.DB.prepare(
          `SELECT * FROM memories WHERE id = ? AND retracted = 0`
        ).bind(match.id).first<MemoryRow>();

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
          sessionId: ctx.sessionId,
          requestId,
          queryText: query,
          resultRank: index + 1,
          similarityScore: result.similarity,
        }));
        await recordAccessBatch(ctx.env.DB, accessEvents);
      }

      return jsonResult({
        results: results.map(r => ({
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
    },
  }),

  defineTool({
    name: 'recall',
    description: 'Retrieve a specific memory by ID with its confidence stats and connections.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to recall' },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const { memory_id } = args as { memory_id: string };

      const row = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ?`
      ).bind(memory_id).first<MemoryRow>();

      if (!row) {
        return errorResult(`Memory not found: ${memory_id}`);
      }

      const memory = rowToMemory(row);

      // Get connected memories
      const edges = await ctx.env.DB.prepare(
        `SELECT target_id, strength FROM edges WHERE source_id = ?`
      ).bind(memory_id).all<{ target_id: string; strength: number }>();

      return jsonResult({
        memory,
        connections: edges.results || [],
      });
    },
  }),

  defineTool({
    name: 'stats',
    description: 'Get memory statistics (counts by type, robustness distribution, etc.).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    handler: async (_args, ctx) => {
      // Count memories by type
      const memoryCounts = await ctx.env.DB.prepare(
        `SELECT memory_type, COUNT(*) as count FROM memories WHERE retracted = 0 GROUP BY memory_type`
      ).all<{ memory_type: string; count: number }>();

      const counts = Object.fromEntries(
        (memoryCounts.results || []).map(r => [r.memory_type, r.count])
      );

      // Count edges
      const edgeCount = await ctx.env.DB.prepare(
        'SELECT COUNT(*) as count FROM edges'
      ).first<{ count: number }>();

      return jsonResult({
        memories: {
          obs: counts.obs || 0,
          assumption: counts.assumption || 0,
          total: Object.values(counts).reduce((a, b) => (a as number) + (b as number), 0),
        },
        edges: edgeCount?.count || 0,
      });
    },
  }),

  defineTool({
    name: 'pending',
    description: 'List predictions/assumptions awaiting resolution.',
    inputSchema: {
      type: 'object',
      properties: {
        overdue: { type: 'boolean', description: 'Only show overdue predictions' },
        limit: { type: 'integer', description: 'Max results (default: 20)' },
      },
    },
    handler: async (args, ctx) => {
      const { overdue, limit } = args as { overdue?: boolean; limit?: number };
      const now = Date.now();
      const resultLimit = limit || 20;

      let query = `
        SELECT * FROM memories
        WHERE memory_type = 'assumption'
        AND state = 'active'
        AND retracted = 0
        AND resolves_by IS NOT NULL
      `;

      if (overdue) {
        query += ` AND resolves_by < ${now}`;
      }

      query += ` ORDER BY created_at DESC LIMIT ${resultLimit}`;

      const results = await ctx.env.DB.prepare(query).all<MemoryRow>();

      return jsonResult({
        pending: (results.results || []).map(row => ({
          id: row.id,
          content: row.content,
          type: row.memory_type,
          resolves_by: row.resolves_by,
          created_at: row.created_at,
        })),
        total: results.results?.length || 0,
      });
    },
  }),

  defineTool({
    name: 'insights',
    description: 'Get insights about the knowledge graph structure.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['hubs', 'orphans', 'untested', 'failing', 'recent'],
          description: 'Type of insight view'
        },
        limit: { type: 'integer', description: 'Max results (default: 20)' },
      },
    },
    handler: async (args, ctx) => {
      const { view, limit } = args as { view?: string; limit?: number };
      const resultLimit = limit || 20;

      let query = '';
      switch (view) {
        case 'hubs':
          query = `
            SELECT m.*, COUNT(e.target_id) as connection_count
            FROM memories m
            LEFT JOIN edges e ON m.id = e.source_id
            WHERE m.retracted = 0
            GROUP BY m.id
            ORDER BY connection_count DESC
            LIMIT ${resultLimit}
          `;
          break;
        case 'orphans':
          query = `
            SELECT m.*
            FROM memories m
            LEFT JOIN edges e ON m.id = e.source_id OR m.id = e.target_id
            WHERE m.retracted = 0 AND e.source_id IS NULL
            ORDER BY m.created_at DESC
            LIMIT ${resultLimit}
          `;
          break;
        case 'untested':
          query = `
            SELECT * FROM memories
            WHERE retracted = 0 AND exposures < 3
            ORDER BY created_at DESC
            LIMIT ${resultLimit}
          `;
          break;
        case 'failing':
          query = `
            SELECT * FROM memories
            WHERE retracted = 0 AND json_array_length(violations) > 0
            ORDER BY created_at DESC
            LIMIT ${resultLimit}
          `;
          break;
        case 'recent':
        default:
          query = `
            SELECT * FROM memories
            WHERE retracted = 0
            ORDER BY created_at DESC
            LIMIT ${resultLimit}
          `;
      }

      const results = await ctx.env.DB.prepare(query).all<MemoryRow>();

      return jsonResult({
        view: view || 'recent',
        memories: (results.results || []).map(row => ({
          id: row.id,
          content: row.content,
          type: row.memory_type,
          exposures: row.exposures,
          confirmations: row.confirmations,
          created_at: row.created_at,
        })),
        total: results.results?.length || 0,
      });
    },
  }),
]);

/**
 * Infer memory type from ID prefix.
 */
function inferMemoryType(id: string): string {
  if (id.startsWith('obs-')) return 'obs';
  if (id.startsWith('infer-')) return 'assumption';
  if (id.startsWith('pred-')) return 'assumption';
  if (id.startsWith('assum-')) return 'assumption';
  return 'obs';
}

// ============================================
// MCP Router
// ============================================

const mcpRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// MCP endpoint - handles JSON-RPC requests
mcpRouter.post('/', async (c) => {
  const body = await c.req.text();
  const parsed = parseJsonRpcRequest(body);

  if ('error' in parsed) {
    return c.json(parsed.error);
  }

  const config = c.get('config');
  const requestId = c.get('requestId') || `mcp-${Date.now()}`;

  // Create tool registry with current config
  const toolRegistry = createMemoryTools(config, requestId);

  const context: ToolContext<Env> = {
    userEmail: c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous',
    env: c.env,
    sessionId: c.get('sessionId'),
  };

  const response = await handleMcpMessage(
    parsed.request,
    {
      name: 'pantainos-memory',
      version: '2.0.0',
      toolRegistry,
    },
    context
  );

  if (response === null) {
    // Notification - no response needed
    return c.body(null, 204);
  }

  return c.json(response);
});

// Well-known discovery endpoint
mcpRouter.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
});

/**
 * Handle an MCP message directly (for use by POST / endpoint).
 * This allows the root endpoint to also serve MCP requests.
 */
export async function handleMCPMessage(
  message: unknown,
  userEmail: string,
  env: Env
): Promise<unknown> {
  // Use a simple config - this is for the POST / endpoint
  const config = {
    search: { defaultLimit: 10, minSimilarity: 0.3 },
    aiGatewayId: (env as unknown as Record<string, string>).AI_GATEWAY_ID || undefined,
  } as Config;
  const requestId = `mcp-root-${Date.now()}`;

  const toolRegistry = createMemoryTools(config, requestId);

  const context: ToolContext<Env> = {
    userEmail,
    env,
    sessionId: undefined,
  };

  return handleMcpMessage(
    message as Parameters<typeof handleMcpMessage>[0],
    {
      name: 'pantainos-memory',
      version: '2.0.0',
      toolRegistry,
    },
    context
  );
}

export default mcpRouter;
