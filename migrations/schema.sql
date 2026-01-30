-- ============================================
-- Cassandra Memory - Consolidated Schema
-- ============================================
-- This is the complete schema for a fresh database.
-- Uses IF NOT EXISTS for idempotent deployments.
--
-- Environment behavior:
--   Staging: reset.sql runs first (wipes tables), then schema.sql
--   Production: only schema.sql runs (additive changes only)
--
-- Architecture: 2-primitive cognitive loop
--   1. Observations (obs) - raw reality intake
--   2. Assumptions (assumption) - compressed beliefs
--      - Without deadline → general assumption (was: inference)
--      - With deadline → time-bound assumption (was: prediction)

-- ============================================
-- MEMORIES (Unified Entity Table)
-- ============================================
-- Single table for both primitives: obs, assumption
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL CHECK(memory_type IN ('obs', 'assumption')),
  content TEXT NOT NULL,

  -- Source tracking (obs only)
  source TEXT CHECK(source IN ('market', 'news', 'earnings', 'email', 'human', 'tool')),

  -- Assumption fields
  assumes TEXT,           -- JSON array of underlying assumptions
  invalidates_if TEXT,    -- JSON array ["condition that would damage this"]

  -- Time-bound assumption fields (optional - presence determines time-bound)
  confirms_if TEXT,       -- JSON array ["condition that would strengthen this"]
  outcome_condition TEXT, -- What determines success/failure
  resolves_by INTEGER,    -- Deadline timestamp (presence = time-bound)

  -- Confidence model
  confirmations INTEGER DEFAULT 0,  -- Times it held under test
  exposures INTEGER DEFAULT 0,      -- Times it was tested
  -- confidence = confirmations / max(exposures, 1)

  -- Centrality (cached, updated on edge changes)
  centrality INTEGER DEFAULT 0,  -- Count of memories that depend on this one

  -- Violations as data (mark, don't delete)
  violations TEXT DEFAULT '[]',  -- JSON: [{condition, timestamp, obs_id, damage_level}]

  -- Soft delete for observations
  retracted INTEGER DEFAULT 0,      -- 1 = retracted
  retracted_at INTEGER,
  retraction_reason TEXT,

  -- State machine
  state TEXT DEFAULT 'active' CHECK(state IN ('active', 'confirmed', 'violated', 'resolved')),
  outcome TEXT CHECK(outcome IN ('correct', 'incorrect', 'voided')),
  resolved_at INTEGER,

  -- Exposure check tracking
  exposure_check_status TEXT DEFAULT 'pending'
    CHECK(exposure_check_status IN ('pending', 'processing', 'completed', 'skipped')),
  exposure_check_completed_at INTEGER,

  -- Cascade tracking (for enhanced confidence calculation)
  cascade_boosts INTEGER DEFAULT 0,   -- Times boosted via cascade from downstream
  cascade_damages INTEGER DEFAULT 0,  -- Times damaged via cascade from downstream
  last_cascade_at INTEGER,

  -- Metadata
  tags TEXT,              -- JSON array
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

-- Core indices
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id, created_at);

-- Confidence-based ranking
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(
  (CAST(confirmations AS REAL) / CASE WHEN exposures = 0 THEN 1 ELSE exposures END) DESC
) WHERE retracted = 0;

-- Brittle memories: high confidence but low exposure
CREATE INDEX IF NOT EXISTS idx_memories_brittle ON memories(exposures, confirmations)
  WHERE exposures < 10 AND confirmations > 0 AND retracted = 0;

-- Pending time-bound assumptions past deadline
CREATE INDEX IF NOT EXISTS idx_memories_pending ON memories(resolves_by)
  WHERE memory_type = 'assumption' AND resolves_by IS NOT NULL AND retracted = 0;

-- Centrality for hub detection
CREATE INDEX IF NOT EXISTS idx_memories_centrality ON memories(centrality DESC)
  WHERE retracted = 0;

