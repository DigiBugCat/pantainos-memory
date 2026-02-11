/**
 * Memory system types - Unified Memory Model
 *
 * Everything is a memory. Fields determine semantics:
 *   - source IS NOT NULL → observation (takes precedence for type labeling)
 *   - source IS NULL and derived_from IS NOT NULL → thought (derived belief)
 *   - source IS NULL and resolves_by IS NOT NULL → time-bound thought (prediction)
 *
 * Core principle: Memories are weighted bets, not facts.
 * Confidence = survival rate under test (confirmations / times_tested)
 */

// ============================================
// Source and Edge Types
// ============================================

/** Source of an observation */
export type ObservationSource =
  | 'market'
  | 'news'
  | 'earnings'
  | 'email'
  | 'human'
  | 'tool';

/** Edge type in the derivation graph */
export type EdgeType = 'derived_from' | 'violated_by' | 'confirmed_by';

/** Damage level when a violation occurs */
export type DamageLevel = 'core' | 'peripheral';

/** Robustness tier based on exposure/confirmation history */
export type Robustness = 'untested' | 'brittle' | 'tested' | 'robust';

/** Exposure check status for tracking async processing */
export type ExposureCheckStatus = 'pending' | 'processing' | 'completed' | 'skipped';

/** Source of a violation (direct observation match or cascade from related memory) */
export type ViolationSource = 'direct' | 'cascade';

/**
 * Memory state in the state machine.
 * Represents the current lifecycle stage of a memory.
 *
 * Transitions:
 *   active → confirmed (high confidence or definitive confirmation)
 *   active → violated (observation contradicted prediction/inference)
 *   active → resolved (deadline passed, manual resolution)
 *   violated → resolved (after review/revision)
 *   confirmed → resolved (optional cleanup)
 */
export type MemoryState = 'active' | 'confirmed' | 'violated' | 'resolved';

// ============================================
// Violation Structure
// ============================================

/** A recorded violation - when an observation matches invalidates_if */
export interface Violation {
  /** Which invalidates_if condition was matched */
  condition: string;
  /** When the violation was detected */
  timestamp: number;
  /** The observation that caused the violation */
  obs_id: string;
  /** How central was the violated thought */
  damage_level: DamageLevel;
  /** Source type: direct observation match or cascade from related memory */
  source_type: ViolationSource;
  /** If cascade, which memory triggered it */
  cascade_source_id?: string;
}

// ============================================
// Core Memory Entity
// ============================================

/**
 * Unified memory entity.
 *
 * Memory type is determined by field presence:
 *   - source → observation
 *   - derived_from → thought
 *   - derived_from + resolves_by → time-bound thought (prediction)
 */
export interface Memory {
  id: string;
  content: string;

  // Origin fields (can coexist in hybrid memories)
  source?: ObservationSource;
  source_url?: string;
  derived_from?: string[];

  // Thought fields
  assumes?: string[];
  invalidates_if?: string[];

  // Time-bound thought fields
  confirms_if?: string[];
  outcome_condition?: string;
  resolves_by?: number;

  // Confidence model (Subjective Logic)
  starting_confidence: number;
  confirmations: number;
  times_tested: number;
  contradictions: number;
  centrality: number;
  /**
   * Graph-aware confidence propagated from neighbors.
   * NULL in DB means never propagated; callers should fall back to local confidence.
   */
  propagated_confidence?: number;

  // State machine
  state: MemoryState;

  // Violations as data (mark, don't delete)
  violations: Violation[];

  // Soft delete for observations
  retracted: boolean;
  retracted_at?: number;
  retraction_reason?: string;

  // Exposure check tracking
  exposure_check_status: ExposureCheckStatus;
  exposure_check_completed_at?: number;

  // Metadata
  tags?: string[];
  obsidian_sources?: string[];
  session_id?: string;
  created_at: number;
  updated_at?: number;
}

