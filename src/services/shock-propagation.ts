/**
 * Shock Propagation Service (Phase B-alpha)
 *
 * On violation, propagate confidence changes locally through support edges.
 * Writes propagated_confidence for neighbors (not the violated seed itself).
 */

import type { Env } from '../types/index.js';
import type { DamageLevel } from '../lib/shared/types/index.js';
import { DEFAULT_MAX_TIMES_TESTED, getEvidenceWeight } from './confidence.js';
import { estimateSpectralRadius } from './spectral.js';
import { queryInChunks } from '../lib/sql-utils.js';
import { createLazyLogger } from '../lib/lazy-logger.js';

const getLog = createLazyLogger('ShockPropagation');

export interface ShockResult {
  affected_count: number;
  max_confidence_drop: number;
  affected_memories: Array<{
    id: string;
    old_confidence: number;
    new_confidence: number;
  }>;
  is_core: boolean;
  iterations: number;
  spectral_radius: number;
  backtrack_attempts: number;
}

const MAX_HOPS = 2;
const MAX_ITERATIONS = 20;
const CONVERGENCE_EPS = 1e-3;
const MIN_STRENGTH = 0.1;
const ALPHA = 0.6;
const CONTRADICTION_ETA = 0.8;
const EPS = 1e-6;

type SupportEdgeType = 'derived_from' | 'confirmed_by';

type EdgeRow = {
  source_id: string;
  target_id: string;
  edge_type: SupportEdgeType;
  strength: number;
};

type ContradictionEdgeRow = {
  source_id: string;
  target_id: string;
  strength: number;
};

type MemoryLiteRow = {
  id: string;
  source: string | null;
  starting_confidence: number;
  confirmations: number;
  times_tested: number;
  propagated_confidence: number | null;
  retracted: number;
};

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeLocalConfidence(row: Pick<MemoryLiteRow, 'starting_confidence' | 'confirmations' | 'times_tested'>): number {
  const evidenceWeight = getEvidenceWeight(row.times_tested, DEFAULT_MAX_TIMES_TESTED);
  const earned = row.confirmations / Math.max(row.times_tested, 1);
  return clamp01(row.starting_confidence * (1 - evidenceWeight) + earned * evidenceWeight);
}

async function fetchIncidentSupportEdges(env: Env, ids: string[]): Promise<EdgeRow[]> {
  if (ids.length === 0) return [];

  return queryInChunks<EdgeRow>(
    env.DB,
    (ph) => `
      SELECT source_id, target_id, edge_type, strength
      FROM edges
      WHERE (source_id IN (${ph}) OR target_id IN (${ph}))
        AND edge_type IN ('derived_from', 'confirmed_by')
        AND strength >= ?
    `,
    ids,
    [],
    [MIN_STRENGTH],
    2,
  );
}

async function fetchMemoriesLite(env: Env, ids: string[]): Promise<MemoryLiteRow[]> {
  if (ids.length === 0) return [];

  return queryInChunks<MemoryLiteRow>(
    env.DB,
    (ph) => `
      SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence, retracted
      FROM memories
      WHERE id IN (${ph})
        AND retracted = 0
    `,
    ids,
    [],
    [],
    1,
  );
}

async function fetchIncomingContradictions(env: Env, targetIds: string[]): Promise<ContradictionEdgeRow[]> {
  if (targetIds.length === 0) return [];

  return queryInChunks<ContradictionEdgeRow>(
    env.DB,
    (ph) => `
      SELECT source_id, target_id, strength
      FROM edges
      WHERE target_id IN (${ph})
        AND edge_type = 'violated_by'
        AND strength >= ?
    `,
    targetIds,
    [],
    [MIN_STRENGTH],
    1,
  );
}

