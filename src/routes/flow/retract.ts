/**
 * Retract Route - POST /api/retract/:id
 *
 * Retract an observation (mark as bad data). This:
 * - Marks the observation as retracted
 * - Records the reason and optional correcting observation
 * - Finds downstream inferences/predictions that depend on it
 * - Pushes observation:retracted event to memory queue
 *
 * Note: We don't cascade-delete; downstream memories get a note
 * that one of their sources was retracted, affecting confidence.
 */

import { Hono } from 'hono';
import type { RetractRequest, RetractResponse } from '../../lib/shared/types/index.js';
import { logField } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { recordVersion } from '../../services/history-service.js';
import { decrementCentrality } from '../../services/exposure-checker.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/:id', async (c) => {
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');
  const userAgent = c.get('userAgent');
  const ipHash = c.get('ipHash');

  const observationId = c.req.param('id');
  if (!observationId) {
    return c.json({ success: false, error: 'Observation ID is required' }, 400);
  }

  // Validate request body
  let body: RetractRequest;
  try {
    body = await c.req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      logField(c, 'json_parse_warning', error instanceof Error ? error.message : 'unknown');
    }
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.reason || typeof body.reason !== 'string') {
    return c.json({ success: false, error: 'reason is required' }, 400);
  }

  // Verify observation exists and is not already retracted
  const observation = await c.env.DB.prepare(
    `SELECT id, source, content, retracted FROM memories WHERE id = ?`
  )
    .bind(observationId)
    .first<{ id: string; source: string | null; content: string; retracted: number }>();

  if (!observation) {
    return c.json({ success: false, error: 'Observation not found' }, 404);
  }

  if (observation.source == null) {
    return c.json({ success: false, error: 'Only observations can be retracted' }, 400);
  }

  if (observation.retracted) {
    return c.json({ success: false, error: 'Observation is already retracted' }, 400);
  }

  const now = Date.now();

  // Mark as retracted
  await c.env.DB.prepare(
    `UPDATE memories
     SET retracted = 1, retracted_at = ?, retraction_reason = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(now, body.reason, now, observationId)
    .run();

  // Find downstream memories that depend on this observation
  const downstream = await c.env.DB.prepare(
    `SELECT m.id FROM memories m
     INNER JOIN edges e ON e.source_id = ? AND e.target_id = m.id AND e.edge_type = 'derived_from'
     WHERE m.retracted = 0`
  )
    .bind(observationId)
    .all<{ id: string }>();

  const affected = (downstream.results || []).map(r => ({
    id: r.id,
  }));

  // Decrement centrality for the observation (it's no longer active)
  await decrementCentrality(c.env.DB, observationId);

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: observationId,
    entityType: 'memory',
    changeType: 'retracted',
    contentSnapshot: {
      id: observationId,
      retracted: true,
      retraction_reason: body.reason,
      correcting_observation_id: body.correcting_observation_id,
      affected_count: affected.length,
    },
    changeReason: body.reason,
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  // Note: Retractions are recorded in the audit trail but don't trigger agentic dispatch.
  // The downstream memories remain valid but with weakened confidence basis.
  // If a retraction causes a violation, that will be detected through the normal flow.

  logField(c, 'observation_id', observationId);
  logField(c, 'affected_count', affected.length);

  const response: RetractResponse = {
    success: true,
    observation_id: observationId,
    affected,
  };

  return c.json(response);
});

export default app;
