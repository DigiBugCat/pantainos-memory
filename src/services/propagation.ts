/**
 * Full-Graph Confidence Propagation (Phase B-beta)
 *
 * Daily batch job: run damped fixed-point iteration on each connected
 * component of the memory graph. Catches long-range ripples, accumulated
 * drift, and cross-component effects that local shock propagation misses.
 *
 * Formula per iteration:
 *   x_{t+1} = σ((1-α)·b + α·influence)
 *
 * Where b = local confidence (prior blended with earned survival rate),
 * α = 0.6, σ = clamp(0, 1).
 *
 * influence is derived from incoming support and contradiction (Paper Eq. 5):
 * - support = strength-weighted mean of incoming support sources' x
 * - contradiction = strength-weighted mean of incoming contradiction sources' x
 * - influence = support - η * contradiction  (subtractive, can go negative)
 *
 * Runs after computeSystemStats() in the daily 3 AM UTC cron.
 */

import type { Env } from '../types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import { DEFAULT_MAX_TIMES_TESTED, getEvidenceWeight } from './confidence.js';

// ============================================
// Configuration
// ============================================

const ALPHA = 0.6;          // mixing parameter: how much graph structure matters vs prior
const CONTRADICTION_ETA = 0.8; // contradiction damping in influence term
const CONVERGENCE_EPS = 1e-4; // stop when max change < this
const MAX_ITERATIONS = 100;  // safety cap
const MIN_STRENGTH = 0.1;    // skip effectively-dead edges

// ============================================
// Types
// ============================================

interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  strength: number;
}

interface MemoryLiteRow {
  id: string;
  source: string | null;
  starting_confidence: number;
  confirmations: number;
  times_tested: number;
  propagated_confidence: number | null;
}

export interface PropagationResult {
  components_processed: number;
  total_memories: number;
  total_updated: number;
  max_delta: number;
  total_iterations: number;
  duration_ms: number;
}

// ============================================
// Helpers
// ============================================

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

// ============================================
// Union-Find for Connected Components
// ============================================

class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  getComponents(): Map<string, string[]> {
    const components = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(id);
    }
    return components;
  }
}

// ============================================
// Core Propagation
// ============================================

/**
 * Run damped fixed-point iteration on a single connected component.
 * Returns a map of memory_id → new propagated_confidence for memories that changed.
 */
function propagateComponent(
  nodeIds: string[],
  memoryById: Map<string, MemoryLiteRow>,
  supportEdges: EdgeRow[],
  contradictionIncoming: Map<string, Array<{ source_id: string; strength: number }>>,
): Map<string, number> {
  // Build incoming support adjacency: target → [{source, strength}]
  const incoming = new Map<string, Array<{ source_id: string; strength: number }>>();
  for (const e of supportEdges) {
    if (!incoming.has(e.target_id)) incoming.set(e.target_id, []);
    incoming.get(e.target_id)!.push({ source_id: e.source_id, strength: e.strength });
  }

  // Initialize x: warm start from propagated_confidence or local
  const x = new Map<string, number>();
  for (const id of nodeIds) {
    const r = memoryById.get(id);
    if (!r) continue;
    x.set(id, r.propagated_confidence ?? computeLocalConfidence(r));
  }

  // Read-only fallback for sources outside this component (common for contradiction edges).
  const getNodeValue = (id: string): number => {
    const v = x.get(id);
    if (v != null) return v;
    const r = memoryById.get(id);
    if (!r) return 0;
    return computeLocalConfidence(r);
  };

  // Which nodes can be updated (not observations)
  const updateableIds = nodeIds.filter(id => {
    const r = memoryById.get(id);
    return r && r.source == null;
  });

  // Iterate until convergence
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let maxChange = 0;

    for (const id of updateableIds) {
      const r = memoryById.get(id);
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
      const prior = computeLocalConfidence(r);
      const updated = clamp01((1 - ALPHA) * prior + ALPHA * influence);

      const prev = x.get(id) ?? 0;
      const change = Math.abs(updated - prev);
      if (change > maxChange) maxChange = change;
      x.set(id, updated);
    }

    if (maxChange < CONVERGENCE_EPS) break;
  }

  // Return only nodes that actually changed from their stored value
  const changes = new Map<string, number>();
  for (const id of updateableIds) {
    const r = memoryById.get(id);
    if (!r) continue;
    const newVal = x.get(id);
    if (newVal == null) continue;

    const oldVal = r.propagated_confidence ?? computeLocalConfidence(r);
    if (Math.abs(newVal - oldVal) > CONVERGENCE_EPS) {
      changes.set(id, newVal);
    }
  }

  return changes;
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Run full-graph confidence propagation.
 * Call from the daily cron after computeSystemStats().
 */
