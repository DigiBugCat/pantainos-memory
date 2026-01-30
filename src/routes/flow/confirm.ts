/**
 * Confirm Route - POST /api/confirm/:id
 *
 * Manually confirm a memory (increase confidence).
 * This increments both confirmations and exposures.
 *
 * Optionally link to an observation that confirms this memory.
 */

import { Hono } from 'hono';
import type { ConfirmRequest, ConfirmResponse, MemoryRow } from '../../lib/shared/types/index.js';
import { logField } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { manualConfirm } from '../../services/exposure-checker.js';
import { recordVersion } from '../../services/history-service.js';
import { getConfidenceStats } from '../../services/confidence.js';
import { rowToMemory } from '../../lib/transforms.js';

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

  // Parse optional body
  let body: ConfirmRequest = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional
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

  // Perform confirmation
  await manualConfirm(c.env.DB, memoryId, body.observation_id);

  // Get updated memory
  const row = await c.env.DB.prepare(
    `SELECT * FROM memories WHERE id = ?`
  )
    .bind(memoryId)
    .first<MemoryRow>();

  if (!row) {
    return c.json({ success: false, error: 'Memory not found after confirmation' }, 500);
  }

  const memory = rowToMemory(row);
  const stats = getConfidenceStats(memory);

  // Record version for audit trail
  await recordVersion(c.env.DB, {
    entityId: memoryId,
    entityType: memory.memory_type,
    changeType: 'confirmed',
    contentSnapshot: {
      confirmations: memory.confirmations,
      exposures: memory.exposures,
      confidence: stats.confidence,
      observation_id: body.observation_id,
    },
    changeReason: body.notes,
    sessionId,
    requestId,
    userAgent,
    ipHash,
  });

  // Note: Simple confirmations don't trigger agentic dispatch.
  // Only violations and auto-confirmed predictions need the agent's attention.
  // The confirmation is already recorded in the memory and audit trail.

  logField(c, 'memory_id', memoryId);
  logField(c, 'confidence', stats.confidence);

  const response: ConfirmResponse = {
    success: true,
    memory,
    stats,
  };

  return c.json(response);
});

export default app;
