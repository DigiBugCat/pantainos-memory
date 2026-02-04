-- Migration: Add thought:pending_resolution event type, remove boost/damage
-- SQLite requires table recreation to modify CHECK constraints

-- 1. Create new table with updated constraint
CREATE TABLE memory_events_new (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN (
    -- Direct violations/confirmations
    'violation',
    'thought_confirmed',
    'thought_resolved',
    -- Cascade events (review-only, no boost/damage)
    'thought:cascade_review',
    -- Upward propagation events (evidence validated/invalidated in upstream memories)
    'thought:evidence_validated',
    'thought:evidence_invalidated',
    -- Overdue prediction resolution
    'thought:pending_resolution',
    -- Legacy event types (for migration compatibility)
    'prediction_confirmed',
    'prediction_resolved',
    'assumption_confirmed',
    'assumption_resolved',
    'prediction:cascade_review',
    'prediction:cascade_boost',
    'prediction:cascade_damage',
    'assumption:cascade_review',
    'assumption:cascade_boost',
    'assumption:cascade_damage',
    'prediction:evidence_validated',
    'prediction:evidence_invalidated',
    'assumption:evidence_validated',
    'assumption:evidence_invalidated',
    -- Deprecated but kept for existing data
    'thought:cascade_boost',
    'thought:cascade_damage'
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

-- 2. Copy existing data
INSERT INTO memory_events_new
SELECT * FROM memory_events;

-- 3. Drop old table
DROP TABLE memory_events;

-- 4. Rename new table
ALTER TABLE memory_events_new RENAME TO memory_events;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_memory_events_session_pending
ON memory_events(session_id, dispatched, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_events_memory_id
ON memory_events(memory_id);
