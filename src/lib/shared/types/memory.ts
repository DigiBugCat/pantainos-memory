/**
 * Memory system types - Cognitive Loop Architecture (v4)
 *
 * Two primitives:
 *   1. Observations (obs) - intake from the world
 *   2. Assumptions (assumption) - compressed beliefs with optional deadlines
 *      - Without deadline → general assumption (was: inference)
 *      - With deadline → time-bound assumption (was: prediction)
 *
 * Core principle: Memories are weighted bets, not facts.
 * Confidence = survival rate under test (confirmations / exposures)
 */

// ============================================
// Memory Types
// ============================================

/** Memory type in the cognitive loop */
export type MemoryType = 'obs' | 'assumption';

/** @deprecated Use 'assumption' type - kept for migration compatibility */
export type LegacyMemoryType = 'obs' | 'infer' | 'pred';

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
  /** How central was the violated assumption */
  damage_level: DamageLevel;
  /** Source type: direct observation match or cascade from related memory */
  source_type: ViolationSource;
  /** If cascade, which memory triggered it */
  cascade_source_id?: string;
}

// ============================================
// Core Memory Entity
// ============================================

/** Unified memory entity (obs, infer, or pred) */
export interface Memory {
  id: string;
  memory_type: MemoryType;
  content: string;

  // Source tracking (obs only)
  source?: ObservationSource;

  // Inference fields (infer + pred)
  assumes?: string[];
  invalidates_if?: string[];

  // Prediction fields (pred only)
  confirms_if?: string[];
  outcome_condition?: string;
  resolves_by?: number;

  // Confidence model
  confirmations: number;
  exposures: number;
  centrality: number;

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

  // Cascade tracking
  cascade_boosts: number;
  cascade_damages: number;
  last_cascade_at?: number;

  // Metadata
  tags: string[];
  session_id?: string;
  created_at: number;
  updated_at?: number;
}

/** Database row representation */
export interface MemoryRow {
  id: string;
  memory_type: string;
  content: string;
  source: string | null;
  assumes: string | null;
  invalidates_if: string | null;
  confirms_if: string | null;
  outcome_condition: string | null;
  resolves_by: number | null;
  confirmations: number;
  exposures: number;
  centrality: number;
  state: string;
  violations: string;
  retracted: number;
  retracted_at: number | null;
  retraction_reason: string | null;
  // Exposure check tracking
  exposure_check_status: string;
  exposure_check_completed_at: number | null;
  // Cascade tracking
  cascade_boosts: number;
  cascade_damages: number;
  last_cascade_at: number | null;
  // Metadata
  tags: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number | null;
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
  /** Raw confidence: confirmations / max(exposures, 1) */
  confidence: number;
  /** Robustness tier based on exposure history */
  robustness: Robustness;
  /** Number of times tested */
  exposures: number;
  /** Number of times survived testing */
  confirmations: number;
  /** Number of memories that depend on this one */
  centrality: number;
  /** Number of recorded violations */
  violation_count: number;
  /** Exposure check status for async processing tracking */
  exposure_check_status: ExposureCheckStatus;
  /** Times boosted via cascade from downstream memories */
  cascade_boosts: number;
  /** Times damaged via cascade from downstream memories */
  cascade_damages: number;
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
  tags?: string[];
  timestamp?: number;
}

/**
 * Create an assumption (unified type for inferences and predictions)
 *
 * The presence of optional fields determines behavior:
 * - Without resolves_by → general assumption (was: inference)
 * - With resolves_by → time-bound assumption (was: prediction)
 */
export interface AssumptionRequest {
  content: string;
  derived_from: string[];
  assumes?: string[];
  invalidates_if?: string[];
  /** Conditions that would confirm this assumption (time-bound only) */
  confirms_if?: string[];
  /** What determines success/failure (time-bound only) */
  outcome_condition?: string;
  /** Unix timestamp deadline - presence makes this time-bound */
  resolves_by?: number;
  tags?: string[];
}

/** @deprecated Use AssumptionRequest - kept for migration */
export interface InferRequest {
  content: string;
  derived_from: string[];
  assumes?: string[];
  invalidates_if?: string[];
  tags?: string[];
}

/** @deprecated Use AssumptionRequest with resolves_by - kept for migration */
export interface PredictRequest {
  content: string;
  derived_from: string[];
  assumes?: string[];
  invalidates_if?: string[];
  confirms_if?: string[];
  outcome_condition: string;
  resolves_by: number;
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

/** Response from observe endpoint */
export interface ObserveResponse {
  success: true;
  id: string;
  /** Async exposure checking status */
  exposure_check: 'queued';
}

/** Response from assume endpoint */
export interface AssumptionResponse {
  success: true;
  id: string;
  /** Whether this is a time-bound assumption (has resolves_by) */
  time_bound: boolean;
}

/** @deprecated Use AssumptionResponse - kept for migration */
export interface InferResponse {
  success: true;
  id: string;
}

/** @deprecated Use AssumptionResponse - kept for migration */
export interface PredictResponse {
  success: true;
  id: string;
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
    memory_type: MemoryType;
  }>;
}

/** Response from retract endpoint */
export interface RetractResponse {
  success: true;
  observation_id: string;
  affected: Array<{
    id: string;
    memory_type: MemoryType;
  }>;
}

// ============================================
// Read Path - Request Types
// ============================================

/** Semantic search request */
export interface FindRequest {
  query: string;
  types?: MemoryType[];
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
  memories: Array<ObserveRequest | AssumptionRequest>;
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
  | 'assumption:auto_confirmed'
  | 'assumption:created'
  // Legacy event types for backwards compatibility
  | 'inference:created'
  | 'prediction:created'
  | 'prediction:auto_confirmed';

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
 * - When memory_type is 'obs': check if this observation violates existing assumptions
 * - When memory_type is 'assumption': check if existing observations would violate this
 */
export interface ExposureCheckJob {
  /** The memory being checked */
  memory_id: string;
  /** Type of memory ('obs' or 'assumption') */
  memory_type: MemoryType;
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
   * For assumptions: the invalidates_if conditions to check against existing observations.
   * Already embedded separately but included for LLM judging.
   */
  invalidates_if?: string[];
  /**
   * For time-bound assumptions: the confirms_if conditions to check against existing observations.
   * Already embedded separately but included for LLM judging.
   */
  confirms_if?: string[];
  /**
   * Whether this is a time-bound assumption (has resolves_by deadline).
   * Used to determine confirms_if behavior.
   */
  time_bound?: boolean;
}

/** Legacy job format for backwards compatibility */
export interface LegacyExposureCheckJob {
  observation_id: string;
  observation_content: string;
  embedding: number[];
  session_id?: string;
  request_id: string;
  timestamp: number;
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
  by_type: Record<MemoryType, number>;
  total_edges: number;
  avg_confidence: number;
  avg_exposures: number;
  retracted_count: number;
}

export interface TagInfo {
  name: string;
  count: number;
}
