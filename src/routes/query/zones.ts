/**
 * Zones Route - POST /api/zones
 *
 * Return a locally consistent reasoning zone: a mutually non-contradictory
 * cluster of memories around a seed, plus boundary contradictions and
 * external support dependency.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv, RecordAccessParams } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { LoggingEnv } from '../../lib/shared/hono/index.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { recordAccessBatch } from '../../services/access-service.js';
import { buildZone } from '../../usecases/build-zone.js';
import { formatZone, scoreZone } from '../../lib/zones.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // Empty body is fine — will validate below
  }

  const result = await buildZone(c.env, config, requestId, {
    query: body.query as string | undefined,
    memoryId: body.memory_id as string | undefined,
    maxDepth: body.max_depth as number | undefined,
    maxSize: body.max_size as number | undefined,
    includeSemantic: body.include_semantic as boolean | undefined,
    minEdgeStrength: body.min_edge_strength as number | undefined,
  });

  if (!result.success) {
    return c.json({ success: false, error: result.error }, 400);
  }

  const { seedId, zoneParams } = result;

  // Record access events
  const accessEvents: RecordAccessParams[] = [];
  let rank = 1;
  for (const m of zoneParams.zoneMembers) {
    accessEvents.push({
      entityId: m.id,
      entityType: getDisplayType(m),
      accessType: 'reference' as const,
      sessionId,
      requestId,
      queryText: body.query as string | undefined,
      queryParams: { tool: 'zones', seedId, maxDepth: body.max_depth, maxSize: body.max_size },
      resultRank: rank++,
    });
  }
  for (const b of zoneParams.boundary) {
    accessEvents.push({
      entityId: b.memory.id,
      entityType: getDisplayType(b.memory),
      accessType: 'reference' as const,
      sessionId,
      requestId,
      queryText: body.query as string | undefined,
      queryParams: { tool: 'zones', seedId },
      resultRank: rank++,
    });
  }
  if (accessEvents.length > 0) {
    await recordAccessBatch(c.env.DB, accessEvents);
  }

  // Return structured JSON
  const quality = scoreZone(zoneParams.zoneMembers, zoneParams.cutMinusEdges.length, zoneParams.lossPlusEdges.length);

  return c.json({
    success: true,
    seed_id: seedId,
    safe: zoneParams.unsafeReasons.length === 0,
    quality: Math.round(quality * 100),
    zone_members: zoneParams.zoneMembers.map(m => ({
      id: m.id,
      content: m.content,
      type: getDisplayType(m),
      state: m.state,
      semantic: zoneParams.semanticMemberIds.has(m.id),
    })),
    internal_edges: zoneParams.internalEdges,
    boundary: zoneParams.boundary.map(b => ({
      id: b.memory.id,
      content: b.memory.content,
      reasons: b.reasons,
    })),
    cut_minus_edges: zoneParams.cutMinusEdges,
    loss_plus_edges: zoneParams.lossPlusEdges,
    unsafe_reasons: zoneParams.unsafeReasons,
    // Also include formatted text for backward compat
    formatted: formatZone(zoneParams),
  });
});

export default app;
