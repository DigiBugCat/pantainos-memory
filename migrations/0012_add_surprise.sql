-- Add surprise score (predictive coding prediction error)
-- NULL = not yet computed. Filled async by queue consumer.
ALTER TABLE memories ADD COLUMN surprise REAL;

CREATE INDEX IF NOT EXISTS idx_memories_surprise ON memories(surprise DESC)
  WHERE retracted = 0 AND surprise IS NOT NULL;