export async function applyShock(env: Env, memoryId: string, damageLevel: DamageLevel): Promise<ShockResult> {
  const shockStart = Date.now();
  getLog().info('shock_starting', { memory_id: memoryId, damage_level: damageLevel });

  // 1) Discover local subgraph (<= 2 hops) using support edges only.
  const nodeIds = new Set<string>([memoryId]);
  let frontier = new Set<string>([memoryId]);

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (frontier.size === 0) break;
    const incident = await fetchIncidentSupportEdges(env, Array.from(frontier));
    const next = new Set<string>();
    for (const e of incident) {
      if (!nodeIds.has(e.source_id)) {
        nodeIds.add(e.source_id);
        next.add(e.source_id);
      }
      if (!nodeIds.has(e.target_id)) {
        nodeIds.add(e.target_id);
        next.add(e.target_id);
      }
    }
    frontier = next;
  }

  const allNodeIds = Array.from(nodeIds);
  if (allNodeIds.length <= 1) {
    return { affected_count: 0, max_confidence_drop: 0, affected_memories: [], is_core: damageLevel === 'core', iterations: 0, spectral_radius: 0, backtrack_attempts: 0 };
  }

  // 2) Load edges within discovered subgraph.
  const incidentAll = await fetchIncidentSupportEdges(env, allNodeIds);
  const edges = incidentAll.filter(e => nodeIds.has(e.source_id) && nodeIds.has(e.target_id) && e.strength >= MIN_STRENGTH);

  // 3) Load memory confidence rows.
  const rows = await fetchMemoriesLite(env, allNodeIds);
  if (rows.length === 0) {
    return { affected_count: 0, max_confidence_drop: 0, affected_memories: [], is_core: damageLevel === 'core', iterations: 0, spectral_radius: 0, backtrack_attempts: 0 };
  }

  const byId = new Map<string, MemoryLiteRow>();
  for (const r of rows) byId.set(r.id, r);

  // 3b) Load incoming contradiction edges (violated_by) targeting nodes in the local neighborhood.
  // We intentionally do not traverse through contradiction sources to keep the shock localized.
  const contradictions = await fetchIncomingContradictions(env, allNodeIds);
  const contradictionIncoming = new Map<string, Array<{ source_id: string; strength: number }>>();
  const contradictionSources = new Set<string>();
  for (const e of contradictions) {
    if (!contradictionIncoming.has(e.target_id)) contradictionIncoming.set(e.target_id, []);
    contradictionIncoming.get(e.target_id)!.push({ source_id: e.source_id, strength: e.strength });
    contradictionSources.add(e.source_id);
  }

  // Fetch source rows for contradiction edges if they weren't part of the discovered support neighborhood.
  const missingSourceIds = Array.from(contradictionSources).filter(id => !byId.has(id));
  if (missingSourceIds.length > 0) {
    const extraRows = await fetchMemoriesLite(env, missingSourceIds);
    for (const r of extraRows) byId.set(r.id, r);
  }

  // 3c) Inject contradiction edges from seed to support neighbors (Paper Eq. 13).
  // ρ controls how much contradiction is distributed to neighbors on shock.
  const RHO = 0.3;
  const seedSupportOut: Array<{ target_id: string; strength: number }> = [];
  for (const e of edges) {
    if (e.source_id === memoryId) {
      seedSupportOut.push({ target_id: e.target_id, strength: e.strength });
    }
  }

  const injectedEdgeKeys = new Set<string>();
  const totalSuppStrength = seedSupportOut.reduce((sum, e) => sum + e.strength, 0);
  if (totalSuppStrength > 0) {
    const shockStrength = damageLevel === 'core' ? 1.0 : 0.4;
    const now3c = Date.now();

    for (const e of seedSupportOut) {
      const proportionalShare = e.strength / totalSuppStrength;
      const injectedStrength = RHO * shockStrength * proportionalShare;

      if (injectedStrength < MIN_STRENGTH) continue;

      injectedEdgeKeys.add(`${memoryId}|${e.target_id}`);

      await env.DB.prepare(`
        INSERT INTO edges (source_id, target_id, edge_type, strength, created_at, updated_at)
        VALUES (?, ?, 'violated_by', ?, ?, ?)
        ON CONFLICT (source_id, target_id, edge_type)
        DO UPDATE SET strength = MIN(strength + ?, 1.0), updated_at = ?
      `).bind(
        memoryId, e.target_id,
        injectedStrength, now3c, now3c,
        injectedStrength, now3c
      ).run();
    }

    // Reload contradiction edges since we just created/updated some.
    const refreshed = await fetchIncomingContradictions(env, allNodeIds);
    contradictionIncoming.clear();
    contradictionSources.clear();
    for (const ce of refreshed) {
      if (!contradictionIncoming.has(ce.target_id)) contradictionIncoming.set(ce.target_id, []);
      contradictionIncoming.get(ce.target_id)!.push({ source_id: ce.source_id, strength: ce.strength });
      contradictionSources.add(ce.source_id);
    }

    // Fetch any new contradiction source rows.
    const newMissing = Array.from(contradictionSources).filter(id => !byId.has(id));
    if (newMissing.length > 0) {
      const extraRows = await fetchMemoriesLite(env, newMissing);
      for (const r of extraRows) byId.set(r.id, r);
    }
  }

  // 4) Build incoming support adjacency (target -> [{source, strength}, ...]).
  const incoming = new Map<string, Array<{ source_id: string; strength: number }>>();
  for (const e of edges) {
    if (!incoming.has(e.target_id)) incoming.set(e.target_id, []);
    incoming.get(e.target_id)!.push({ source_id: e.source_id, strength: e.strength });
  }

  // 4b) Spectral radius check + backtracking (Paper Algorithm 3).
  // Halve injected contradiction strengths until α·‖Â⁺ − η·Â⁻‖₂ < 1.
  const MAX_BACKTRACK = 5;
  const updateableForSpectral = (id: string): boolean => {
    if (id === memoryId) return false;
    const r = byId.get(id);
    if (!r) return false;
    if (r.source != null) return false;
    return true;
  };

  let spectralRadius = estimateSpectralRadius(allNodeIds, incoming, contradictionIncoming, ALPHA, CONTRADICTION_ETA, updateableForSpectral);
  let backtrackAttempts = 0;

  if (spectralRadius >= 1.0 && injectedEdgeKeys.size > 0) {
    const now4b = Date.now();
    while (spectralRadius >= 1.0 && backtrackAttempts < MAX_BACKTRACK) {
      backtrackAttempts++;
      // Halve injected contradiction strengths in DB
      for (const key of injectedEdgeKeys) {
        const [src, tgt] = key.split('|');
        await env.DB.prepare(
          `UPDATE edges SET strength = strength * 0.5, updated_at = ? WHERE source_id = ? AND target_id = ? AND edge_type = 'violated_by'`
        ).bind(now4b, src, tgt).run();
      }
      // Reload contradiction edges
      const refreshed = await fetchIncomingContradictions(env, allNodeIds);
      contradictionIncoming.clear();
      for (const ce of refreshed) {
        if (!contradictionIncoming.has(ce.target_id)) contradictionIncoming.set(ce.target_id, []);
        contradictionIncoming.get(ce.target_id)!.push({ source_id: ce.source_id, strength: ce.strength });
      }
      spectralRadius = estimateSpectralRadius(allNodeIds, incoming, contradictionIncoming, ALPHA, CONTRADICTION_ETA, updateableForSpectral);
    }
  }

  // 5) Initialize x from propagated_confidence or local.
  const local = new Map<string, number>();
  const x = new Map<string, number>();
  for (const id of allNodeIds) {
    const r = byId.get(id);
    if (!r) continue;
    const lc = computeLocalConfidence(r);
    local.set(id, lc);
    x.set(id, r.propagated_confidence ?? lc);
  }

  const getNodeValue = (id: string): number => {
    const v = x.get(id);
    if (v != null) return v;
    const r = byId.get(id);
    if (!r) return 0;
    return computeLocalConfidence(r);
  };

  // 6) Iterate damped updates on local subgraph.
  const updateable = (id: string): boolean => {
    if (id === memoryId) return false; // seed excluded (neighbors only)
    const r = byId.get(id);
    if (!r) return false;
    if (r.source != null) return false; // observations excluded
    return true;
  };

  let totalIterations = 0;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let maxChange = 0;
    const xNew = new Map<string, number>(x);

    for (const id of allNodeIds) {
      if (!updateable(id)) continue;
      const r = byId.get(id);
      if (!r) continue;

      const inc = incoming.get(id) ?? [];
      let supportSum = 0;
      let strengthSum = 0;
      for (const s of inc) {
        const srcVal = getNodeValue(s.source_id);
        supportSum += s.strength * srcVal;
        strengthSum += s.strength;
      }

      const support = strengthSum > 0 ? (supportSum / strengthSum) : 0;

      const cInc = contradictionIncoming.get(id) ?? [];
      let contrSum = 0;
      let contrStrengthSum = 0;
      for (const s of cInc) {
        const srcVal = getNodeValue(s.source_id);
        contrSum += s.strength * srcVal;
        contrStrengthSum += s.strength;
      }
      const contradiction = contrStrengthSum > 0 ? (contrSum / contrStrengthSum) : 0;

      // Paper Eq. 5: subtractive contradiction — influence can go negative,
      // outer clamp01 on the full expression keeps final value in [0,1].
      const influence = support - CONTRADICTION_ETA * contradiction;
      const prior = local.get(id) ?? computeLocalConfidence(r);
      const updated = clamp01((1 - ALPHA) * prior + ALPHA * influence);

      const prev = x.get(id) ?? 0;
      if (Math.abs(updated - prev) > maxChange) maxChange = Math.abs(updated - prev);
      xNew.set(id, updated);
    }

    // Next iteration
    x.clear();
    for (const [k, v] of xNew) x.set(k, v);
    totalIterations = iter + 1;
    if (maxChange < CONVERGENCE_EPS) break;
  }

  // 7) Write back propagated_confidence for changed neighbors.
  const now = Date.now();
  const affected: ShockResult['affected_memories'] = [];
  let maxDrop = 0;
  let affectedCount = 0;

  for (const id of allNodeIds) {
    if (!updateable(id)) continue;
    const r = byId.get(id);
    if (!r) continue;

    const oldBaseline = r.propagated_confidence ?? (local.get(id) ?? 0);
    const newVal = x.get(id) ?? oldBaseline;

    const shouldWrite = r.propagated_confidence == null || Math.abs(newVal - r.propagated_confidence) > EPS;
    if (!shouldWrite) continue;

    await env.DB
      .prepare('UPDATE memories SET propagated_confidence = ?, updated_at = ? WHERE id = ?')
      .bind(newVal, now, id)
      .run();

    affectedCount++;

    const drop = oldBaseline - newVal;
    if (drop > maxDrop) maxDrop = drop;

    affected.push({
      id,
      old_confidence: oldBaseline,
      new_confidence: newVal,
    });
  }

  // Cap payload size.
  affected.sort((a, b) => (b.old_confidence - b.new_confidence) - (a.old_confidence - a.new_confidence));
  const affectedCapped = affected.slice(0, 25);

  const result: ShockResult = {
    affected_count: affectedCount,
    max_confidence_drop: Math.max(0, maxDrop),
    affected_memories: affectedCapped,
    is_core: damageLevel === 'core',
    iterations: totalIterations,
    spectral_radius: spectralRadius,
    backtrack_attempts: backtrackAttempts,
  };

  const duration_ms = Date.now() - shockStart;
  getLog().info('shock_complete', {
    memory_id: memoryId,
    damage_level: damageLevel,
    neighborhood_size: allNodeIds.length,
    affected_count: affectedCount,
    max_confidence_drop: Math.max(0, maxDrop),
    iterations: totalIterations,
    spectral_radius: spectralRadius,
    backtrack_attempts: backtrackAttempts,
    duration_ms,
  });

  if (env.ANALYTICS) {
    try {
      env.ANALYTICS.writeDataPoint({
        indexes: [memoryId],
        doubles: [affectedCount, Math.max(0, maxDrop), allNodeIds.length, totalIterations, spectralRadius, backtrackAttempts, duration_ms],
        blobs: [damageLevel, 'shock'],
      });
    } catch { /* swallow */ }
  }

  return result;
}
