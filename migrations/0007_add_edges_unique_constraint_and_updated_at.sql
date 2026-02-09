-- Migration: Add updated_at column and UNIQUE constraint to edges table
-- Required for contradiction injection (Paper Eq. 13) which uses
-- ON CONFLICT (source_id, target_id, edge_type) DO UPDATE

-- 1. Add updated_at column
ALTER TABLE edges ADD COLUMN updated_at INTEGER;

-- 2. Deduplicate edges: for each (source, target, type) group with duplicates,
--    keep only the row with the highest strength (lowest rowid as tiebreaker).
DELETE FROM edges
WHERE rowid NOT IN (
  SELECT rowid FROM (
    SELECT rowid, ROW_NUMBER() OVER (
      PARTITION BY source_id, target_id, edge_type
      ORDER BY strength DESC, rowid ASC
    ) AS rn
    FROM edges
  )
  WHERE rn = 1
);

-- 3. Add unique index (acts as the constraint for ON CONFLICT)
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_source_target_type
ON edges(source_id, target_id, edge_type);
