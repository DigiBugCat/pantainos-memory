/**
 * Admin REST Routes for pantainos-memory
 *
 * Maintenance and diagnostic endpoints. Protected by CF Access service token auth.
 * All endpoints return structured JSON.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv } from '../types/index.js';
import type { Config } from '../lib/config.js';
import type { LoggingEnv } from '../lib/shared/hono/index.js';
import type { Violation } from '../lib/shared/types/index.js';
import { deleteConditionVectors } from '../services/embedding-tables.js';
import { propagateResolution } from '../services/cascade.js';
import { callExternalLLM } from '../lib/embeddings.js';
import { buildInvalidatesIfPrompt, parseConditionResponse } from '../services/exposure-checker.js';
import { computeSurprise } from '../services/surprise.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function errorResponse(c: { json: (data: unknown, status?: number) => Response }, message: string, status = 400) {
  return c.json({ success: false, error: message }, status);
}

// ============================================
// POST /queue-status
// ============================================
app.post('/queue-status', async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const detailLevel = (body.detail_level as string) || 'summary';
  const sessionFilter = body.session_id as string | undefined;

  const overall = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN dispatched = 0 THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN dispatched = 1 THEN 1 ELSE 0 END) as dispatched,
      MIN(CASE WHEN dispatched = 0 THEN created_at END) as oldest_pending,
      MAX(created_at) as newest_event
    FROM memory_events
  `).first<{ total: number; pending: number; dispatched: number; oldest_pending: number | null; newest_event: number | null }>();

  let sessionQuery = `
    SELECT session_id, COUNT(*) as event_count, MAX(created_at) as last_activity, MIN(created_at) as oldest_event
    FROM memory_events WHERE dispatched = 0
  `;
  const sessionBinds: string[] = [];
  if (sessionFilter) {
    sessionQuery += ' AND session_id = ?';
    sessionBinds.push(sessionFilter);
  }
  sessionQuery += ' GROUP BY session_id ORDER BY last_activity DESC';

  const sessions = await c.env.DB.prepare(sessionQuery).bind(...sessionBinds)
    .all<{ session_id: string; event_count: number; last_activity: number; oldest_event: number }>();

  const types = await c.env.DB.prepare(`
    SELECT event_type, COUNT(*) as count FROM memory_events WHERE dispatched = 0 GROUP BY event_type ORDER BY count DESC
  `).all<{ event_type: string; count: number }>();

  const result: Record<string, unknown> = {
    success: true,
    total: overall?.total || 0,
    pending: overall?.pending || 0,
    dispatched: overall?.dispatched || 0,
    oldest_pending: overall?.oldest_pending || null,
    types_pending: types.results || [],
    sessions: (sessions.results || []).map(s => ({
      ...s,
      stuck: Date.now() - s.last_activity > 300_000,
    })),
  };

  if (detailLevel === 'detailed') {
    let eventsQuery = `SELECT id, session_id, event_type, memory_id, violated_by, damage_level, created_at
      FROM memory_events WHERE dispatched = 0`;
    const eventsBinds: string[] = [];
    if (sessionFilter) {
      eventsQuery += ' AND session_id = ?';
      eventsBinds.push(sessionFilter);
    }
    eventsQuery += ' ORDER BY created_at DESC LIMIT 50';
    const events = await c.env.DB.prepare(eventsQuery).bind(...eventsBinds).all();
    result.events = events.results || [];
  }

  return c.json(result);
});

// ============================================
// POST /queue-purge
// ============================================
app.post('/queue-purge', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return errorResponse(c, 'Invalid JSON body'); }

  const mode = body.mode as string;
  const sessionId = body.session_id as string | undefined;
  const olderThanHours = (body.older_than_hours as number) || 24;
  const dryRun = body.dry_run !== false;

  if (!mode) return errorResponse(c, 'mode is required');

  const cutoff = Date.now() - (olderThanHours * 3600_000);
  let countQuery: string;
  let deleteQuery: string;
  const binds: (string | number)[] = [];

  switch (mode) {
    case 'dispatched_only':
      countQuery = 'SELECT COUNT(*) as count FROM memory_events WHERE dispatched = 1 AND dispatched_at < ?';
      deleteQuery = 'DELETE FROM memory_events WHERE dispatched = 1 AND dispatched_at < ?';
      binds.push(cutoff);
      break;
    case 'session':
      if (!sessionId) return errorResponse(c, 'session_id is required for mode=session');
      countQuery = 'SELECT COUNT(*) as count FROM memory_events WHERE session_id = ? AND created_at < ?';
      deleteQuery = 'DELETE FROM memory_events WHERE session_id = ? AND created_at < ?';
      binds.push(sessionId, cutoff);
      break;
    case 'all_pending':
      countQuery = 'SELECT COUNT(*) as count FROM memory_events WHERE dispatched = 0 AND created_at < ?';
      deleteQuery = 'DELETE FROM memory_events WHERE dispatched = 0 AND created_at < ?';
      binds.push(cutoff);
      break;
    default:
      return errorResponse(c, `Invalid mode: ${mode}`);
  }

  const countResult = await c.env.DB.prepare(countQuery).bind(...binds).first<{ count: number }>();
  const count = countResult?.count || 0;

  if (dryRun) {
    return c.json({ success: true, dry_run: true, would_delete: count, mode, older_than_hours: olderThanHours });
  }

  if (count > 0) {
    await c.env.DB.prepare(deleteQuery).bind(...binds).run();
  }

  return c.json({ success: true, deleted: count, mode, older_than_hours: olderThanHours });
});

// ============================================
// POST /memory-state
// ============================================
app.post('/memory-state', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return errorResponse(c, 'Invalid JSON body'); }

  const memoryId = body.memory_id as string;
  const newState = body.new_state as string;
  const outcome = body.outcome as string | undefined;
  const reason = body.reason as string;

  if (!memoryId) return errorResponse(c, 'memory_id is required');
  if (!newState) return errorResponse(c, 'new_state is required');
  if (!reason) return errorResponse(c, 'reason is required');
  if (newState === 'resolved' && !outcome) return errorResponse(c, 'outcome is required when new_state is resolved');

  const memory = await c.env.DB.prepare(
    'SELECT id, content, state, outcome, retracted FROM memories WHERE id = ?'
  ).bind(memoryId).first<{ id: string; content: string; state: string; outcome: string | null; retracted: number }>();

  if (!memory) return errorResponse(c, `Memory not found: ${memoryId}`, 404);
  if (memory.retracted) return errorResponse(c, `Memory is retracted: ${memoryId}`, 422);

  const oldState = memory.state;
  const now = Date.now();

  const updates: string[] = ['state = ?', 'updated_at = ?'];
  const values: (string | number | null)[] = [newState, now];

  if (newState === 'resolved') {
    updates.push('outcome = ?', 'resolved_at = ?');
    values.push(outcome!, now);
  } else if (newState === 'active') {
    updates.push('outcome = NULL', 'resolved_at = NULL');
  }

  values.push(memoryId);
  await c.env.DB.prepare(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();

  if (newState !== 'active' && oldState === 'active') {
    await deleteConditionVectors(c.env, memoryId).catch(() => {});
  }

  let cascade_error: string | undefined;
  if (newState === 'resolved' && outcome) {
    try {
      const cascadeOutcome = outcome === 'correct' ? 'correct' : outcome === 'incorrect' ? 'incorrect' : 'void';
      await propagateResolution(c.env, memoryId, cascadeOutcome);
    } catch (err) {
      cascade_error = err instanceof Error ? err.message : String(err);
    }
  }

  return c.json({
    success: true,
    memory_id: memoryId,
    old_state: oldState,
    new_state: newState,
    outcome: outcome || null,
    cascade_error,
  });
});

// ============================================
// POST /condition-vectors-cleanup
// ============================================
app.post('/condition-vectors-cleanup', async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const specificId = body.memory_id as string | undefined;
  const batchSize = Math.min((body.batch_size as number) || 50, 200);
  const dryRun = body.dry_run !== false;

  let query: string;
  const binds: (string | number)[] = [];

  if (specificId) {
    query = `SELECT id, invalidates_if, confirms_if, state, retracted FROM memories WHERE id = ?`;
    binds.push(specificId);
  } else {
    query = `SELECT id, invalidates_if, confirms_if, state, retracted FROM memories
             WHERE (state IN ('resolved', 'violated', 'confirmed') OR retracted = 1)
               AND (invalidates_if IS NOT NULL OR confirms_if IS NOT NULL)
             LIMIT ?`;
    binds.push(batchSize);
  }

  const result = await c.env.DB.prepare(query).bind(...binds)
    .all<{ id: string; invalidates_if: string | null; confirms_if: string | null; state: string; retracted: number }>();

  const memories = result.results || [];
  if (memories.length === 0) {
    return c.json({ success: true, scanned: 0, cleaned: 0, dry_run: dryRun });
  }

  let totalInvalidates = 0;
  let totalConfirms = 0;

  for (const m of memories) {
    const invCount = m.invalidates_if ? JSON.parse(m.invalidates_if).length : 0;
    const confCount = m.confirms_if ? JSON.parse(m.confirms_if).length : 0;
    totalInvalidates += invCount;
    totalConfirms += confCount;

    if (!dryRun) {
      await deleteConditionVectors(c.env, m.id, invCount || 10, confCount || 10);
    }
  }

  return c.json({
    success: true,
    dry_run: dryRun,
    scanned: memories.length,
    invalidates_vectors: totalInvalidates,
    confirms_vectors: totalConfirms,
  });
});

// ============================================
// GET /system-diagnostics
// ============================================
app.get('/system-diagnostics', async (c) => {
  const includeSamples = c.req.query('include_samples') === 'true';

  const [stateResult, retractedResult, typeResult, exposureResult, edgeResult, queueResult, statsResult, brittleResult, orphanResult] = await Promise.all([
    c.env.DB.prepare(`SELECT state, COUNT(*) as count FROM memories WHERE retracted = 0 GROUP BY state`).all<{ state: string; count: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM memories WHERE retracted = 1').first<{ count: number }>(),
    c.env.DB.prepare(`SELECT
      SUM(CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END) as observations,
      SUM(CASE WHEN derived_from IS NOT NULL AND resolves_by IS NULL THEN 1 ELSE 0 END) as thoughts,
      SUM(CASE WHEN resolves_by IS NOT NULL THEN 1 ELSE 0 END) as predictions
    FROM memories WHERE retracted = 0`).first<{ observations: number; thoughts: number; predictions: number }>(),
    c.env.DB.prepare(`SELECT exposure_check_status, COUNT(*) as count FROM memories WHERE retracted = 0 GROUP BY exposure_check_status`).all<{ exposure_check_status: string | null; count: number }>(),
    c.env.DB.prepare(`SELECT edge_type, COUNT(*) as count FROM edges GROUP BY edge_type`).all<{ edge_type: string; count: number }>(),
    c.env.DB.prepare(`SELECT
      SUM(CASE WHEN dispatched = 0 THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN dispatched = 1 THEN 1 ELSE 0 END) as dispatched,
      COUNT(DISTINCT CASE WHEN dispatched = 0 THEN session_id END) as active_sessions
    FROM memory_events`).first<{ pending: number; dispatched: number; active_sessions: number }>(),
    c.env.DB.prepare('SELECT key, value, updated_at FROM system_stats ORDER BY key').all<{ key: string; value: number; updated_at: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND times_tested < 3').first<{ count: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) as count FROM memories m
      WHERE m.retracted = 0 AND m.derived_from IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id = m.id OR e.target_id = m.id)`).first<{ count: number }>(),
  ]);

  const totalActive = (stateResult.results || []).reduce((sum, s) => sum + s.count, 0);

  const response: Record<string, unknown> = {
    success: true,
    memories: {
      total_active: totalActive,
      retracted: retractedResult?.count || 0,
      observations: typeResult?.observations || 0,
      thoughts: typeResult?.thoughts || 0,
      predictions: typeResult?.predictions || 0,
      state_distribution: Object.fromEntries((stateResult.results || []).map(s => [s.state, s.count])),
      exposure_check: Object.fromEntries((exposureResult.results || []).map(e => [e.exposure_check_status || 'null', e.count])),
    },
    graph: {
      total_edges: (edgeResult.results || []).reduce((sum, e) => sum + e.count, 0),
      edge_types: Object.fromEntries((edgeResult.results || []).map(e => [e.edge_type, e.count])),
      orphan_thoughts: orphanResult?.count || 0,
      brittle: brittleResult?.count || 0,
    },
    queue: {
      pending: queueResult?.pending || 0,
      dispatched: queueResult?.dispatched || 0,
      active_sessions: queueResult?.active_sessions || 0,
    },
    system_stats: Object.fromEntries((statsResult.results || []).map(s => [s.key, { value: s.value, updated_at: s.updated_at }])),
  };

  if (includeSamples) {
    const samples: Record<string, Array<{ id: string; content: string }>> = {};
    for (const s of (stateResult.results || [])) {
      const sampleResult = await c.env.DB.prepare(
        'SELECT id, content FROM memories WHERE state = ? AND retracted = 0 LIMIT 3'
      ).bind(s.state).all<{ id: string; content: string }>();
      samples[s.state] = (sampleResult.results || []).map(m => ({ id: m.id, content: m.content.slice(0, 80) }));
    }
    response.samples = samples;
  }

  return c.json(response);
});

// ============================================
// GET /force-dispatch
// ============================================
app.get('/force-dispatch', async (c) => {
  const sessionId = c.req.query('session_id');
  if (!sessionId) return errorResponse(c, 'session_id query param is required');

  const result = await c.env.DB.prepare(`
    SELECT id, event_type, memory_id, violated_by, damage_level, context, created_at
    FROM memory_events WHERE session_id = ? AND dispatched = 0 ORDER BY created_at
  `).bind(sessionId).all<{
    id: string; event_type: string; memory_id: string;
    violated_by: string | null; damage_level: string | null;
    context: string; created_at: number;
  }>();

  return c.json({
    success: true,
    session_id: sessionId,
    count: result.results?.length || 0,
    events: result.results || [],
  });
});

// ============================================
// GET /graph-health
// ============================================
app.get('/graph-health', async (c) => {
  const check = c.req.query('check') || 'all';
  const result: Record<string, unknown> = { success: true };

  if (check === 'orphan_edges' || check === 'all') {
    const orphanEdges = await c.env.DB.prepare(`
      SELECT e.id, e.source_id, e.target_id, e.edge_type FROM edges e
      LEFT JOIN memories ms ON e.source_id = ms.id
      LEFT JOIN memories mt ON e.target_id = mt.id
      WHERE ms.id IS NULL OR mt.id IS NULL LIMIT 50
    `).all<{ id: string; source_id: string; target_id: string; edge_type: string }>();
    result.orphan_edges = orphanEdges.results || [];
  }

  if (check === 'broken_derivations' || check === 'all') {
    const thoughts = await c.env.DB.prepare(`
      SELECT id, derived_from FROM memories WHERE derived_from IS NOT NULL AND retracted = 0 LIMIT 200
    `).all<{ id: string; derived_from: string }>();

    const broken: Array<{ memory_id: string; missing_ref: string }> = [];
    for (const t of (thoughts.results || [])) {
      try {
        const refs: string[] = JSON.parse(t.derived_from);
        for (const ref of refs) {
          const exists = await c.env.DB.prepare('SELECT id FROM memories WHERE id = ? AND retracted = 0').bind(ref).first<{ id: string }>();
          if (!exists) {
            broken.push({ memory_id: t.id, missing_ref: ref });
            if (broken.length >= 20) break;
          }
        }
      } catch { /* skip */ }
      if (broken.length >= 20) break;
    }
    result.broken_derivations = broken;
  }

  if (check === 'duplicate_edges' || check === 'all') {
    const dupes = await c.env.DB.prepare(`
      SELECT source_id, target_id, edge_type, COUNT(*) as count FROM edges
      GROUP BY source_id, target_id, edge_type HAVING count > 1 LIMIT 50
    `).all<{ source_id: string; target_id: string; edge_type: string; count: number }>();
    result.duplicate_edges = dupes.results || [];
  }

  return c.json(result);
});

