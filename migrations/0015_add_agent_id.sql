-- Add agent_id for per-agent memory scoping.
-- Existing memories default to '_default' (backwards compatible).
-- '_global' is the reserved value for shared pool memories.

ALTER TABLE memories ADD COLUMN agent_id TEXT NOT NULL DEFAULT '_global';

CREATE INDEX IF NOT EXISTS idx_memories_agent_id ON memories(agent_id, created_at DESC)
  WHERE retracted = 0;
