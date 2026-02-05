/**
 * Violate Route - POST /api/violate/:id
 *
 * Manually violate a memory (record a violation).
 * This adds to the violations array and increments times_tested.
 * Violations mark but don't delete - the graveyard is data.
 */

import { Hono } from 'hono';
import type { ViolateRequest, ViolateResponse, MemoryRow } from '../../lib/shared/types/index.js';
import { getDisplayType } from '../../lib/shared/types/index.js';
import { logField } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { manualViolate } from '../../services/exposure-checker.js';
import { recordVersion } from '../../services/history-service.js';
import { getConfidenceStats } from '../../services/confidence.js';
import { rowToMemory } from '../../lib/transforms.js';
import { queueSignificantEvent } from '../../services/event-queue.js';

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

  const memoryId = c.req.param('id');
  if (!memoryId) {
    return c.json({ success: false, error: 'Memory ID is required' }, 400);
  }

  // Parse body
  let body: ViolateRequest;
  try {
    body = await c.req.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      logField(c, 'json_parse_warning', error instanceof Error ? error.message : 'unknown');
    }
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.condition || typeof body.condition !== 'string') {
    return c.json({ success: false, error: 'condition (violation reason) is required' }, 400);
  }

  // Check if memory exists
  const exists = await c.env.DB.prepare(
    `SELECT id FROM memories WHERE id = ? AND retracted = 0`
  )
    .bind(memoryId)
    .first<{ id: string }>();

  if (!exists) {
    return c.json({ success: false, error: 'Memory not found' }, 404);
  }

  // Perform violation
  const violation = await manualViolate(c.env, memoryId, body.condition, body.observation_id);

  // Get updated memory
  const row = await c.env.DB.prepare(
    `SELECT * FROM memories WHERE id = ?`
  )
    .bind(memoryId)
    .first<MemoryRow>();

  if (!row) {
    return c.json({ success: false, error: 'Memory not found after violation' }, 500);
  }

  const memory = rowToMemory(row);
  const stats = getConfidenceStats(memory);

  // Find downstream memories that might be affected (memories that depend on this one)
  const downstream = await c.env.DB.prepare(
    `SELECT m.id FROM memories m
     INNER JOIN edges e ON e.source_id = ? AND e.target_id = m.id AND e.edge_type = 'derived_from'
     WHERE m.retracted = 0`
  )
    .bind(memoryId)
    .all<{ id: string }>();

  const affected = (downstream.results || []).map(r => ({
    id: r.id,
  }));

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: memoryId,
    entityType: getDisplayType(memory),
    changeType: 'violated',
    contentSnapshot: {
      confirmations: memory.confirmations,
      times_tested: memory.times_tested,
      confidence: stats.effective_confidence,
      violation,
      total_violations: memory.violations.length,
      affected_count: affected.length,
    },
    changeReason: body.condition,
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  // Queue violation as significant event for agentic dispatch
  // Violations are always significant - they indicate something was wrong
  await queueSignificantEvent(c.env, {
    session_id: sessionId,
    event_type: 'violation',
    memory_id: memoryId,
    violated_by: body.observation_id,
    damage_level: violation.damage_level as 'core' | 'peripheral' | undefined,
    context: {
      condition: body.condition,
      new_times_tested: memory.times_tested,
      new_confidence: stats.effective_confidence,
      total_violations: memory.violations.length,
      affected_count: affected.length,
      affected_ids: affected.map((a) => a.id),
    },
  });

  logField(c, 'memory_id', memoryId);
  logField(c, 'damage_level', violation.damage_level);
  logField(c, 'confidence', stats.effective_confidence);

  const response: ViolateResponse = {
    success: true,
    memory,
    stats,
    affected,
  };

  return c.json(response);
});

export default app;