// ============================================
// POST /bulk-retract
// ============================================
app.post('/bulk-retract', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return errorResponse(c, 'Invalid JSON body'); }

  const memoryId = body.memory_id as string;
  const reason = body.reason as string;
  const cascade = body.cascade === true;
  const dryRun = body.dry_run !== false;

  if (!memoryId) return errorResponse(c, 'memory_id is required');
  if (!reason) return errorResponse(c, 'reason is required');

  const memory = await c.env.DB.prepare(
    'SELECT id, content, retracted FROM memories WHERE id = ?'
  ).bind(memoryId).first<{ id: string; content: string; retracted: number }>();

  if (!memory) return errorResponse(c, `Memory not found: ${memoryId}`, 404);
  if (memory.retracted) return errorResponse(c, `Memory already retracted: ${memoryId}`, 422);

  const toRetract = [memoryId];

  if (cascade) {
    const visited = new Set([memoryId]);
    const queue = [memoryId];
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const descendants = await c.env.DB.prepare(
        `SELECT id FROM memories WHERE derived_from LIKE ? AND retracted = 0`
      ).bind(`%${currentId}%`).all<{ id: string }>();
      for (const d of (descendants.results || [])) {
        if (!visited.has(d.id)) {
          visited.add(d.id);
          toRetract.push(d.id);
          queue.push(d.id);
        }
      }
    }
  }

  if (dryRun) {
    return c.json({ success: true, dry_run: true, would_retract: toRetract.length, ids: toRetract.slice(0, 20) });
  }

  const now = Date.now();
  for (const id of toRetract) {
    await c.env.DB.prepare(
      `UPDATE memories SET retracted = 1, retracted_at = ?, retraction_reason = ?, updated_at = ? WHERE id = ?`
    ).bind(now, reason, now, id).run();
    await deleteConditionVectors(c.env, id).catch(() => {});
  }

  return c.json({ success: true, retracted: toRetract.length, reason });
});

