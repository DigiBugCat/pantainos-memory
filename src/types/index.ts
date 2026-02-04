/**
 * Memory Worker Types - Unified Memory Model
 *
 * Re-exports shared types and defines worker-specific bindings.
 */

// Re-export all shared types
export * from '../lib/shared/types/index.js';

// Re-export history and audit types
export * from './history.js';

// ============================================
// Cloudflare Worker Environment Bindings
// ============================================

import type { ExposureCheckJob } from '../lib/shared/types/index.js';
import type { MCPCoreEnv } from '@pantainos/mcp-core';

export interface Env extends MCPCoreEnv {
  // Core bindings
  DB: D1Database;
  AI: Ai;
  ANALYTICS?: AnalyticsEngineDataset;

  // Vectorize Indexes (Three-table architecture, 768 dimensions, embeddinggemma-300m)
  // Memory content embeddings - for finding observations when checking new claims
  MEMORY_VECTORS: VectorizeIndex;
  // Invalidates_if condition embeddings - for finding predictions an observation might break
  INVALIDATES_VECTORS: VectorizeIndex;
  // Confirms_if condition embeddings - for finding predictions an observation might support
  CONFIRMS_VECTORS: VectorizeIndex;

  // Queue for async exposure checking
  DETECTION_QUEUE: Queue<ExposureCheckJob>;

  // API Key for authentication
  API_KEY?: string;

  // Resolver configuration (for agentic dispatch)
  // RESOLVER_TYPE: 'webhook' | 'github' | 'none' (default)
  RESOLVER_TYPE?: string;
  RESOLVER_WEBHOOK_URL?: string;
  RESOLVER_WEBHOOK_TOKEN?: string;
  RESOLVER_GITHUB_TOKEN?: string;   // PAT with issues:write on target repo
  RESOLVER_GITHUB_REPO?: string;    // e.g. "DigiBugCat/Cassandra-Finance"

  // AI Gateway for observability (optional - enables logging, metrics, cost tracking)
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;

  // External LLM endpoint (optional - if set, routes LLM judge calls here instead of Workers AI)
  // Should be OpenAI-compatible endpoint (e.g., n8n workflow, OpenRouter, etc.)
  LLM_JUDGE_URL?: string;
  LLM_JUDGE_API_KEY?: string;

  // Service binding to claude-proxy worker (preferred over LLM_JUDGE_URL for worker-to-worker calls)
  // Bypasses CF Access — no auth headers needed
  CLAUDE_PROXY?: Fetcher;

  // Configurable via wrangler.toml [vars]
  EMBEDDING_MODEL?: string;
  REASONING_MODEL?: string;
  DEDUP_THRESHOLD?: string;
  DEDUP_LOWER_THRESHOLD?: string;
  DEDUP_MODEL?: string;
  DEDUP_CONFIDENCE_THRESHOLD?: string;
  SCORING_RECENCY_WEIGHT?: string;
  SCORING_FREQUENCY_WEIGHT?: string;
  SCORING_IMPORTANCE_WEIGHT?: string;
  SCORING_CONNECTIVITY_WEIGHT?: string;
  SCORING_CONNECTIVITY_NORMALIZER?: string;
  TIME_DECAY_HALF_LIFE_DAYS?: string;
  FREQUENCY_MEDIAN?: string;
  FREQUENCY_K?: string;
  SEARCH_DEFAULT_LIMIT?: string;
  SEARCH_MIN_SIMILARITY?: string;
  SEARCH_CANDIDATE_MULTIPLIER?: string;
  BULK_MAX_CREATE?: string;
  BULK_MAX_DELETE?: string;
  BULK_MAX_CONNECT?: string;
  BULK_MAX_COMBINE?: string;
  COMBINE_DEDUP_THRESHOLD?: string;
  ACCESS_LOG_RETENTION_DAYS?: string;
  CLEANUP_WEAK_EDGE_THRESHOLD?: string;
  CLEANUP_WEAK_EDGE_AGE_DAYS?: string;
  CLEANUP_DEDUP_BATCH?: string;
  CLEANUP_DEDUP_MAX_LLM?: string;
  CLEANUP_DEDUP_MIN?: string;
  CLEANUP_DEDUP_MAX?: string;

  // Exposure checker thresholds
  VIOLATION_CONFIDENCE_THRESHOLD?: string;
  CONFIRM_CONFIDENCE_THRESHOLD?: string;
  MAX_CANDIDATES?: string;
  MIN_SIMILARITY?: string;
}

// ============================================
// Type Aliases
// ============================================

// Source for observations
export type ObservationSource = 'market' | 'news' | 'earnings' | 'email' | 'human' | 'tool';
