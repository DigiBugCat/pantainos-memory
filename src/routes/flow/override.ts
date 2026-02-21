/**
 * Override Route - POST /api/override
 *
 * Commits a draft memory to active state. Runs the full pipeline:
 * 1. Flip state from 'draft' to 'active'
 * 2. Generate embeddings and upsert to vectorize
 * 3. Queue exposure check
 */

import { Hono } from 'hono';
import type { ExposureCheckJob } from '../../lib/shared/types/index.js';
import { logField, logOperation } from '../../lib/shared/logging/index.js';
import type { Env } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import { generateEmbedding } from '../../lib/embeddings.js';

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
};

type MemoryRow = {
  id: string;
  content: string;
  source: string | null;
  state: string;
  derived_from: string | null;
  invalidates_if: string | null;
  confirms_if: string | null;
  assumes: string | null;
  resolves_by: number | null;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');

  let body: { memory_id: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  if (!body.memory_id || typeof body.memory_id !== 'string') {
    return c.json({ success: false, error: 'memory_id is required' }, 400);
  }

  // Fetch the draft
  const memory = await c.env.DB.prepare(
    `SELECT id, content, source, state, derived_from, invalidates_if, confirms_if, assumes, resolves_by
     FROM memories WHERE id = ?`
  ).bind(body.memory_id).first<MemoryRow>();

  if (!memory) {
    return c.json({ success: false, error: `Memory ${body.memory_id} not found` }, 404);
  }

  if (memory.state !== 'draft') {
    return c.json({ success: false, error: `Memory ${body.memory_id} is already ${memory.state} (not a draft)` }, 409);
  }

  const now = Date.now();
  const id = memory.id;
  const hasSource = memory.source !== null;
  const hasDerivedFrom = memory.derived_from !== null;
  const timeBound = memory.resolves_by !== null;
  const invalidates_if: string[] = memory.invalidates_if ? JSON.parse(memory.invalidates_if) : [];
  const confirms_if: string[] = memory.confirms_if ? JSON.parse(memory.confirms_if) : [];
  const hasConditions = invalidates_if.length > 0 || confirms_if.length > 0;

  // 1. Flip to active
  await c.env.DB.prepare(
    `UPDATE memories SET state = 'active', updated_at = ? WHERE id = ?`
  ).bind(now, id).run();

  // 2. Generate embeddings and upsert to vectorize
  const contentEmbedding = await generateEmbedding(c.env.AI, memory.content, config, requestId);

  const conditionTasks: Promise<number[]>[] = [];
  for (const condition of invalidates_if) {
    conditionTasks.push(generateEmbedding(c.env.AI, condition, config, requestId));
  }
  for (const condition of confirms_if) {
    conditionTasks.push(generateEmbedding(c.env.AI, condition, config, requestId));
  }
  const condResults = await Promise.all(conditionTasks);
  const invEmbeddings = condResults.slice(0, invalidates_if.length);
  const confEmbeddings = condResults.slice(invalidates_if.length);

  const contentMetadata = hasSource
    ? { type: 'obs', source: memory.source, has_invalidates_if: invalidates_if.length > 0, has_confirms_if: confirms_if.length > 0 }
    : { type: 'thought', has_invalidates_if: invalidates_if.length > 0, has_assumes: Boolean(memory.assumes), has_confirms_if: confirms_if.length > 0, has_outcome: timeBound, resolves_by: memory.resolves_by, time_bound: timeBound };

  const upserts: Promise<unknown>[] = [
    c.env.MEMORY_VECTORS.upsert([{ id, values: contentEmbedding, metadata: contentMetadata as any }]),
  ];

  if (invEmbeddings.length > 0) {
    const condVectors = invalidates_if.map((condition, index) => ({
      id: `${id}:inv:${index}`,
      values: invEmbeddings[index],
      metadata: { memory_id: id, condition_index: index, condition_text: condition, time_bound: !hasSource && timeBound } as any,
    }));
    upserts.push(c.env.INVALIDATES_VECTORS.upsert(condVectors));
  }

  if (confEmbeddings.length > 0) {
    const condVectors = confirms_if.map((condition, index) => ({
      id: `${id}:conf:${index}`,
      values: confEmbeddings[index],
      metadata: { memory_id: id, condition_index: index, condition_text: condition, time_bound: !hasSource && timeBound } as any,
    }));
    upserts.push(c.env.CONFIRMS_VECTORS.upsert(condVectors));
  }

  await Promise.all(upserts);

  // 3. Queue exposure check
  const exposureJob: ExposureCheckJob = {
    memory_id: id,
    is_observation: hasSource,
    content: memory.content,
    embedding: contentEmbedding,
    session_id: sessionId,
    request_id: requestId,
    timestamp: now,
    invalidates_if: hasConditions ? invalidates_if : undefined,
    confirms_if: hasConditions ? confirms_if : undefined,
    time_bound: timeBound,
  };

  await c.env.DETECTION_QUEUE.send(exposureJob);

  logField(c, 'memory_id', id);
  logField(c, 'state', 'active');
  logOperation(c, 'override', 'committed', { entity_id: id });

  return c.json({
    success: true,
    id,
    status: 'active',
    exposure_check: 'queued',
  }, 200);
});

export default app;
