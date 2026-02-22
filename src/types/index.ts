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
import type { ObserveCommitJob } from '../usecases/observe-memory.js';

export interface Env {
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

  // Queue for async exposure checking + commit retries
  DETECTION_QUEUE: Queue<ExposureCheckJob | ObserveCommitJob>;

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

  // External LLM endpoint (OpenAI-compatible chat completions)
  // e.g., https://api.openai.com/v1/chat/completions
  LLM_JUDGE_URL?: string;
  LLM_JUDGE_API_KEY?: string;
  LLM_JUDGE_MODEL?: string; // default: gpt-5-mini

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
  EXPOSURE_LLM_MAX_CONCURRENCY?: string;

  // Pushover push notifications (optional - for core violation alerts)
  PUSHOVER_USER_KEY?: string;
  PUSHOVER_APP_TOKEN?: string;
}