/** Database row representation */
export interface MemoryRow {
  id: string;
  content: string;
  source: string | null;
  source_url: string | null;
  derived_from: string | null;
  assumes: string | null;
  invalidates_if: string | null;
  confirms_if: string | null;
  outcome_condition: string | null;
  resolves_by: number | null;
  // Confidence model
  starting_confidence: number;
  confirmations: number;
  times_tested: number;
  contradictions: number;
  centrality: number;
  propagated_confidence: number | null;
  state: string;
  violations: string;
  retracted: number;
  retracted_at: number | null;
  retraction_reason: string | null;
  // Exposure check tracking
  exposure_check_status: string;
  exposure_check_completed_at: number | null;
  // Metadata
  tags: string | null;
  obsidian_sources: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number | null;
}

// ============================================
// Helper Functions for Memory Type Detection
// ============================================

/**
 * Minimal fields needed for type detection.
 * Allows partial queries to still determine memory type.
 */
export interface TypeDetectable {
  source?: string | null;
  derived_from?: string | string[] | null;
  resolves_by?: number | null;
}

/** Check if a memory is an observation (has source) */
export function isObservation(memory: TypeDetectable): boolean {
  return memory.source != null;
}

/** Check if a memory is a thought (has derived_from) */
export function isThought(memory: TypeDetectable): boolean {
  return memory.derived_from != null;
}

/** Check if a memory is a time-bound thought (has resolves_by) */
export function isTimeBound(memory: TypeDetectable): boolean {
  return memory.resolves_by != null;
}

/**
 * Get display type for a memory.
 * Used for UI display and analytics, not for logic.
 * Accepts partial objects with just the type-determining fields.
 */
export function getDisplayType(memory: TypeDetectable): 'observation' | 'thought' | 'prediction' {
  if (memory.source != null) return 'observation';
  if (memory.resolves_by != null) return 'prediction';
  if (isThought(memory)) return 'thought';
  return 'observation'; // fallback
}

// ============================================
// Edge Entity
// ============================================

/** Edge in the derivation graph */
export interface MemoryEdge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  strength: number;
  created_at: number;
}

/** Database row representation */
export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  strength: number;
  created_at: number;
}

// ============================================
// Confidence & Scoring
// ============================================

/** Confidence statistics for a memory */
export interface ConfidenceStats {
  /** Starting confidence (prior belief based on source/type) */
  starting_confidence: number;
  /** Effective confidence (blended prior + evidence) */
  effective_confidence: number;
  /** Robustness tier based on testing history */
  robustness: Robustness;
  /** Number of times tested */
  times_tested: number;
  /** Number of times survived testing */
  confirmations: number;
  /** Number of times contradicted */
  contradictions: number;
  /** Number of memories that depend on this one */
  centrality: number;
  /** Number of recorded violations */
  violation_count: number;
  /** Exposure check status for async processing tracking */
  exposure_check_status: ExposureCheckStatus;
}

/** Scored memory for search results */
export interface ScoredMemory {
  memory: Memory;
  similarity: number;
  confidence: number;
  score: number;
  robustness: Robustness;
}

// ============================================
// Write Path - Request Types
// ============================================

/** Create an observation (intake from reality) */
export interface ObserveRequest {
  content: string;
  source: ObservationSource;
  /** Conditions that would prove this wrong (optional for observations) */
  invalidates_if?: string[];
  /** Conditions that would strengthen this (optional for observations) */
  confirms_if?: string[];
  tags?: string[];
  timestamp?: number;
}

/**
 * Unified memory creation request.
 * Memory type is determined by field presence:
 * - source IS NOT NULL → observation
 * - source IS NULL and derived_from IS NOT NULL → thought
 * - source IS NULL and resolves_by IS NOT NULL → time-bound thought (prediction)
 *
 * At least one of source OR derived_from is required.
 */
export interface MemoryRequest {
  content: string;
  /** Source of observation */
  source?: ObservationSource;
  /** URL/link where this information came from */
  source_url?: string;
  /** IDs of source memories this memory is based on */
  derived_from?: string[];
  /** Conditions that would prove this wrong */
  invalidates_if?: string[];
  /** Conditions that would strengthen this */
  confirms_if?: string[];
  /** Underlying assumptions this memory rests on */
  assumes?: string[];
  /** Unix timestamp deadline for time-bound predictions */
  resolves_by?: number;
  /** What determines success/failure (required if resolves_by set) */
  outcome_condition?: string;
  tags?: string[];
}

