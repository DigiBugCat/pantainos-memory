/**
 * Tags Route
 *
 * List all tags and find entities by tag.
 * v4: queries unified memories table instead of separate entity tables.
 */

import { Hono } from 'hono';
import type { Env } from '../types/index.js';
import { getDisplayType } from '../lib/shared/types/index.js';

const app = new Hono<{ Bindings: Env }>();

/** Display type for memory entities */
type DisplayType = 'memory';

interface TagWithCount {
  name: string;
  count: number;
}

interface TaggedEntity {
  id: string;
  content: string;
  type: DisplayType;
  tags: string[];
  created_at: number;
}

/**
 * GET /api/tags - List all tags with counts
 * Queries tags from unified memories table
 */
app.get('/', async (c) => {
  // Use json_each() to extract tags from memories table
  const result = await c.env.DB.prepare(`
    SELECT json_each.value as tag, COUNT(*) as count
    FROM memories, json_each(tags)
    WHERE tags IS NOT NULL
      AND tags != '[]'
      AND retracted = 0
    GROUP BY json_each.value
    ORDER BY count DESC
  `).all<{ tag: string; count: number }>();

  const tags: TagWithCount[] = (result.results || []).map(row => ({
    name: row.tag,
    count: row.count,
  }));

  return c.json({
    tags,
    total: tags.length,
  });
});

/**
 * GET /api/tags/:tag - Get entities by tag
 * Queries unified memories table for entities matching the tag
 */
app.get('/:tag', async (c) => {
  const tag = decodeURIComponent(c.req.param('tag'));

  // Validate and clamp limit/offset
  const rawLimit = parseInt(c.req.query('limit') || '20');
  const rawOffset = parseInt(c.req.query('offset') || '0');
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 100);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  // Escape for JSON LIKE matching
  const escapedTag = tag.replace(/[%_\\]/g, '\\$&');
  const tagPatterns = [
    `["${escapedTag}"]`,        // Only element
    `["${escapedTag}",%`,       // First element
    `%,"${escapedTag}"]`,       // Last element
    `%,"${escapedTag}",%`,      // Middle element
  ];

  // Query unified memories table
  const result = await c.env.DB.prepare(`
    SELECT id, content, source, derived_from, resolves_by, tags, created_at
    FROM memories
    WHERE retracted = 0 AND (
      tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR
      tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
    )
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...tagPatterns, limit, offset).all<{
    id: string;
    content: string;
    source: string | null;
    derived_from: string | null;
    resolves_by: number | null;
    tags: string | null;
    created_at: number;
  }>();

  const entities: TaggedEntity[] = (result.results || []).map(row => ({
    id: row.id,
    content: row.content,
    type: getDisplayType(row),
    tags: row.tags ? JSON.parse(row.tags) : [],
    created_at: row.created_at,
  }));

  // Get total count
  const countResult = await c.env.DB.prepare(`
    SELECT COUNT(*) as total
    FROM memories
    WHERE retracted = 0 AND (
      tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR
      tags LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
    )
  `).bind(...tagPatterns).first<{ total: number }>();

  const total = countResult?.total || entities.length;

  return c.json({
    tag,
    entities,
    total,
    limit,
    offset,
  });
});

export default app;
