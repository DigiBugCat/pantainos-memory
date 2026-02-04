/**
 * Insights Route - GET /api/insights/:view
 *
 * Expose analytical views as API endpoints.
 *
 * Views:
 *   - hubs: Most connected entities (by edge count)
 *   - orphans: Observations with no derived inferences
 *   - recent: Newly created entities
 *   - pending_exposure: Memories waiting for exposure check
 *   - untested: Completed exposure check but <3 times_tested (still untested tier)
 *
 * Query params:
 *   - limit: max entities to return (default: 20)
 */

import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { getDisplayType } from '../../lib/shared/types/index.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

export type InsightView = 'hubs' | 'orphans' | 'recent' | 'pending_exposure' | 'untested';

/** Display type for memory entities */
type DisplayType = 'observation' | 'thought' | 'prediction';

export interface InsightEntity {
  id: string;
  type: DisplayType;
  content: string;
  metric?: number; // view-specific metric (e.g., connection count for hubs)
  createdAt: string;
}

export interface InsightsResponse {
  view: InsightView;
  entities: InsightEntity[];
  total: number;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/:view', async (c) => {
  const view = c.req.param('view') as InsightView;
  const limit = parseInt(c.req.query('limit') || '20', 10);

  const validViews: InsightView[] = ['hubs', 'orphans', 'recent', 'pending_exposure', 'untested'];
  if (!validViews.includes(view)) {
    return c.json({
      success: false,
      error: `Invalid view. Must be one of: ${validViews.join(', ')}`,
    }, 400);
  }

  let entities: InsightEntity[] = [];
  let total = 0;

  switch (view) {
    case 'hubs':
      ({ entities, total } = await getHubs(c.env.DB, limit));
      break;
    case 'orphans':
      ({ entities, total } = await getOrphans(c.env.DB, limit));
      break;
    case 'recent':
      ({ entities, total } = await getRecent(c.env.DB, limit));
      break;
    case 'pending_exposure':
      ({ entities, total } = await getPendingExposure(c.env.DB, limit));
      break;
    case 'untested':
      ({ entities, total } = await getUntested(c.env.DB, limit));
      break;
  }

  const response: InsightsResponse = {
    view,
    entities,
    total,
  };

  return c.json(response);
});

/**
 * Get most connected entities (hubs) by counting edges.
 * v4: uses field presence to determine type
 */