/** Manual confirmation of a memory */
export interface ConfirmRequest {
  /** Optional observation that confirms this memory */
  observation_id?: string;
  /** Optional notes about the confirmation */
  notes?: string;
}

/** Manual violation of a memory */
export interface ViolateRequest {
  /** Which invalidates_if condition was matched */
  condition: string;
  /** Optional observation that caused the violation */
  observation_id?: string;
  /** Optional notes about the violation */
  notes?: string;
}

/** Retract an observation */
export interface RetractRequest {
  reason: string;
  /** Optional correcting observation */
  correcting_observation_id?: string;
}

// ============================================
// Write Path - Response Types
// ============================================

/** Response from unified observe endpoint (handles both observations and thoughts) */
export interface ObserveResponse {
  success: true;
  id: string;
  /** Whether this is a time-bound thought (has resolves_by) - only present for thoughts */
  time_bound?: boolean;
  /** Async exposure checking status */
  exposure_check: 'queued';
}

/** Response from confirm endpoint */
export interface ConfirmResponse {
  success: true;
  memory: Memory;
  stats: ConfidenceStats;
}

/** Response from violate endpoint */
export interface ViolateResponse {
  success: true;
  memory: Memory;
  stats: ConfidenceStats;
  /** Downstream memories flagged for review */
  affected: Array<{
    id: string;
  }>;
}

/** Response from retract endpoint */
export interface RetractResponse {
  success: true;
  observation_id: string;
  affected: Array<{
    id: string;
  }>;
}

// ============================================
// Read Path - Request Types
// ============================================

/** Semantic search request */
export interface FindRequest {
  query: string;
  /** Filter by memory characteristics */
  filter?: {
    /** Only observations */
    observations_only?: boolean;
    /** Only thoughts */
    thoughts_only?: boolean;
    /** Only time-bound thoughts */
    predictions_only?: boolean;
  };
  limit?: number;
  min_similarity?: number;
  /** Include retracted memories */
  include_retracted?: boolean;
}

/** Graph traversal request */
export interface ReferenceRequest {
  direction?: 'up' | 'down' | 'both';
  max_depth?: number;
  min_strength?: number;
  edge_types?: EdgeType[];
}

/** Brittle memories request */
export interface BrittleRequest {
  /** Max exposures to consider "brittle" */
  max_exposures?: number;
  /** Min confidence to include */
  min_confidence?: number;
  limit?: number;
}

/** Graveyard analysis request */
export interface GraveyardRequest {
  /** Group by: condition, source, time_period */
  group_by?: 'condition' | 'source' | 'time_period';
  limit?: number;
}

// ============================================
// Read Path - Response Types
// ============================================

/** Response from find endpoint */
export interface FindResponse {
  results: ScoredMemory[];
  query: string;
  total: number;
}

/** Response from recall endpoint */
export interface RecallResponse {
  memory: Memory;
  stats: ConfidenceStats;
  edges: MemoryEdge[];
  /** Connected memories */
  connections: Memory[];
}

/** Node in reference traversal */
export interface ReferenceNode {
  memory: Memory;
  edge_type: EdgeType;
  strength: number;
  depth: number;
}

/** Response from reference endpoint */
export interface ReferenceResponse {
  center: Memory;
  ancestors: ReferenceNode[];
  descendants: ReferenceNode[];
}

/** Response from brittle endpoint */
export interface BrittleResponse {
  memories: Array<{
    memory: Memory;
    stats: ConfidenceStats;
    /** Why this is brittle */
    reason: string;
  }>;
  total: number;
}

/** Violation pattern in graveyard analysis */
export interface ViolationPattern {
  /** The condition that was violated */
  condition: string;
  /** How many times this pattern occurred */
  count: number;
  /** Example memory IDs */
  example_ids: string[];
}

/** Response from graveyard endpoint */
export interface GraveyardResponse {
  patterns: ViolationPattern[];
  total_violations: number;
  /** Most common violated conditions */
  top_conditions: Array<{ condition: string; count: number }>;
  /** Sources that cause most violations */
  top_sources: Array<{ source: ObservationSource; count: number }>;
}

/** Response from pending endpoint (predictions past deadline) */
export interface PendingResponse {
  predictions: Array<{
    memory: Memory;
    stats: ConfidenceStats;
    days_overdue: number;
  }>;
  total: number;
}

