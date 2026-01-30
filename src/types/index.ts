/**
 * Memory Worker Types - Cognitive Loop Architecture (v3)
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

export interface Env {
  // Core bindings
  DB: D1Database;
  AI: Ai;
  ANALYTICS?: AnalyticsEngineDataset;

  // OAuth for MCP authentication
  OAUTH_KV: KVNamespace;
  ISSUER_URL?: string;
  CF_ACCESS_TEAM?: string;
  CF_ACCESS_AUD?: string;

  // Vectorize Indexes (Three-table architecture)
  // Memory content embeddings - for finding observations when checking new claims
  MEMORY_VECTORS: VectorizeIndex;
  // Invalidates_if condition embeddings - for finding predictions an observation might break
  INVALIDATES_VECTORS: VectorizeIndex;
  // Confirms_if condition embeddings - for finding predictions an observation might support
  CONFIRMS_VECTORS: VectorizeIndex;
  // Legacy binding (kept for backwards compatibility during migration)
  VECTORS: VectorizeIndex;

  // Queue for async exposure checking
  DETECTION_QUEUE: Queue<ExposureCheckJob>;

  // Workflows for observable event processing
  EXPOSURE_CHECK: Workflow;
  SESSION_DISPATCH: Workflow;
  INACTIVITY_CRON: Workflow;

  // API Key for authentication
  API_KEY?: string;

  // Resolver configuration (for agentic dispatch)
  // RESOLVER_TYPE: 'webhook' | 'none' (default)
  RESOLVER_TYPE?: string;
  RESOLVER_WEBHOOK_URL?: string;
  RESOLVER_WEBHOOK_TOKEN?: string;

  // OpenRouter API (for experiments with external models)
  OPENROUTER_API_KEY?: string;

  // AI Gateway for observability (optional - enables logging, metrics, cost tracking)
  CF_ACCOUNT_ID?: string;
  AI_GATEWAY_ID?: string;

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
}

// ============================================
// Legacy Type Aliases (for migration)
// ============================================

// These map old entity types to the new unified memory type
export type EntityType = 'obs' | 'assumption';

// Legacy entity types for migration compatibility
export type LegacyEntityType = 'obs' | 'infer' | 'pred';

// Legacy aliases for backwards compatibility during migration
export type ObservationSource = 'market' | 'news' | 'earnings' | 'email' | 'human' | 'tool';