export async function runFullGraphPropagation(
  env: Env,
  requestId: string
): Promise<PropagationResult> {
  const log = createStandaloneLogger({
    component: 'PropagationJob',
    requestId,
  });

  const start = Date.now();
  log.info('propagation_starting');

  // 1. Fetch all support edges
  const edgesResult = await env.DB.prepare(`
    SELECT source_id, target_id, edge_type, strength
    FROM edges
    WHERE edge_type IN ('derived_from', 'confirmed_by')
      AND strength >= ?
  `).bind(MIN_STRENGTH).all<EdgeRow>();
  const allEdges = edgesResult.results ?? [];

  // 1b. Fetch contradiction edges (negative evidence)
  const contradictionResult = await env.DB.prepare(`
    SELECT source_id, target_id, edge_type, strength
    FROM edges
    WHERE edge_type IN ('violated_by')
      AND strength >= ?
  `).bind(MIN_STRENGTH).all<EdgeRow>();
  const allContradictions = contradictionResult.results ?? [];

  // 2. Fetch all active memory confidence data
  const memoriesResult = await env.DB.prepare(`
    SELECT id, source, starting_confidence, confirmations, times_tested, propagated_confidence
    FROM memories
    WHERE retracted = 0
  `).all<MemoryLiteRow>();
  const allMemories = memoriesResult.results ?? [];

  if (allMemories.length === 0) {
    log.info('propagation_skipped', { reason: 'no_memories' });
    return { components_processed: 0, total_memories: 0, total_updated: 0, max_delta: 0, total_iterations: 0, duration_ms: Date.now() - start };
  }

  const memoryById = new Map<string, MemoryLiteRow>();
  for (const m of allMemories) memoryById.set(m.id, m);

  // 3. Find connected components via union-find
  const uf = new UnionFind();
  // Register all memories that have edges
  const memoriesWithEdges = new Set<string>();
  for (const e of allEdges) {
    if (memoryById.has(e.source_id) && memoryById.has(e.target_id)) {
      uf.union(e.source_id, e.target_id);
      memoriesWithEdges.add(e.source_id);
      memoriesWithEdges.add(e.target_id);
    }
  }

  const components = uf.getComponents();

  log.info('components_found', {
    total_memories: allMemories.length,
    memories_with_edges: memoriesWithEdges.size,
    components: components.size,
  });

  // 4. Propagate each component
  let totalUpdated = 0;
  let maxDelta = 0;
  let totalIterations = 0;
  const now = Date.now();

  // Index edges by component for fast lookup
  const edgesByNode = new Map<string, EdgeRow[]>();
  for (const e of allEdges) {
    if (!memoryById.has(e.source_id) || !memoryById.has(e.target_id)) continue;
    if (!edgesByNode.has(e.source_id)) edgesByNode.set(e.source_id, []);
    if (!edgesByNode.has(e.target_id)) edgesByNode.set(e.target_id, []);
    edgesByNode.get(e.source_id)!.push(e);
    edgesByNode.get(e.target_id)!.push(e);
  }

  // Build incoming contradiction adjacency once (target → [{source,strength}]).
  // We do not use contradictions for component discovery to avoid "giant components"
  // caused by a single observation contradicting many beliefs.
  const contradictionIncoming = new Map<string, Array<{ source_id: string; strength: number }>>();
  for (const e of allContradictions) {
    if (!memoryById.has(e.target_id)) continue;
    if (!contradictionIncoming.has(e.target_id)) contradictionIncoming.set(e.target_id, []);
    contradictionIncoming.get(e.target_id)!.push({ source_id: e.source_id, strength: e.strength });
  }

  for (const [_root, nodeIds] of components) {
    // Skip trivial components (single node)
    if (nodeIds.length <= 1) continue;

    // Gather edges within this component
    const nodeSet = new Set(nodeIds);
    const componentEdges: EdgeRow[] = [];
    const seen = new Set<string>();
    for (const nid of nodeIds) {
      for (const e of edgesByNode.get(nid) ?? []) {
        const key = `${e.source_id}-${e.target_id}-${e.edge_type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (nodeSet.has(e.source_id) && nodeSet.has(e.target_id)) {
          componentEdges.push(e);
        }
      }
    }

    const changes = propagateComponent(nodeIds, memoryById, componentEdges, contradictionIncoming);

    // Write back changes
    for (const [id, newVal] of changes) {
      const oldVal = memoryById.get(id)?.propagated_confidence;
      const delta = oldVal != null ? Math.abs(newVal - oldVal) : Math.abs(newVal - computeLocalConfidence(memoryById.get(id)!));
      if (delta > maxDelta) maxDelta = delta;

      await env.DB
        .prepare('UPDATE memories SET propagated_confidence = ?, updated_at = ? WHERE id = ?')
        .bind(newVal, now, id)
        .run();
      totalUpdated++;
    }

    totalIterations++;
  }

  const duration = Date.now() - start;

  log.info('propagation_complete', {
    components_processed: totalIterations,
    total_memories: allMemories.length,
    total_updated: totalUpdated,
    max_delta: Math.round(maxDelta * 1000) / 1000,
    duration_ms: duration,
  });

  return {
    components_processed: totalIterations,
    total_memories: allMemories.length,
    total_updated: totalUpdated,
    max_delta: maxDelta,
    total_iterations: totalIterations,
    duration_ms: duration,
  };
}
