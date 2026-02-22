import { isNonEmptySource, normalizeSource } from '../lib/source.js';
import type { MemoryRequest, ExposureCheckJob } from '../lib/shared/types/index.js';
import type { Env } from '../types/index.js';
import type { Config } from '../lib/config.js';
import { generateId } from '../lib/id.js';
import { generateEmbedding } from '../lib/embeddings.js';
import { recordVersion } from '../services/history-service.js';

// ============================================
// Commit Payload — all data needed to persist a memory
// ============================================

export interface CommitPayload {
  id: string;
  body: MemoryRequest;
  normalizedSource: string | undefined;
  hasSource: boolean;
  hasDerivedFrom: boolean;
  initialState: 'active' | 'draft';
  timeBound: boolean;
  hasConditions: boolean;
  startingConfidence: number;
  contentEmbedding: number[];
  sessionId: string | undefined;
  requestId: string;
  userAgent: string | undefined;
  ipHash: string | undefined;
  now: number;
  config: Config;
}

export interface ObserveCommitJob extends CommitPayload {
  type: 'observe:commit';
}

// ============================================
// commitMemory — idempotent write to D1 + Vectorize + Queue
// ============================================

export async function commitMemory(env: Env, payload: CommitPayload): Promise<void> {
  const t0 = performance.now();
  const {
    id, body, normalizedSource, hasSource, hasDerivedFrom,
    initialState, timeBound, hasConditions, startingConfidence,
    contentEmbedding, sessionId, requestId, userAgent, ipHash, now, config,
  } = payload;

  // Step 1: D1 INSERT (OR IGNORE for idempotent retries)
  await env.DB.prepare(
    `INSERT OR IGNORE INTO memories (
      id, content, source, source_url, derived_from,
      assumes, invalidates_if, confirms_if,
      outcome_condition, resolves_by,
      starting_confidence, confirmations, times_tested, contradictions,
      centrality, state, violations,
      retracted, tags, obsidian_sources, session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, '[]', 0, ?, ?, ?, ?)`
  ).bind(
    id,
    body.content,
    hasSource ? normalizedSource : null,
    body.source_url || null,
    hasDerivedFrom ? JSON.stringify(body.derived_from) : null,
    body.assumes ? JSON.stringify(body.assumes) : null,
    body.invalidates_if ? JSON.stringify(body.invalidates_if) : null,
    body.confirms_if ? JSON.stringify(body.confirms_if) : null,
    body.outcome_condition || null,
    body.resolves_by || null,
    startingConfidence,
    initialState,
    body.tags ? JSON.stringify(body.tags) : null,
    body.obsidian_sources ? JSON.stringify(body.obsidian_sources) : null,
    sessionId || null,
    now
  ).run();

  // Step 2: Edges + version recording (parallel, both depend on memory existing)
  const postInsertTasks: Promise<unknown>[] = [];

  if (hasDerivedFrom && body.derived_from) {
    const edgeStmts = body.derived_from.map(sourceId =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO edges (id, source_id, target_id, edge_type, strength, created_at)
         VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
      ).bind(generateId(), sourceId, id, now)
    );
    const centralityStmts = body.derived_from.map(sourceId =>
      env.DB.prepare(
        `UPDATE memories SET centrality = centrality + 1, updated_at = ? WHERE id = ?`
      ).bind(now, sourceId)
    );
    postInsertTasks.push(env.DB.batch([...edgeStmts, ...centralityStmts]));
  }

  postInsertTasks.push(recordVersion(env.DB, {
    entityId: id,
    entityType: 'memory',
    changeType: 'created',
    contentSnapshot: {
      id,
      content: body.content,
      source: hasSource ? normalizedSource : undefined,
      source_url: body.source_url || undefined,
      derived_from: hasDerivedFrom ? body.derived_from : undefined,
      assumes: body.assumes,
      invalidates_if: body.invalidates_if,
      confirms_if: body.confirms_if,
      outcome_condition: body.outcome_condition,
      resolves_by: body.resolves_by,
      tags: body.tags,
      obsidian_sources: body.obsidian_sources,
      starting_confidence: startingConfidence,
      confirmations: 0,
      times_tested: 0,
      contradictions: 0,
      centrality: 0,
      state: initialState,
      violations: [],
      retracted: false,
      time_bound: timeBound,
    },
    sessionId,
    requestId,
    userAgent,
    ipHash,
  }));

  await Promise.all(postInsertTasks);

  // Step 3: Vectorize upserts (only for active memories)
  if (initialState === 'active') {
    // Generate condition embeddings
    const conditionTasks: Promise<number[]>[] = [];
    for (const condition of (hasConditions ? body.invalidates_if : undefined) ?? []) {
      conditionTasks.push(generateEmbedding(env.AI, condition, config, requestId));
    }
    for (const condition of (hasConditions ? body.confirms_if : undefined) ?? []) {
      conditionTasks.push(generateEmbedding(env.AI, condition, config, requestId));
    }
    const condResults = await Promise.all(conditionTasks);
    const invCount = (hasConditions ? body.invalidates_if?.length : 0) ?? 0;

    const contentMetadata = hasSource
      ? { type: 'obs', source: normalizedSource, has_invalidates_if: Boolean(hasConditions && body.invalidates_if?.length), has_confirms_if: Boolean(hasConditions && body.confirms_if?.length) }
      : { type: 'thought', has_invalidates_if: Boolean(body.invalidates_if?.length), has_assumes: Boolean(body.assumes?.length), has_confirms_if: Boolean(body.confirms_if?.length), has_outcome: timeBound, resolves_by: body.resolves_by, time_bound: timeBound };

    const upserts: Promise<unknown>[] = [
      env.MEMORY_VECTORS.upsert([{ id, values: contentEmbedding, metadata: contentMetadata as any }]),
    ];

    if (condResults.length > 0 && body.invalidates_if) {
      const invEmbeddings = condResults.slice(0, invCount);
      if (invEmbeddings.length > 0) {
        const condVectors = body.invalidates_if.map((condition, index) => ({
          id: `${id}:inv:${index}`,
          values: invEmbeddings[index],
          metadata: { memory_id: id, condition_index: index, condition_text: condition, time_bound: !hasSource && timeBound } as any,
        }));
        upserts.push(env.INVALIDATES_VECTORS.upsert(condVectors));
      }
    }

    if (condResults.length > 0 && body.confirms_if) {
      const confEmbeddings = condResults.slice(invCount);
      if (confEmbeddings.length > 0) {
        const condVectors = body.confirms_if.map((condition, index) => ({
          id: `${id}:conf:${index}`,
          values: confEmbeddings[index],
          metadata: { memory_id: id, condition_index: index, condition_text: condition, time_bound: !hasSource && timeBound } as any,
        }));
        upserts.push(env.CONFIRMS_VECTORS.upsert(condVectors));
      }
    }

    await Promise.all(upserts);

    // Step 4: Queue exposure check
    const exposureJob: ExposureCheckJob = {
      memory_id: id,
      is_observation: hasSource,
      content: body.content,
      embedding: contentEmbedding,
      session_id: sessionId,
      request_id: requestId,
      timestamp: now,
      invalidates_if: hasConditions ? body.invalidates_if : undefined,
      confirms_if: hasConditions ? body.confirms_if : undefined,
      time_bound: timeBound,
    };

    await env.DETECTION_QUEUE.send(exposureJob);
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  console.log(`[observe commit] id=${id} state=${initialState} duration=${elapsed}ms`);
}

