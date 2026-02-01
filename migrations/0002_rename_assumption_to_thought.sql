-- ============================================
-- Migration: Rename 'assumption' to 'thought'
-- ============================================
-- This migration unifies terminology:
-- - memory_type: 'assumption' → 'thought'
-- - Updates CHECK constraints
-- - Updates event types
--
-- Both obs and thought are now first-class memory types.
-- The MCP tool is already called 'think()'.

-- ============================================
-- Step 1: Update memories table
-- ============================================
-- SQLite requires table recreation to modify CHECK constraints.

-- Create new table with updated constraint
CREATE TABLE IF NOT EXISTS memories_new (
  id TEXT PRIMARY KEY,
  memory_type TEXT NOT NULL CHECK(memory_type IN ('obs', 'thought')),
  content TEXT NOT NULL,

  -- Source tracking (obs only)
  source TEXT CHECK(source IN ('market', 'news', 'earnings', 'email', 'human', 'tool')),

  -- Thought fields (derived beliefs)
  assumes TEXT,           -- JSON array of underlying assumptions
  invalidates_if TEXT,    -- JSON array ["condition that would damage this"]

  -- Time-bound thought fields (optional - presence determines time-bound)
  confirms_if TEXT,       -- JSON array ["condition that would strengthen this"]
  outcome_condition TEXT, -- What determines success/failure
  resolves_by INTEGER,    -- Deadline timestamp (presence = time-bound)

  -- Confidence model (Unified Thought Model v4)
  starting_confidence REAL DEFAULT 0.5,
  confirmations INTEGER DEFAULT 0,
  times_tested INTEGER DEFAULT 0,
  contradictions INTEGER DEFAULT 0,

  -- Centrality (cached, updated on edge changes)
  centrality INTEGER DEFAULT 0,

  -- Violations as data (mark, don't delete)
  violations TEXT DEFAULT '[]',

  -- Soft delete for observations
  retracted INTEGER DEFAULT 0,
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

  -- Cascade tracking
  cascade_boosts INTEGER DEFAULT 0,
  cascade_damages INTEGER DEFAULT 0,
  last_cascade_at INTEGER,

  -- Metadata
  tags TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

-- Copy data, converting 'assumption' to 'thought'
INSERT INTO memories_new
SELECT
  id,
  CASE WHEN memory_type = 'assumption' THEN 'thought' ELSE memory_type END,
  content,
  source,
  assumes,
  invalidates_if,
  confirms_if,
  outcome_condition,
  resolves_by,
  starting_confidence,
  confirmations,
  times_tested,
  contradictions,
  centrality,
  violations,
  retracted,
  retracted_at,
  retraction_reason,
  state,
  outcome,
  resolved_at,
  exposure_check_status,
  exposure_check_completed_at,
  cascade_boosts,
  cascade_damages,
  last_cascade_at,
  tags,
  session_id,
  created_at,
  updated_at
FROM memories;

-- Drop old table and rename
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(
  (CAST(confirmations AS REAL) / CASE WHEN times_tested = 0 THEN 1 ELSE times_tested END) DESC
) WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_brittle ON memories(times_tested, confirmations)
  WHERE times_tested < 10 AND confirmations > 0 AND retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_contradictions ON memories(contradictions DESC)
  WHERE retracted = 0 AND contradictions > 0;
CREATE INDEX IF NOT EXISTS idx_memories_starting_confidence ON memories(starting_confidence)
  WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_pending ON memories(resolves_by)
  WHERE memory_type = 'thought' AND resolves_by IS NOT NULL AND retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_centrality ON memories(centrality DESC)
  WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source)
  WHERE memory_type = 'obs';
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(memory_type, created_at DESC)
  WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state) WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_state_type ON memories(state, memory_type, created_at DESC) WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_exposure_check ON memories(exposure_check_status)
  WHERE retracted = 0 AND exposure_check_status != 'completed';
CREATE INDEX IF NOT EXISTS idx_memories_cascade_tracking ON memories(last_cascade_at DESC)
  WHERE retracted = 0 AND (cascade_boosts > 0 OR cascade_damages > 0);