// ============================================
// POST /re-evaluate-violations
// ============================================
app.post('/re-evaluate-violations', async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const memoryId = body.memory_id as string | undefined;
  const batchSize = Math.min((body.batch_size as number) || 10, 50);
  const dryRun = body.dry_run !== false;
  const confidenceThreshold = (body.confidence_threshold as number) || 0.7;

  if (!c.env.LLM_JUDGE_URL) {
    return errorResponse(c, 'LLM_JUDGE_URL not configured');
  }

  let violatedMemories: Array<{ id: string; content: string; violations: string; contradictions: number; times_tested: number; state: string }>;

  if (memoryId) {
    const row = await c.env.DB.prepare(
      `SELECT id, content, violations, contradictions, times_tested, state FROM memories WHERE id = ? AND retracted = 0`
    ).bind(memoryId).first();
    violatedMemories = row ? [row as typeof violatedMemories[0]] : [];
  } else {
    const oneHourAgo = Date.now() - 3600_000;
    const result = await c.env.DB.prepare(
      `SELECT id, content, violations, contradictions, times_tested, state
       FROM memories WHERE state = 'violated' AND retracted = 0 AND updated_at < ?
       ORDER BY updated_at ASC LIMIT ?`
    ).bind(oneHourAgo, batchSize).all();
    violatedMemories = (result.results || []) as typeof violatedMemories;
  }

  if (violatedMemories.length === 0) {
    return c.json({ success: true, processed: 0, cleared: 0, kept: 0, errors: 0 });
  }

  let cleared = 0, kept = 0, errors = 0;
  const details: Array<{ memory_id: string; violations_cleared: number; violations_kept: number }> = [];

  for (const memory of violatedMemories) {
    const violations: Violation[] = JSON.parse(memory.violations || '[]');
    if (violations.length === 0) {
      if (!dryRun) {
        await c.env.DB.prepare(`UPDATE memories SET state = 'active', updated_at = ? WHERE id = ?`).bind(Date.now(), memory.id).run();
      }
      cleared++;
      details.push({ memory_id: memory.id, violations_cleared: 0, violations_kept: 0 });
      continue;
    }

    const keptViolations: Violation[] = [];
    const clearedViolations: Violation[] = [];

    for (const violation of violations) {
      try {
        const obs = await c.env.DB.prepare('SELECT content FROM memories WHERE id = ?').bind(violation.obs_id).first<{ content: string }>();
        if (!obs) { keptViolations.push(violation); continue; }

        const prompt = buildInvalidatesIfPrompt(obs.content, violation.condition, memory.content);
        const responseText = await callExternalLLM(c.env.LLM_JUDGE_URL!, prompt, { apiKey: c.env.LLM_JUDGE_API_KEY, model: c.env.LLM_JUDGE_MODEL });
        const result = parseConditionResponse(responseText);

        if (result.matches && result.confidence >= confidenceThreshold) {
          keptViolations.push(violation);
        } else {
          clearedViolations.push(violation);
        }
      } catch {
        keptViolations.push(violation);
        errors++;
      }
    }

    if (clearedViolations.length > 0 && !dryRun) {
      const now = Date.now();
      const newContradictions = Math.max(0, memory.contradictions - clearedViolations.length);

      if (keptViolations.length === 0) {
        await c.env.DB.prepare(`UPDATE memories SET violations = '[]', contradictions = ?, state = 'active', updated_at = ? WHERE id = ?`)
          .bind(newContradictions, now, memory.id).run();
      } else {
        await c.env.DB.prepare(`UPDATE memories SET violations = ?, contradictions = ?, updated_at = ? WHERE id = ?`)
          .bind(JSON.stringify(keptViolations), newContradictions, now, memory.id).run();
      }

      for (const v of clearedViolations) {
        await c.env.DB.prepare(`DELETE FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = 'violated_by'`).bind(v.obs_id, memory.id).run();
      }
    }

    if (clearedViolations.length > 0) cleared++;
    if (keptViolations.length > 0) kept++;
    details.push({ memory_id: memory.id, violations_cleared: clearedViolations.length, violations_kept: keptViolations.length });
  }

  return c.json({ success: true, dry_run: dryRun, processed: violatedMemories.length, cleared, kept, errors, details });
});

