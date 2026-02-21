-- Add 'draft' to the state CHECK constraint.
-- SQLite doesn't support ALTER CONSTRAINT, so we recreate the table.

-- 1. Create new table with updated constraint (all 34 columns from live DB)
CREATE TABLE memories_new (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,
  source_url TEXT,
  derived_from TEXT,
  assumes TEXT,
  invalidates_if TEXT,
  confirms_if TEXT,
  outcome_condition TEXT,
  resolves_by INTEGER,
  starting_confidence REAL DEFAULT 0.7,
  confirmations INTEGER DEFAULT 0,
  times_tested INTEGER DEFAULT 0,
  contradictions INTEGER DEFAULT 0,
  propagated_confidence REAL,
  centrality INTEGER DEFAULT 0,
  violations TEXT DEFAULT '[]',
  state TEXT DEFAULT 'active' CHECK(state IN ('active', 'confirmed', 'violated', 'resolved', 'draft')),
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('correct', 'incorrect', 'voided', 'superseded')),
  resolved_at INTEGER,
  retracted INTEGER DEFAULT 0,
  retracted_at INTEGER,
  retraction_reason TEXT,
  exposure_check_status TEXT DEFAULT 'pending',
  exposure_check_completed_at INTEGER,
  cascade_boosts INTEGER DEFAULT 0,
  cascade_damages INTEGER DEFAULT 0,
  last_cascade_at INTEGER,
  tags TEXT,
  obsidian_sources TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  surprise REAL
);

-- 2. Copy all data
INSERT INTO memories_new SELECT * FROM memories;

-- 3. Drop old table
DROP TABLE memories;

-- 4. Rename new table
ALTER TABLE memories_new RENAME TO memories;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state) WHERE retracted = 0;
CREATE INDEX IF NOT EXISTS idx_memories_resolves_by ON memories(resolves_by) WHERE resolves_by IS NOT NULL AND state = 'active';
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_exposure_status ON memories(exposure_check_status) WHERE exposure_check_status != 'completed';
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_surprise ON memories(surprise) WHERE surprise IS NOT NULL;