// ============================================
// Insights Types
// ============================================

/** View type for insights endpoint */
export type InsightView =
  | 'hubs'
  | 'orphans'
  | 'untested'
  | 'failing'
  | 'recent'
  | 'brittle';

/** Response from insights endpoint */
export interface InsightsResponse {
  view: InsightView;
  memories: Array<{
    memory: Memory;
    stats: ConfidenceStats;
    /** View-specific metric */
    metric?: number;
  }>;
  total: number;
}

/** Response from knowledge endpoint */
export interface KnowledgeResponse {
  topic: string;
  memory_count: number;
  avg_confidence: number;
  avg_exposures: number;
  total_centrality: number;
  key_memories: Memory[];
}

// ============================================
// Bulk Operation Types
// ============================================

export interface BulkCreateRequest {
  memories: Array<MemoryRequest>;
  skip_dedup?: boolean;
}

export interface BulkDeleteRequest {
  ids: string[];
}

// ============================================
// Memory Events (for coordinator)
// ============================================

export type MemoryEventType =
  | 'observation:created'
  | 'observation:retracted'
  | 'memory:violated'
  | 'memory:confirmed'
  | 'thought:auto_confirmed'
  | 'thought:created';

/**
 * Memory event for coordinator batching/dispatch.
 * Flexible structure to support various event types.
 */
export interface MemoryEvent {
  type: MemoryEventType;
  memory_id: string;
  session_id?: string;
  timestamp: number;
  content?: string;
  /** Observation that caused a violation */
  violated_by?: string;
  /** Damage level for violations */
  damage_level?: DamageLevel;
  /** Similarity score for confirmations */
  similarity?: number;
  /** Additional context */
  context?: Record<string, unknown>;
}

// ============================================
// Exposure Check Types (for async processing)
// ============================================

/**
 * Job queued for async exposure checking.
 * Supports bi-directional checking:
 * - When source is set: check if this observation violates existing thoughts
 * - When only derived_from is set: check if existing observations would violate this
 */
export interface ExposureCheckJob {
  /** The memory being checked */
  memory_id: string;
  /** Content of the memory */
  content: string;
  /** Embedding of the memory content */
  embedding: number[];
  /** Session ID for batching */
  session_id?: string;
  /** Request ID for tracing */
  request_id: string;
  /** When the job was created */
  timestamp: number;
  /**
   * For thoughts: the invalidates_if conditions to check against existing observations.
   * Already embedded separately but included for LLM judging.
   */
  invalidates_if?: string[];
  /**
   * For time-bound thoughts: the confirms_if conditions to check against existing observations.
   * Already embedded separately but included for LLM judging.
   */
  confirms_if?: string[];
  /**
   * Whether this is a time-bound thought (has resolves_by deadline).
   * Used to determine confirms_if behavior.
   */
  time_bound?: boolean;
  /**
   * Whether this is an observation (has source).
   * If true, we check if it violates existing thoughts.
   * If false, we check if existing observations would violate it.
   */
  is_observation?: boolean;
}

/** Result of exposure checking */
export interface ExposureCheckResult {
  /** Memories that were violated (invalidates_if or assumes matched) */
  violations: Array<{
    memory_id: string;
    condition: string;
    confidence: number;
    damage_level: DamageLevel;
    /** Whether this was an assumption violation vs explicit invalidates_if */
    condition_type?: 'invalidates_if' | 'assumes';
  }>;
  /** Memories that were confirmed (tested but not violated) */
  confirmations: Array<{
    memory_id: string;
    similarity: number;
  }>;
  /** Predictions that were auto-confirmed via confirms_if match */
  autoConfirmed: Array<{
    memory_id: string;
    condition: string;
    confidence: number;
  }>;
}

// ============================================
// Health & Stats
// ============================================

export interface MemoryHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  d1: 'ok' | 'error';
  vectorize: 'ok' | 'error';
  ai: 'ok' | 'error';
}

export interface MemoryStatsResponse {
  total_memories: number;
  observations: number;
  thoughts: number;
  predictions: number;
  total_edges: number;
  avg_confidence: number;
  avg_exposures: number;
  retracted_count: number;
}

export interface TagInfo {
  name: string;
  count: number;
}