// ============================================
// POST /backfill-surprise
// ============================================
app.post('/backfill-surprise', async (c) => {
  let body: Record<string, unknown> = {};
  try { body = await c.req.json(); } catch { /* empty body ok */ }

  const parallelism = Math.min((body.parallelism as number) || 10, 20);
  const batchSize = Math.min((body.batch_size as number) || 200, 1500);
  const dryRun = body.dry_run === true;

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM memories WHERE retracted = 0 AND surprise IS NULL`
  ).first<{ total: number }>();
  const remaining = countResult?.total || 0;

  if (remaining === 0) {
    return c.json({ success: true, remaining: 0, computed: 0, failed: 0 });
  }

  const toProcess = Math.min(batchSize, remaining);

  if (dryRun) {
    return c.json({ success: true, dry_run: true, remaining, would_process: toProcess, parallelism });
  }

  const rows = await c.env.DB.prepare(
    `SELECT id FROM memories WHERE retracted = 0 AND surprise IS NULL ORDER BY created_at ASC LIMIT ?`
  ).bind(toProcess).all<{ id: string }>();

  const ids = (rows.results || []).map(r => r.id);
  if (ids.length === 0) {
    return c.json({ success: true, remaining: 0, computed: 0, failed: 0 });
  }

  const slices: string[][] = Array.from({ length: parallelism }, () => []);
  for (let i = 0; i < ids.length; i++) {
    slices[i % parallelism].push(ids[i]);
  }

  const env = c.env;

  async function processSlice(sliceIds: string[]): Promise<{ computed: number; failed: number }> {
    let computed = 0, failed = 0;
    for (const id of sliceIds) {
      try {
        const vectors = await env.MEMORY_VECTORS.getByIds([id]);
        if (!vectors || vectors.length === 0 || !vectors[0].values?.length) { failed++; continue; }
        const embedding: number[] = Array.isArray(vectors[0].values) ? vectors[0].values : [...vectors[0].values] as number[];
        const surprise = await computeSurprise(env, id, embedding);
        await env.DB.prepare('UPDATE memories SET surprise = ?, updated_at = ? WHERE id = ?').bind(surprise, Date.now(), id).run();
        computed++;
      } catch { failed++; }
    }
    return { computed, failed };
  }

  const results = await Promise.all(slices.filter(s => s.length > 0).map(processSlice));
  const totalComputed = results.reduce((sum, r) => sum + r.computed, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);

  return c.json({
    success: true,
    computed: totalComputed,
    failed: totalFailed,
    remaining: remaining - totalComputed,
    parallelism,
  });
});

export default app;
