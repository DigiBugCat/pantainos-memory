-- ============================================
-- Migration: Add propagated_confidence + notifications
-- ============================================
-- Phase B-alpha:
-- - propagated_confidence: graph-aware confidence written by shock propagation / daily convergence
-- - notifications: lightweight persisted alerts surfaced on next MCP tools/call

ALTER TABLE memories ADD COLUMN propagated_confidence REAL;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,        -- 'core_violation'
  memory_id TEXT NOT NULL,
  content TEXT NOT NULL,
  context TEXT,              -- JSON string (ShockResult)
  read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
ON notifications(read, created_at DESC);