export function normalizeAndValidateSource(
  source: unknown
): { normalizedSource?: string; error?: string } {
  if (source === undefined || source === null) {
    return {};
  }

  if (typeof source !== 'string' || !isNonEmptySource(source)) {
    return { error: 'source must be a non-empty string when provided' };
  }

  return { normalizedSource: normalizeSource(source) };
}

export async function validateDerivedFromIds(
  db: D1Database,
  derivedFrom?: string[] | null
): Promise<string | null> {
  if (!derivedFrom || derivedFrom.length === 0) {
    return null;
  }

  const placeholders = derivedFrom.map(() => '?').join(',');
  const sources = await db.prepare(
    `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
  ).bind(...derivedFrom).all<{ id: string }>();

  if (!sources.results || sources.results.length !== derivedFrom.length) {
    const foundIds = new Set(sources.results?.map((r) => r.id) || []);
    const missing = derivedFrom.filter((id) => !foundIds.has(id));
    return `Source memories not found: ${missing.join(', ')}`;
  }

  return null;
}

export function validateOrigin(
  normalizedSource: string | undefined,
  derivedFrom?: string[] | null
): string | null {
  const hasSource = normalizedSource !== undefined;
  const hasDerivedFrom = derivedFrom !== undefined && derivedFrom !== null && derivedFrom.length > 0;

  if (!hasSource && !hasDerivedFrom) {
    return 'Either "source" or "derived_from" is required';
  }

  return null;
}

export function validateTimeBound(
  resolvesBy: number | undefined,
  outcomeCondition: string | undefined
): string | null {
  const timeBound = resolvesBy !== undefined;
  if (timeBound && !outcomeCondition) {
    return 'outcome_condition is required when resolves_by is set';
  }
  return null;
}
