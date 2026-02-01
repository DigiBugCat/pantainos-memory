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
import type { Env as BaseEnv, MemoryRow, ScoredMemory, RecordAccessParams, EdgeRow } from '../types/index.js';
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
import { storeObservationEmbeddings, storeAssumptionEmbeddings } from '../services/embedding-tables.js';
import { recordVersion } from '../services/history-service.js';
import { recordAccessBatch } from '../services/access-service.js';
import { rowToMemory } from '../lib/transforms.js';
import { createScoredMemory } from '../lib/scoring.js';
import { incrementCentrality } from '../services/exposure-checker.js';

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
    description: 'Record a fact from reality. Observations are ground truth - immutable anchors that can only be retracted, never edited. When stored, the system automatically checks if this observation contradicts any existing assumptions (triggering violations) or confirms them. Sources: market, news, earnings, email, human, tool.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The observation content (what was observed)' },
        source: { type: 'string', enum: ['market', 'news', 'earnings', 'email', 'human', 'tool'], description: 'Source of the observation' },
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
    name: 'assume',
    description: 'Form a belief derived from observations or other assumptions. Must specify derived_from (source memory IDs) and invalidates_if (conditions that would prove this wrong). Optionally add confirms_if (conditions that would strengthen this). For time-bound predictions, include resolves_by (Unix timestamp) and outcome_condition. The system automatically checks new observations against these conditions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The assumption content (the derived belief)' },
        derived_from: { type: 'array', items: { type: 'string' }, description: 'IDs of source memories this assumption is based on (required)' },
        invalidates_if: { type: 'array', items: { type: 'string' }, description: 'Conditions that would prove this wrong (tested against new observations)' },
        confirms_if: { type: 'array', items: { type: 'string' }, description: 'Conditions that would strengthen this (optional)' },
        assumes: { type: 'array', items: { type: 'string' }, description: 'Underlying assumptions this belief rests on (optional)' },
        resolves_by: { type: 'integer', description: 'Unix timestamp deadline for time-bound predictions (optional)' },
        outcome_condition: { type: 'string', description: 'What determines success/failure for time-bound predictions (required if resolves_by set)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
      },
      required: ['content', 'derived_from'],
    },
    handler: async (args, ctx) => {
      const {
        content,
        derived_from,
        invalidates_if,
        confirms_if,
        assumes,
        resolves_by,
        outcome_condition,
        tags,
      } = args as {
        content: string;
        derived_from: string[];
        invalidates_if?: string[];
        confirms_if?: string[];
        assumes?: string[];
        resolves_by?: number;
        outcome_condition?: string;
        tags?: string[];
      };

      // Validate derived_from
      if (!derived_from || derived_from.length === 0) {
        return errorResult('derived_from is required and must be a non-empty array');
      }

      // Time-bound validation
      const timeBound = resolves_by !== undefined;
      if (timeBound && !outcome_condition) {
        return errorResult('outcome_condition is required for time-bound assumptions (when resolves_by is set)');
      }

      // Verify all source IDs exist
      const placeholders = derived_from.map(() => '?').join(',');
      const sources = await ctx.env.DB.prepare(
        `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
      ).bind(...derived_from).all<{ id: string }>();

      if (!sources.results || sources.results.length !== derived_from.length) {
        const foundIds = new Set(sources.results?.map((r) => r.id) || []);
        const missing = derived_from.filter((id) => !foundIds.has(id));
        return errorResult(`Source memories not found: ${missing.join(', ')}`);
      }

      const now = Date.now();
      const id = generateId(timeBound ? 'pred' : 'infer');
      const sessionId = ctx.sessionId;

      // Store in D1
      await ctx.env.DB.prepare(
        `INSERT INTO memories (
          id, memory_type, content,
          assumes, invalidates_if, confirms_if,
          outcome_condition, resolves_by,
          confirmations, exposures, centrality, state, violations,
          retracted, tags, session_id, created_at
        ) VALUES (?, 'assumption', ?, ?, ?, ?, ?, ?, 0, 0, 0, 'active', '[]', 0, ?, ?, ?)`
      ).bind(
        id,
        content,
        assumes ? JSON.stringify(assumes) : null,
        invalidates_if ? JSON.stringify(invalidates_if) : null,
        confirms_if ? JSON.stringify(confirms_if) : null,
        outcome_condition || null,
        resolves_by || null,
        tags ? JSON.stringify(tags) : null,
        sessionId || null,
        now
      ).run();

      // Create derivation edges and increment centrality
      for (const sourceId of derived_from) {
        const edgeId = generateId('edge');
        await ctx.env.DB.prepare(
          `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
           VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
        ).bind(edgeId, sourceId, id, now).run();

        await incrementCentrality(ctx.env.DB, sourceId);
      }

      // Record version for audit trail
      await recordVersion(ctx.env.DB, {
        entityId: id,
        entityType: 'assumption',
        changeType: 'created',
        contentSnapshot: {
          id,
          memory_type: 'assumption',
          content,
          assumes,
          invalidates_if,
          confirms_if,
          outcome_condition,
          resolves_by,
          tags,
          derived_from,
          confirmations: 0,
          exposures: 0,
          centrality: 0,
          state: 'active',
          violations: [],
          retracted: false,
          time_bound: timeBound,
        },
        sessionId,
        requestId,
      });

      // Store embeddings
      const { embedding } = await storeAssumptionEmbeddings(ctx.env, ctx.env.AI, config, {
        id,
        content,
        invalidates_if,
        confirms_if,
        assumes,
        resolves_by,
        requestId,
      });

      // Queue exposure check if conditions defined
      const hasConditions = (invalidates_if && invalidates_if.length > 0) ||
        (timeBound && confirms_if && confirms_if.length > 0);

      if (hasConditions) {
        const exposureJob: ExposureCheckJob = {
          memory_id: id,
          memory_type: 'assumption',
          content,
          embedding,
          session_id: sessionId,
          request_id: requestId,
          timestamp: now,
          invalidates_if,
          confirms_if,
          time_bound: timeBound,
        };

        await ctx.env.DETECTION_QUEUE.send(exposureJob);
      }

      return jsonResult({
        success: true,
        id,
        time_bound: timeBound,
        exposure_check: hasConditions ? 'queued' : 'skipped',
      });
    },
  }),

  defineTool({
    name: 'find',
    description: 'Search memories by meaning. Results ranked by: similarity (semantic match), confidence (survival rate under testing), and centrality (how many assumptions derive from this). Use to find related observations before forming assumptions, or to check if an assumption already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        types: { type: 'array', items: { type: 'string', enum: ['obs', 'assumption'] }, description: 'Filter by memory types (obs, assumption)' },
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
    description: 'Get a memory by ID. Returns the memory content, confidence stats (exposures, confirmations), state (active/violated/confirmed), and derivation edges. Use to inspect a specific memory before building on it.',
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
    description: 'List time-bound assumptions past their resolves_by deadline awaiting resolution. These need human review elsewhere to mark as confirmed or violated.',
    inputSchema: {
      type: 'object',
      properties: {
        overdue: { type: 'boolean', description: 'Only show overdue predictions (default: false shows all pending)' },
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
    description: 'Analyze knowledge graph health. Views: hubs (most-connected memories), orphans (unconnected - no derivation links), untested (low exposure count - dangerous if confident), failing (have violations from contradicting observations), recent (latest memories).',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['hubs', 'orphans', 'untested', 'failing', 'recent'],
          description: 'Type of insight view (default: recent)'
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

  // ----------------------------------------
  // Graph Traversal - Navigate derivation chain
  // ----------------------------------------

  defineTool({
    name: 'reference',
    description: 'Follow the derivation graph from a memory. Returns memories connected by derivation edges - what this memory derives from (ancestors via direction=up) or what derives from it (descendants via direction=down). Use to trace reasoning chains and understand dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to traverse from' },
        direction: { type: 'string', enum: ['up', 'down', 'both'], description: 'Traverse direction: up (ancestors), down (descendants), both (default: both)' },
        depth: { type: 'integer', description: 'Max traversal depth (default: 2)', minimum: 1, maximum: 10 },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const { memory_id, direction = 'both', depth: maxDepth = 2 } = args as {
        memory_id: string;
        direction?: 'up' | 'down' | 'both';
        depth?: number;
      };

      interface GraphNode {
        id: string;
        type: string;
        content: string;
        depth: number;
      }

      interface GraphEdge {
        source: string;
        target: string;
        type: string;
        strength: number;
      }

      const nodes: Map<string, GraphNode> = new Map();
      const edges: GraphEdge[] = [];
      const visited = new Set<string>();

      // Get root memory
      const rootRow = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ?`
      ).bind(memory_id).first<MemoryRow>();

      if (!rootRow) {
        return errorResult(`Memory not found: ${memory_id}`);
      }

      const rootMemory = rowToMemory(rootRow);
      nodes.set(memory_id, {
        id: memory_id,
        type: rootMemory.memory_type,
        content: rootMemory.content,
        depth: 0,
      });

      // Traverse function
      async function traverse(
        memoryId: string,
        currentDepth: number,
        dir: string
      ): Promise<void> {
        if (currentDepth >= maxDepth || visited.has(`${memoryId}-${dir}`)) return;
        visited.add(`${memoryId}-${dir}`);

        // Traverse up (what this memory is derived from)
        if (dir === 'up' || dir === 'both') {
          const derivedFrom = await ctx.env.DB.prepare(
            `SELECT * FROM edges WHERE target_id = ?`
          ).bind(memoryId).all<EdgeRow>();

          for (const row of derivedFrom.results || []) {
            if (!nodes.has(row.source_id)) {
              const sourceRow = await ctx.env.DB.prepare(
                `SELECT * FROM memories WHERE id = ? AND retracted = 0`
              ).bind(row.source_id).first<MemoryRow>();

              if (sourceRow) {
                const sourceMemory = rowToMemory(sourceRow);
                nodes.set(row.source_id, {
                  id: row.source_id,
                  type: sourceMemory.memory_type,
                  content: sourceMemory.content,
                  depth: currentDepth + 1,
                });
              }
            }

            edges.push({
              source: row.source_id,
              target: memoryId,
              type: row.edge_type,
              strength: row.strength,
            });

            await traverse(row.source_id, currentDepth + 1, 'up');
          }
        }

        // Traverse down (what derives from this memory)
        if (dir === 'down' || dir === 'both') {
          const derivesTo = await ctx.env.DB.prepare(
            `SELECT * FROM edges WHERE source_id = ?`
          ).bind(memoryId).all<EdgeRow>();

          for (const row of derivesTo.results || []) {
            if (!nodes.has(row.target_id)) {
              const targetRow = await ctx.env.DB.prepare(
                `SELECT * FROM memories WHERE id = ? AND retracted = 0`
              ).bind(row.target_id).first<MemoryRow>();

              if (targetRow) {
                const targetMemory = rowToMemory(targetRow);
                nodes.set(row.target_id, {
                  id: row.target_id,
                  type: targetMemory.memory_type,
                  content: targetMemory.content,
                  depth: currentDepth + 1,
                });
              }
            }

            edges.push({
              source: memoryId,
              target: row.target_id,
              type: row.edge_type,
              strength: row.strength,
            });

            await traverse(row.target_id, currentDepth + 1, 'down');
          }
        }
      }

      await traverse(memory_id, 0, direction);

      return jsonResult({
        root: memory_id,
        nodes: Array.from(nodes.values()),
        edges,
      });
    },
  }),

  defineTool({
    name: 'roots',
    description: 'Trace an assumption back to its root observations. Walks the derivation chain to find the original facts this belief is based on. Use to audit reasoning - every assumption should trace back to reality.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_id: { type: 'string', description: 'ID of the memory to trace roots for' },
      },
      required: ['memory_id'],
    },
    handler: async (args, ctx) => {
      const { memory_id } = args as { memory_id: string };

      // Get the memory
      const row = await ctx.env.DB.prepare(
        `SELECT * FROM memories WHERE id = ?`
      ).bind(memory_id).first<MemoryRow>();

      if (!row) {
        return errorResult(`Memory not found: ${memory_id}`);
      }

      const memory = rowToMemory(row);

      // If already an observation, return itself
      if (memory.memory_type === 'obs') {
        return jsonResult({
          memory: {
            id: memory_id,
            type: 'obs',
            content: memory.content,
          },
          roots: [{
            id: memory_id,
            content: memory.content,
            type: 'obs',
          }],
          pathDepth: 0,
        });
      }

      // Trace to roots
      const visited = new Set<string>();
      const roots: Array<{ id: string; content: string; type: string }> = [];
      let maxDepth = 0;

      async function traceToRoots(memId: string, depth: number): Promise<void> {
        if (visited.has(memId)) return;
        visited.add(memId);

        const derivedFrom = await ctx.env.DB.prepare(
          `SELECT source_id FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
        ).bind(memId).all<{ source_id: string }>();

        if (!derivedFrom.results || derivedFrom.results.length === 0) {
          // Check if this is an observation (root)
          const obsRow = await ctx.env.DB.prepare(
            `SELECT * FROM memories WHERE id = ? AND memory_type = 'obs' AND retracted = 0`
          ).bind(memId).first<MemoryRow>();

          if (obsRow && !roots.some(r => r.id === memId)) {
            roots.push({
              id: memId,
              content: obsRow.content,
              type: 'obs',
            });
            if (depth > maxDepth) maxDepth = depth;
          }
          return;
        }

        for (const parent of derivedFrom.results) {
          const parentRow = await ctx.env.DB.prepare(
            `SELECT * FROM memories WHERE id = ? AND retracted = 0`
          ).bind(parent.source_id).first<MemoryRow>();

          if (!parentRow) continue;

          if (parentRow.memory_type === 'obs') {
            if (!roots.some(r => r.id === parent.source_id)) {
              roots.push({
                id: parent.source_id,
                content: parentRow.content,
                type: 'obs',
              });
              if (depth + 1 > maxDepth) maxDepth = depth + 1;
            }
          } else {
            await traceToRoots(parent.source_id, depth + 1);
          }
        }
      }

      await traceToRoots(memory_id, 0);

      return jsonResult({
        memory: {
          id: memory_id,
          type: memory.memory_type,
          content: memory.content,
        },
        roots,
        pathDepth: maxDepth,
      });
    },
  }),

  defineTool({
    name: 'between',
    description: 'Find memories that bridge two given memories. Discovers conceptual connections you might not have noticed. Use when you have two related ideas and want to understand what links them.',
    inputSchema: {
      type: 'object',
      properties: {
        memory_ids: { type: 'array', items: { type: 'string' }, description: 'IDs of memories to find bridges between (minimum 2)' },
        limit: { type: 'integer', description: 'Max bridges to return (default: 5)', minimum: 1, maximum: 20 },
      },
      required: ['memory_ids'],
    },
    handler: async (args, ctx) => {
      const { memory_ids, limit = 5 } = args as { memory_ids: string[]; limit?: number };

      if (!memory_ids || memory_ids.length < 2) {
        return errorResult('At least 2 memory IDs are required');
      }

      // Fetch content for all input memories
      const contents: Array<{ id: string; content: string }> = [];

      for (const id of memory_ids) {
        const row = await ctx.env.DB.prepare(
          `SELECT content FROM memories WHERE id = ? AND retracted = 0`
        ).bind(id).first<{ content: string }>();

        if (!row) {
          return errorResult(`Memory not found: ${id}`);
        }

        contents.push({ id, content: row.content });
      }

      // Generate embeddings and compute centroid
      const embeddings: number[][] = [];
      for (const item of contents) {
        const embedding = await generateEmbedding(ctx.env.AI, item.content, config, requestId);
        embeddings.push(embedding);
      }

      // Compute centroid
      const dimensions = embeddings[0].length;
      const centroid = new Array(dimensions).fill(0);
      for (const emb of embeddings) {
        for (let i = 0; i < dimensions; i++) {
          centroid[i] += emb[i];
        }
      }
      for (let i = 0; i < dimensions; i++) {
        centroid[i] /= embeddings.length;
      }

      // Search for memories near centroid
      const searchResults = await searchSimilar(
        ctx.env,
        centroid,
        limit * 3 + memory_ids.length,
        0.3,
        requestId
      );

      // Filter out input memories and fetch details
      const inputIdSet = new Set(memory_ids);
      const bridges: Array<{
        id: string;
        type: string;
        content: string;
        relevanceScore: number;
      }> = [];

      for (const match of searchResults) {
        if (bridges.length >= limit) break;
        if (inputIdSet.has(match.id)) continue;

        const row = await ctx.env.DB.prepare(
          `SELECT content, memory_type FROM memories WHERE id = ? AND retracted = 0`
        ).bind(match.id).first<{ content: string; memory_type: string }>();

        if (!row) continue;

        bridges.push({
          id: match.id,
          type: row.memory_type,
          content: row.content,
          relevanceScore: match.similarity,
        });
      }

      return jsonResult({
        bridges,
        inputIds: memory_ids,
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
