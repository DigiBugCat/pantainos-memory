/**
 * Update Route - POST /api/update
 *
 * Update a memory's content or metadata. Arrays are merged (not replaced).
 * Content changes on old memories reset test counts.
 * LLM guard blocks thesis changes (use resolve + observe instead).
 */

import { Hono } from 'hono';
import type { Env as BaseEnv, MemoryRow } from '../../types/index.js';
import type { Config } from '../../lib/config.js';
import type { ExposureCheckJob } from '../../lib/shared/types/index.js';
import type { LoggingEnv } from '../../lib/shared/hono/index.js';
import { generateId } from '../../lib/id.js';
import { generateEmbedding, callExternalLLM } from '../../lib/embeddings.js';
import { recordVersion } from '../../services/history-service.js';
import { incrementCentrality } from '../../services/exposure-checker.js';
import { normalizeSource, isNonEmptySource } from '../../lib/source.js';
import { checkMemoryCompleteness, formatCompletenessOutput } from '../../services/classification-challenge.js';


type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
};

function parseResolvesBy(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    return value >= 1e12 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const asNum = Number(trimmed);
    if (!isNaN(asNum) && trimmed.length > 0) {
      return asNum >= 1e12 ? Math.floor(asNum / 1000) : asNum;
    }
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
    return null;
  }
  return null;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post('/', async (c) => {
  const config = c.get('config');
  const requestId = c.get('requestId');
  const sessionId = c.get('sessionId');

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const memory_id = (body.memory_id || body.id) as string | undefined;
  if (!memory_id) {
    return c.json({ success: false, error: 'memory_id is required' }, 400);
  }

  const newContent = body.content as string | undefined;
  const newSource = body.source as string | undefined;
  const newSourceUrl = body.source_url as string | undefined;
  const newDerivedFrom = body.derived_from as string[] | undefined;
  const invalidates_if = body.invalidates_if as string[] | undefined;
  const confirms_if = body.confirms_if as string[] | undefined;
  const assumes = body.assumes as string[] | undefined;
  const rawResolvesBy = body.resolves_by;
  const outcome_condition = body.outcome_condition as string | undefined;
  const tags = body.tags as string[] | undefined;
  const obsidian_sources = body.obsidian_sources as string[] | undefined;

  let normalizedNewSource: string | undefined;
  if (newSource !== undefined) {
    if (typeof newSource !== 'string' || !isNonEmptySource(newSource)) {
      return c.json({ success: false, error: 'source must be a non-empty string when provided' }, 400);
    }
    normalizedNewSource = normalizeSource(newSource);
  }

  const resolves_by = rawResolvesBy !== undefined ? parseResolvesBy(rawResolvesBy) : undefined;
  if (rawResolvesBy !== undefined && resolves_by === null) {
    return c.json({ success: false, error: `Could not parse resolves_by: "${rawResolvesBy}"` }, 400);
  }

  // Fetch the memory
  const row = await c.env.DB.prepare(
    `SELECT * FROM memories WHERE id = ? AND retracted = 0`
  ).bind(memory_id).first<MemoryRow>();

  if (!row) {
    return c.json({ success: false, error: `Memory not found: ${memory_id}` }, 404);
  }

  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const isOldMemory = (now - row.created_at) >= ONE_HOUR_MS;

  // LLM guard: check if content change is correction vs thesis change
  if (newContent && newContent !== row.content) {
    const [oldEmbedding, newEmbedding] = await Promise.all([
      generateEmbedding(c.env.AI, row.content, config, requestId),
      generateEmbedding(c.env.AI, newContent, config, requestId),
    ]);

    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < oldEmbedding.length; i++) {
      dotProduct += oldEmbedding[i] * newEmbedding[i];
      normA += oldEmbedding[i] * oldEmbedding[i];
      normB += newEmbedding[i] * newEmbedding[i];
    }
    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

    if (similarity < 0.7) {
      const guardPrompt = `Compare these two versions of a memory. Is the new version a CORRECTION (rephrasing, fixing errors, adding nuance to the same claim) or a THESIS CHANGE (fundamentally different claim)?

OLD: "${row.content}"
NEW: "${newContent}"

Respond with exactly one word: CORRECTION or THESIS_CHANGE`;

      let isThesisChange = true;
      try {
        let guardResponse: string;
        if (c.env.LLM_JUDGE_URL) {
          guardResponse = await callExternalLLM(
            c.env.LLM_JUDGE_URL,
            guardPrompt,
            { apiKey: c.env.LLM_JUDGE_API_KEY, model: c.env.LLM_JUDGE_MODEL, requestId }
          );
        } else {
          const aiResponse = await c.env.AI.run(
            '@cf/meta/llama-3.1-8b-instruct' as Parameters<typeof c.env.AI.run>[0],
            { messages: [{ role: 'user', content: guardPrompt }] } as { messages: Array<{ role: string; content: string }> }
          ) as { response?: string };
          guardResponse = aiResponse.response || '';
        }
        isThesisChange = guardResponse.toUpperCase().includes('THESIS_CHANGE');
      } catch {
        isThesisChange = similarity < 0.5;
      }

      if (isThesisChange) {
        return c.json({
          success: false,
          error: `This looks like a fundamental change in claim (similarity: ${Math.round(similarity * 100)}%). Use resolve(outcome="superseded") + observe() instead.`,
        }, 422);
      }
    }
  }

  // Determine effective types
  const hasDerivedFrom = row.derived_from !== null;
  const effectiveSource = normalizedNewSource !== undefined ? normalizedNewSource : row.source;
  const effectiveDerivedFrom = newDerivedFrom !== undefined ? newDerivedFrom : (hasDerivedFrom ? JSON.parse(row.derived_from!) : null);
  const hasEffectiveSource = effectiveSource !== null;

  // Validate new derived_from IDs
  if (newDerivedFrom && newDerivedFrom.length > 0) {
    const placeholders = newDerivedFrom.map(() => '?').join(',');
    const sources = await c.env.DB.prepare(
      `SELECT id FROM memories WHERE id IN (${placeholders}) AND retracted = 0`
    ).bind(...newDerivedFrom).all<{ id: string }>();

    if (!sources.results || sources.results.length !== newDerivedFrom.length) {
      const foundIds = new Set(sources.results?.map(r => r.id) || []);
      const missing = newDerivedFrom.filter(id => !foundIds.has(id));
      return c.json({ success: false, error: `Source memories not found: ${missing.join(', ')}` }, 404);
    }
  }

  // Parse existing arrays and merge
  const existingInvalidatesIf: string[] = row.invalidates_if ? JSON.parse(row.invalidates_if) : [];
  const existingConfirmsIf: string[] = row.confirms_if ? JSON.parse(row.confirms_if) : [];
  const existingAssumes: string[] = row.assumes ? JSON.parse(row.assumes) : [];
  const existingTags: string[] = row.tags ? JSON.parse(row.tags) : [];

  const newInvalidatesIf = invalidates_if ? [...existingInvalidatesIf, ...invalidates_if] : existingInvalidatesIf;
  const newConfirmsIf = confirms_if ? [...existingConfirmsIf, ...confirms_if] : existingConfirmsIf;
  const newAssumes = assumes ? [...existingAssumes, ...assumes] : existingAssumes;
  const newTags = tags ? [...new Set([...existingTags, ...tags])] : existingTags;

  const existingObsidianSources: string[] = row.obsidian_sources ? JSON.parse(row.obsidian_sources) : [];
  const newObsidianSources = obsidian_sources ? [...new Set([...existingObsidianSources, ...obsidian_sources])] : existingObsidianSources;

  const newResolvesBy = resolves_by !== undefined ? resolves_by : row.resolves_by;
  const newOutcomeCondition = outcome_condition !== undefined ? outcome_condition : row.outcome_condition;
  const timeBound = newResolvesBy !== null && newResolvesBy !== undefined;

  if (timeBound && !newOutcomeCondition) {
    return c.json({ success: false, error: 'outcome_condition is required when resolves_by is set' }, 400);
  }

  const finalContent = newContent || row.content;

  // Completeness check
  const updateCompleteness = await checkMemoryCompleteness(c.env, c.env.AI, config, {
    content: finalContent,
    has_source: hasEffectiveSource,
    has_derived_from: effectiveDerivedFrom !== null && effectiveDerivedFrom.length > 0,
    has_invalidates_if: newInvalidatesIf.length > 0,
    has_confirms_if: newConfirmsIf.length > 0,
    has_resolves_by: timeBound,
    requestId,
  });
  if (updateCompleteness && !updateCompleteness.is_complete && updateCompleteness.missing_fields.length > 0) {
    return c.json({ success: false, error: formatCompletenessOutput(updateCompleteness) }, 422);
  }

  const effectiveSourceUrl = newSourceUrl !== undefined ? (newSourceUrl || null) : row.source_url ?? null;

  // Update the memory
  await c.env.DB.prepare(
    `UPDATE memories SET
      content = ?, source = ?, source_url = ?, derived_from = ?,
      invalidates_if = ?, confirms_if = ?, assumes = ?,
      resolves_by = ?, outcome_condition = ?,
      tags = ?, obsidian_sources = ?, updated_at = ?
    WHERE id = ?`
  ).bind(
    finalContent,
    hasEffectiveSource ? effectiveSource : null,
    effectiveSourceUrl,
    effectiveDerivedFrom ? JSON.stringify(effectiveDerivedFrom) : null,
    newInvalidatesIf.length > 0 ? JSON.stringify(newInvalidatesIf) : null,
    newConfirmsIf.length > 0 ? JSON.stringify(newConfirmsIf) : null,
    newAssumes.length > 0 ? JSON.stringify(newAssumes) : null,
    newResolvesBy || null,
    newOutcomeCondition || null,
    newTags.length > 0 ? JSON.stringify(newTags) : null,
    newObsidianSources.length > 0 ? JSON.stringify(newObsidianSources) : null,
    now,
    memory_id
  ).run();

  // Reset test counts on old memory content changes
  const contentChanged = newContent !== undefined;
  if (contentChanged && isOldMemory) {
    await c.env.DB.prepare(
      `UPDATE memories SET confirmations = 0, times_tested = 0, contradictions = 0 WHERE id = ?`
    ).bind(memory_id).run();
  }

  // Handle derived_from edge changes
  if (newDerivedFrom !== undefined) {
    await c.env.DB.prepare(
      `DELETE FROM edges WHERE target_id = ? AND edge_type = 'derived_from'`
    ).bind(memory_id).run();

    for (const sourceId of newDerivedFrom) {
      const edgeId = generateId();
      await c.env.DB.prepare(
        `INSERT INTO edges (id, source_id, target_id, edge_type, strength, created_at)
         VALUES (?, ?, ?, 'derived_from', 1.0, ?)`
      ).bind(edgeId, sourceId, memory_id, now).run();
      await incrementCentrality(c.env.DB, sourceId);
    }
  }

  // Re-embed if content or conditions changed
  const addedInvalidatesIf = invalidates_if || [];
  const addedConfirmsIf = confirms_if || [];
  const needsReEmbed = contentChanged || addedInvalidatesIf.length > 0 || addedConfirmsIf.length > 0;

  if (needsReEmbed) {
    const embedding = await generateEmbedding(c.env.AI, finalContent, config, requestId);

    if (addedInvalidatesIf.length > 0) {
      const conditionVectors = await Promise.all(
        addedInvalidatesIf.map(async (condition, idx) => {
          const index = existingInvalidatesIf.length + idx;
          const condEmbedding = await generateEmbedding(c.env.AI, condition, config, requestId);
          return {
            id: `${memory_id}:inv:${index}`,
            values: condEmbedding,
            metadata: { memory_id, condition_index: index, condition_text: condition, time_bound: timeBound },
          };
        })
      );
      await c.env.INVALIDATES_VECTORS.upsert(conditionVectors as any);
    }

    if (addedConfirmsIf.length > 0) {
      const conditionVectors = await Promise.all(
        addedConfirmsIf.map(async (condition, idx) => {
          const index = existingConfirmsIf.length + idx;
          const condEmbedding = await generateEmbedding(c.env.AI, condition, config, requestId);
          return {
            id: `${memory_id}:conf:${index}`,
            values: condEmbedding,
            metadata: { memory_id, condition_index: index, condition_text: condition, time_bound: timeBound },
          };
        })
      );
      await c.env.CONFIRMS_VECTORS.upsert(conditionVectors as any);
    }

    await c.env.MEMORY_VECTORS.upsert([{
      id: memory_id,
      values: embedding,
      metadata: {
        type: hasEffectiveSource ? 'obs' : 'thought',
        source: effectiveSource || undefined,
        has_invalidates_if: newInvalidatesIf.length > 0,
        has_confirms_if: newConfirmsIf.length > 0,
        has_assumes: newAssumes.length > 0,
        has_outcome: timeBound,
        resolves_by: newResolvesBy || undefined,
        time_bound: timeBound,
      } as any,
    }]);

    // Re-queue exposure check
    const exposureJob: ExposureCheckJob = {
      memory_id,
      is_observation: hasEffectiveSource,
      content: finalContent,
      embedding,
      session_id: sessionId,
      request_id: requestId,
      timestamp: now,
      invalidates_if: newInvalidatesIf.length > 0 ? newInvalidatesIf : undefined,
      confirms_if: newConfirmsIf.length > 0 ? newConfirmsIf : undefined,
      time_bound: timeBound,
    };
    if (c.env.DETECTION_QUEUE) {
      await c.env.DETECTION_QUEUE.send(exposureJob);
    }
  }

  // Record version
  await recordVersion(c.env.DB, {
    entityId: memory_id,
    entityType: 'memory',
    changeType: 'updated',
    contentSnapshot: {
      id: memory_id,
      content: finalContent,
      source: effectiveSource || undefined,
      derived_from: effectiveDerivedFrom || undefined,
      assumes: newAssumes.length > 0 ? newAssumes : undefined,
      invalidates_if: newInvalidatesIf.length > 0 ? newInvalidatesIf : undefined,
      confirms_if: newConfirmsIf.length > 0 ? newConfirmsIf : undefined,
      outcome_condition: newOutcomeCondition || undefined,
      resolves_by: newResolvesBy || undefined,
      tags: newTags.length > 0 ? newTags : undefined,
      obsidian_sources: newObsidianSources.length > 0 ? newObsidianSources : undefined,
    },
    sessionId,
    requestId,
  });

  // Build response
  const changes: string[] = [];
  if (contentChanged) changes.push('content');
  if (normalizedNewSource !== undefined) changes.push('source');
  if (newDerivedFrom !== undefined) changes.push('derived_from');
  if (addedInvalidatesIf.length > 0) changes.push('invalidates_if');
  if (addedConfirmsIf.length > 0) changes.push('confirms_if');
  if (assumes && assumes.length > 0) changes.push('assumes');
  if (tags && tags.length > 0) changes.push('tags');
  if (obsidian_sources && obsidian_sources.length > 0) changes.push('obsidian_sources');
  if (resolves_by !== undefined) changes.push('resolves_by');
  if (outcome_condition !== undefined) changes.push('outcome_condition');

  const warnings: string[] = [];
  if (contentChanged && isOldMemory) warnings.push('Test counts reset (evidence tested old content)');
  if (contentChanged && row.centrality > 0) warnings.push(`Memory has ${row.centrality} dependent(s) that may need review`);

  return c.json({
    success: true,
    memory_id,
    changes,
    warnings: warnings.length > 0 ? warnings : undefined,
    content_changed: contentChanged,
    test_counts_reset: contentChanged && isOldMemory,
  });
});

export default app;
