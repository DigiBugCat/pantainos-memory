-- ============================================
-- Migration: Add 'supersedes' edge type
-- ============================================
-- Adds 'supersedes' to the edge_type CHECK constraint on edges table.
-- Used when resolve(outcome='superseded', replaced_by=...) creates lineage.
-- SQLite/D1 does not support ALTER CHECK, so rebuild the table.

PRAGMA foreign_keys = OFF;

CREATE TABLE edges_new (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  edge_type TEXT DEFAULT 'derived_from' CHECK(edge_type IN (
    'derived_from',
    'violated_by',
    'confirmed_by',
    'supersedes'
  )),
  strength REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE
);

INSERT INTO edges_new (id, source_id, target_id, edge_type, strength, created_at, updated_at)
SELECT id, source_id, target_id, edge_type, strength, created_at, updated_at
FROM edges;

DROP TABLE edges;
ALTER TABLE edges_new RENAME TO edges;

-- Recreate edge indexes
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(edge_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_source_target_type ON edges(source_id, target_id, edge_type);

PRAGMA foreign_keys = ON;