-- Source filtering for observations
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)
  WHERE memory_type = 'obs';

-- Active memories filter
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(memory_type, created_at DESC)
  WHERE retracted = 0;

-- State machine indices
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state) WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_state_type ON memories(state, memory_type, created_at DESC) WHERE retracted = 0;

-- Exposure check tracking indices
CREATE INDEX IF NOT EXISTS idx_memories_exposure_check ON memories(exposure_check_status)
  WHERE retracted = 0 AND exposure_check_status != 'completed';
CREATE INDEX IF NOT EXISTS idx_memories_cascade_tracking ON memories(last_cascade_at DESC)
  WHERE retracted = 0 AND (cascade_boosts > 0 OR cascade_damages > 0);


-- ============================================
-- EDGES (Derivation Graph)
-- ============================================
-- Links between memories forming the DAG.
-- source → target means target is derived from source.
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT DEFAULT 'derived_from' CHECK(edge_type IN (
    'derived_from',  -- Normal derivation
    'violated_by',   -- Observation that damaged this
    'confirmed_by'   -- Observation that strengthened this
  )),
  strength REAL DEFAULT 1.0,  -- For strengthen/weaken operations
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);


-- ============================================
-- ACCESS EVENTS (Analytics)
-- ============================================
-- Track all memory accesses for analytics and co-access patterns
CREATE TABLE IF NOT EXISTS access_events (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,

  -- Access context
  access_type TEXT NOT NULL CHECK(access_type IN (
    'recall', 'find', 'reference', 'between', 'insights',
    'knowledge', 'pending', 'collisions', 'roots', 'bulk_read'
  )),

  -- Actor tracking
  session_id TEXT,
  request_id TEXT,
  user_agent TEXT,
  ip_hash TEXT,

  -- Query context (for search operations)
  query_text TEXT,
  query_params TEXT,          -- JSON
  result_rank INTEGER,        -- Position in search results (1-indexed)
  similarity_score REAL,      -- Vectorize match score

  accessed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_events_entity ON access_events(entity_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_events_time ON access_events(accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_events_session ON access_events(session_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_events_type ON access_events(access_type, accessed_at DESC);


-- ============================================
-- MEMORY EVENTS (Queue Tracking)
-- ============================================
-- For tracking significant memory events for agentic dispatch.
-- Events accumulate by session_id and are batch-dispatched when
-- the session goes quiet (30s inactivity).
CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    -- Direct violations/confirmations
    'violation',
    'assumption_confirmed',
    'assumption_resolved',
    -- Cascade events (mark for review, don't auto-modify)
    'assumption:cascade_review',
    'assumption:cascade_boost',
    'assumption:cascade_damage',
    -- Upward propagation events (evidence validated/invalidated in upstream memories)
    'assumption:evidence_validated',
    'assumption:evidence_invalidated',
    -- Legacy event types (for migration compatibility)
    'prediction_confirmed',
    'prediction_resolved',
    'inference:cascade_review',
    'inference:cascade_boost',
    'inference:cascade_damage',
    'prediction:cascade_review',
    'prediction:cascade_boost',
    'prediction:cascade_damage',
    'inference:evidence_validated',
    'inference:evidence_invalidated',
    'prediction:evidence_validated',
    'prediction:evidence_invalidated'
  )),
  memory_id TEXT NOT NULL,
  violated_by TEXT,              -- ID of observation that caused violation
  damage_level TEXT CHECK(damage_level IN ('core', 'peripheral')),
  context TEXT,                  -- JSON context for event processing
  dispatched INTEGER DEFAULT 0,  -- 1 = already dispatched
  dispatched_at INTEGER,
  workflow_id TEXT,              -- Workflow that processed this event
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_type ON memory_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_session ON memory_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_pending ON memory_events(dispatched, session_id, created_at)
  WHERE dispatched = 0;
CREATE INDEX IF NOT EXISTS idx_events_workflow ON memory_events(workflow_id) WHERE workflow_id IS NOT NULL;


-- ============================================
-- ENTITY VERSIONS (Audit Trail)
-- ============================================
-- Track all changes for audit and debugging
CREATE TABLE IF NOT EXISTS entity_versions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT,  -- obs, infer, pred, edge
  version_number INTEGER NOT NULL,
  content_snapshot TEXT NOT NULL,  -- JSON of full entity at this version
  change_type TEXT NOT NULL CHECK(change_type IN (
    'created', 'updated', 'violated', 'confirmed', 'retracted'
  )),
  change_reason TEXT,
  changed_fields TEXT,      -- JSON array of field names that changed
  session_id TEXT,
  request_id TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versions_entity ON entity_versions(entity_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_versions_created ON entity_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_change ON entity_versions(change_type, created_at DESC);


-- ============================================
-- EXPERIMENTS (Baseline Tracking)
-- ============================================

-- Experiment runs
CREATE TABLE IF NOT EXISTS experiment_runs (
  id TEXT PRIMARY KEY,
  suite TEXT NOT NULL,                    -- 'violation' | 'collision' | 'resolution' | 'duplicate' | 'all'
  timestamp INTEGER NOT NULL,
  config_json TEXT,                       -- Full ExperimentConfig as JSON
  test_case_hash TEXT,                    -- Hash of test cases to detect changes
  summary_json TEXT,                      -- Summary results (best config, recommendations)
  is_baseline INTEGER DEFAULT 0           -- 1 if this is the current baseline for this suite
);

CREATE INDEX IF NOT EXISTS idx_experiment_runs_suite ON experiment_runs(suite);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_baseline ON experiment_runs(suite, is_baseline) WHERE is_baseline = 1;
CREATE INDEX IF NOT EXISTS idx_experiment_runs_timestamp ON experiment_runs(timestamp DESC);

-- Individual case results
CREATE TABLE IF NOT EXISTS experiment_case_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  test_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  thinking_level TEXT,
  threshold REAL,
  predicted INTEGER NOT NULL,
  expected INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  confidence REAL NOT NULL,
  latency_ms REAL NOT NULL,
  tokens INTEGER,
  reasoning_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost REAL,
  raw_response TEXT,
  reasoning_text TEXT,
  FOREIGN KEY (run_id) REFERENCES experiment_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_case_results_run ON experiment_case_results(run_id);
CREATE INDEX IF NOT EXISTS idx_case_results_model_prompt ON experiment_case_results(model, prompt);
CREATE INDEX IF NOT EXISTS idx_case_results_test_id ON experiment_case_results(test_id);

-- Model-prompt aggregate results
CREATE TABLE IF NOT EXISTS experiment_aggregates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  thinking_level TEXT,
  threshold REAL,

  -- Basic metrics
  accuracy REAL NOT NULL,
  precision REAL NOT NULL,
  recall REAL NOT NULL,
  f1_score REAL NOT NULL,

  -- Confusion matrix
  true_positives INTEGER NOT NULL,
  true_negatives INTEGER NOT NULL,
  false_positives INTEGER NOT NULL,
  false_negatives INTEGER NOT NULL,

  -- Calibration
  brier_score REAL,
  expected_calibration_error REAL,

  -- Latency percentiles
  latency_min REAL,
  latency_p50 REAL,
  latency_p90 REAL,
  latency_p95 REAL,
  latency_p99 REAL,
  latency_max REAL,
  latency_avg REAL,

  -- Cost
  total_cost REAL,
  avg_cost_per_case REAL,

  -- By category breakdown (JSON)
  by_category_json TEXT,

  -- Threshold analysis (JSON array)
  threshold_analysis_json TEXT,

  FOREIGN KEY (run_id) REFERENCES experiment_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_aggregates_run ON experiment_aggregates(run_id);
CREATE INDEX IF NOT EXISTS idx_aggregates_model ON experiment_aggregates(model, prompt);