async function getHubs(
  db: D1Database,
  limit: number
): Promise<{ entities: InsightEntity[]; total: number }> {
  // Count edges where entity is source OR target
  const result = await db.prepare(`
    WITH all_ids AS (
      SELECT source_id as id FROM edges
      UNION ALL
      SELECT target_id as id FROM edges
    ),
    counts AS (
      SELECT id, COUNT(*) as connection_count
      FROM all_ids
      GROUP BY id
      ORDER BY connection_count DESC
      LIMIT ?
    )
    SELECT c.id, c.connection_count, m.content, m.source, m.derived_from, m.resolves_by, m.created_at
    FROM counts c
    JOIN memories m ON m.id = c.id
    WHERE m.retracted = 0
  `).bind(limit).all<{ id: string; connection_count: number; content: string; source: string | null; derived_from: string | null; resolves_by: number | null; created_at: number }>();

  const entities: InsightEntity[] = (result.results || []).map(row => ({
    id: row.id,
    type: getDisplayType(row),
    content: row.content,
    metric: row.connection_count,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  return { entities, total: entities.length };
}

/**
 * Get orphan observations (no derived inferences).
 * v4: uses field presence (source IS NOT NULL) to identify observations
 */
async function getOrphans(
  db: D1Database,
  limit: number
): Promise<{ entities: InsightEntity[]; total: number }> {
  const result = await db.prepare(`
    SELECT m.id, m.content, m.created_at, m.source, m.derived_from, m.resolves_by
    FROM memories m
    LEFT JOIN edges e ON e.source_id = m.id
    WHERE m.source IS NOT NULL
      AND m.retracted = 0
      AND e.source_id IS NULL
    ORDER BY m.created_at DESC
    LIMIT ?
  `).bind(limit).all<{ id: string; content: string; created_at: number; source: string | null; derived_from: string | null; resolves_by: number | null }>();

  const entities: InsightEntity[] = (result.results || []).map(row => ({
    id: row.id,
    type: getDisplayType(row),
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  // Get total count
  const countResult = await db.prepare(`
    SELECT COUNT(*) as count
    FROM memories m
    LEFT JOIN edges e ON e.source_id = m.id
    WHERE m.source IS NOT NULL
      AND m.retracted = 0
      AND e.source_id IS NULL
  `).first<{ count: number }>();

  return { entities, total: countResult?.count || entities.length };
}

/**
 * Get recently created entities.
 * v4: uses field presence to determine type
 */
async function getRecent(
  db: D1Database,
  limit: number
): Promise<{ entities: InsightEntity[]; total: number }> {
  const result = await db.prepare(`
    SELECT id, content, created_at, source, derived_from, resolves_by
    FROM memories
    WHERE retracted = 0
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all<{ id: string; content: string; created_at: number; source: string | null; derived_from: string | null; resolves_by: number | null }>();

  const entities: InsightEntity[] = (result.results || []).map(row => ({
    id: row.id,
    type: getDisplayType(row),
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  return { entities, total: entities.length };
}

/**
 * Get memories waiting for exposure check.
 * These are memories with exposure_check_status = 'pending' or 'processing'.
 */
async function getPendingExposure(
  db: D1Database,
  limit: number
): Promise<{ entities: InsightEntity[]; total: number }> {
  const result = await db.prepare(`
    SELECT id, content, created_at, source, derived_from, resolves_by, exposure_check_status
    FROM memories
    WHERE retracted = 0
      AND exposure_check_status IN ('pending', 'processing')
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(limit).all<{ id: string; content: string; created_at: number; source: string | null; derived_from: string | null; resolves_by: number | null; exposure_check_status: string }>();

  const entities: InsightEntity[] = (result.results || []).map(row => ({
    id: row.id,
    type: getDisplayType(row),
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  // Get total count
  const countResult = await db.prepare(`
    SELECT COUNT(*) as count
    FROM memories
    WHERE retracted = 0
      AND exposure_check_status IN ('pending', 'processing')
  `).first<{ count: number }>();

  return { entities, total: countResult?.count || entities.length };
}

/**
 * Get memories that completed exposure check but are still untested.
 * These are memories with exposure_check_status = 'completed' AND times_tested < 3.
 * They've been checked but haven't been tested enough to have meaningful robustness.
 * v4: uses field presence (derived_from IS NOT NULL) to identify thoughts
 */
async function getUntested(
  db: D1Database,
  limit: number
): Promise<{ entities: InsightEntity[]; total: number }> {
  const result = await db.prepare(`
    SELECT id, content, created_at, source, derived_from, resolves_by, times_tested
    FROM memories
    WHERE retracted = 0
      AND derived_from IS NOT NULL
      AND exposure_check_status = 'completed'
      AND times_tested < 3
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(limit).all<{ id: string; content: string; created_at: number; source: string | null; derived_from: string | null; resolves_by: number | null; times_tested: number }>();

  const entities: InsightEntity[] = (result.results || []).map(row => ({
    id: row.id,
    type: getDisplayType(row),
    content: row.content,
    metric: row.times_tested,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  // Get total count
  const countResult = await db.prepare(`
    SELECT COUNT(*) as count
    FROM memories
    WHERE retracted = 0
      AND derived_from IS NOT NULL
      AND exposure_check_status = 'completed'
      AND times_tested < 3
  `).first<{ count: number }>();

  return { entities, total: countResult?.count || entities.length };
}

export default app;
