-- Migration: Add 'resolved' (and other missing) change_type values to entity_versions
-- SQLite doesn't support ALTER CHECK constraint, so we recreate the table.

-- 1. Create new table with updated constraint
CREATE TABLE entity_versions_new (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT,
  version_number INTEGER NOT NULL,
  content_snapshot TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'created', 'updated', 'violated', 'confirmed', 'retracted',
    'resolved', 'status_changed', 'reclassified_as_observation', 'reclassified_as_thought'
  )),
  change_reason TEXT,
  changed_fields TEXT,
  session_id TEXT,
  request_id TEXT,
  user_agent TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL
);

-- 2. Copy data
INSERT INTO entity_versions_new SELECT * FROM entity_versions;

-- 3. Drop old table
DROP TABLE entity_versions;

-- 4. Rename new table
ALTER TABLE entity_versions_new RENAME TO entity_versions;

-- 5. Recreate indexes
CREATE INDEX IF NOT EXISTS idx_entity_versions_entity_id ON entity_versions(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_versions_created_at ON entity_versions(created_at);