-- ============================================
-- Step 2: Update memory_events table
-- ============================================
-- Update event_type values that reference 'assumption'

CREATE TABLE IF NOT EXISTS memory_events_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    -- Direct violations/confirmations
    'violation',
    'thought_confirmed',
    'thought_resolved',
    -- Cascade events
    'thought:cascade_review',
    'thought:cascade_boost',
    'thought:cascade_damage',
    -- Upward propagation events
    'thought:evidence_validated',
    'thought:evidence_invalidated',
    -- Legacy event types (for migration compatibility)
    'prediction_confirmed',
    'prediction_resolved',
    'assumption_confirmed',
    'assumption_resolved',
    'prediction:cascade_review',
    'prediction:cascade_boost',
    'prediction:cascade_damage',
    'prediction:evidence_validated',
    'prediction:evidence_invalidated',
    'assumption:cascade_review',
    'assumption:cascade_boost',
    'assumption:cascade_damage',
    'assumption:evidence_validated',
    'assumption:evidence_invalidated'
  )),
  memory_id TEXT NOT NULL,
  violated_by TEXT,
  damage_level TEXT CHECK(damage_level IN ('core', 'peripheral')),
  context TEXT,
  dispatched INTEGER DEFAULT 0,
  dispatched_at INTEGER,
  workflow_id TEXT,
  created_at INTEGER NOT NULL
);

-- Copy data, mapping old event types to new ones
INSERT INTO memory_events_new
SELECT
  id,
  session_id,
  CASE
    WHEN event_type = 'assumption_confirmed' THEN 'thought_confirmed'
    WHEN event_type = 'assumption_resolved' THEN 'thought_resolved'
    WHEN event_type = 'assumption:cascade_review' THEN 'thought:cascade_review'
    WHEN event_type = 'assumption:cascade_boost' THEN 'thought:cascade_boost'
    WHEN event_type = 'assumption:cascade_damage' THEN 'thought:cascade_damage'
    WHEN event_type = 'assumption:evidence_validated' THEN 'thought:evidence_validated'
    WHEN event_type = 'assumption:evidence_invalidated' THEN 'thought:evidence_invalidated'
    ELSE event_type
  END,
  memory_id,
  violated_by,
  damage_level,
  context,
  dispatched,
  dispatched_at,
  workflow_id,
  created_at
FROM memory_events;

DROP TABLE memory_events;
ALTER TABLE memory_events_new RENAME TO memory_events;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_events_type ON memory_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_session ON memory_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_pending ON memory_events(dispatched, session_id, created_at)
  WHERE dispatched = 0;
CREATE INDEX IF NOT EXISTS idx_events_workflow ON memory_events(workflow_id) WHERE workflow_id IS NOT NULL;

-- ============================================
-- Step 3: Update entity_versions table
-- ============================================
-- Update entity_type column and change_type constraint

CREATE TABLE IF NOT EXISTS entity_versions_new (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT,  -- obs, thought (was: obs, assumption, infer, pred)
  version_number INTEGER NOT NULL,
  content_snapshot TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'created', 'updated', 'violated', 'confirmed', 'retracted',
    'reclassified_as_observation', 'reclassified_as_thought'
  )),
  change_reason TEXT,
  changed_fields TEXT,
  session_id TEXT,
  request_id TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);

-- Copy data, converting entity_type and change_type
INSERT INTO entity_versions_new
SELECT
  id,
  entity_id,
  CASE
    WHEN entity_type = 'assumption' THEN 'thought'
    WHEN entity_type = 'infer' THEN 'thought'
    WHEN entity_type = 'pred' THEN 'thought'
    ELSE entity_type
  END,
  version_number,
  content_snapshot,
  CASE
    WHEN change_type = 'reclassified_as_assumption' THEN 'reclassified_as_thought'
    ELSE change_type
  END,
  change_reason,
  changed_fields,
  session_id,
  request_id,
  user_agent,
  ip_hash,
  created_at
FROM entity_versions;

DROP TABLE entity_versions;
ALTER TABLE entity_versions_new RENAME TO entity_versions;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_versions_entity ON entity_versions(entity_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_versions_created ON entity_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_change ON entity_versions(change_type, created_at DESC);
