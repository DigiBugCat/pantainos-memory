-- ============================================
-- Migration: Unified Thought Model - Confidence Redesign
-- ============================================
-- This migration implements the new confidence model using Subjective Logic concepts.
--
-- Changes:
-- 1. Rename exposures → times_tested
-- 2. Add starting_confidence column (prior belief)
-- 3. Add contradictions counter (for insight queries)
-- 4. Create system_stats table for dynamic thresholds

-- ============================================
-- Step 1: Rename exposures to times_tested
-- ============================================
-- Note: SQLite doesn't support RENAME COLUMN directly in older versions.
-- We use a migration approach that works with D1.

ALTER TABLE memories RENAME COLUMN exposures TO times_tested;

-- ============================================
-- Step 2: Add new columns
-- ============================================

-- Starting confidence (prior belief based on source or type)
-- Default 0.5 for existing data (neutral prior)
ALTER TABLE memories ADD COLUMN starting_confidence REAL DEFAULT 0.5;

-- Contradictions counter for insight queries
-- Not used in scoring directly, but useful for detecting conflicted thoughts
ALTER TABLE memories ADD COLUMN contradictions INTEGER DEFAULT 0;

-- ============================================
-- Step 3: Create system_stats table
-- ============================================
-- Stores precomputed statistics updated by daily background job

CREATE TABLE IF NOT EXISTS system_stats (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Keys that will be stored:
-- 'max_times_tested'                    - Global max for normalization
-- 'median_times_tested'                 - For insights
-- 'source:market:learned_confidence'    - Track record for market source
-- 'source:news:learned_confidence'      - Track record for news source
-- 'source:earnings:learned_confidence'  - Track record for earnings source
-- 'source:email:learned_confidence'     - Track record for email source
-- 'source:human:learned_confidence'     - Track record for human source
-- 'source:tool:learned_confidence'      - Track record for tool source

-- ============================================
-- Step 4: Backfill starting_confidence
-- ============================================
-- Set appropriate starting confidence based on source/type

UPDATE memories SET starting_confidence =
  CASE
    -- Observations: source-based confidence
    WHEN memory_type = 'obs' AND source = 'market' THEN 0.75
    WHEN memory_type = 'obs' AND source = 'tool' THEN 0.70
    WHEN memory_type = 'obs' AND source = 'earnings' THEN 0.70
    WHEN memory_type = 'obs' AND source = 'news' THEN 0.55
    WHEN memory_type = 'obs' AND source = 'email' THEN 0.50
    WHEN memory_type = 'obs' AND source = 'human' THEN 0.50
    -- Assumptions: type-based confidence
    -- Time-bound (pred- prefix) get lower starting confidence
    WHEN memory_type = 'assumption' AND id LIKE 'pred-%' THEN 0.35
    WHEN memory_type = 'assumption' THEN 0.40
    -- Default fallback
    ELSE 0.50
  END
WHERE starting_confidence = 0.5 OR starting_confidence IS NULL;

-- ============================================
-- Step 5: Backfill contradictions from violations
-- ============================================

UPDATE memories SET contradictions = json_array_length(violations)
WHERE json_array_length(violations) > 0;

-- ============================================
-- Step 6: Update indexes for new column
-- ============================================

-- Index for finding memories with high contradictions (conflicted)
CREATE INDEX IF NOT EXISTS idx_memories_contradictions ON memories(contradictions DESC)
  WHERE retracted = 0 AND contradictions > 0;

-- Index for starting_confidence (for debugging/inspection)
CREATE INDEX IF NOT EXISTS idx_memories_starting_confidence ON memories(starting_confidence)
  WHERE retracted = 0;

-- ============================================
-- Step 7: Update entity_versions change_type constraint
-- ============================================
-- SQLite requires table recreation to modify CHECK constraints.
-- Add new change types for reclassification operations.

-- Create new table with updated constraint
CREATE TABLE IF NOT EXISTS entity_versions_new (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT,
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

-- Copy data from old table
INSERT INTO entity_versions_new SELECT * FROM entity_versions;

-- Drop old table and rename new one
DROP TABLE entity_versions;
ALTER TABLE entity_versions_new RENAME TO entity_versions;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_versions_entity ON entity_versions(entity_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_versions_created ON entity_versions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_change ON entity_versions(change_type, created_at DESC);
