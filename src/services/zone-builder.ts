/**
 * Zone Builder Service
 *
 * Extracted from the inline zones MCP tool (mcp.ts) for reuse by:
 * - Post-violation health checks (exposure-checker.ts)
 * - Resolver dispatch enrichment (resolver.ts)
 * - The MCP zones tool itself
 *
 * Implements zone extraction per Nikooroo & Engel, Section IV:
 * BFS growth with safety gating, contradiction gating,
 * boundary completion (cut-/loss+), and Harary 2-coloring.
 */

import {
  type SafetyRow,
  checkSignedBalance,
  scoreZone,
  isOverwhelminglyViolated,
  addBoundaryReason,
  parseViolationCount,
} from '../lib/zones.js';
import { queryInChunks, queryContradictionGate } from '../lib/sql-utils.js';
import { createLazyLogger } from '../lib/lazy-logger.js';

const getLog = createLazyLogger('ZoneBuilder');

// ============================================
// Types
// ============================================

export interface ZoneHealthReport {
  seed_id: string;
  zone_size: number;
  quality_score: number;       // scoreZone() — S(Z) from paper Section V-A
  quality_pct: number;         // quality_score * 100, rounded
  balanced: boolean;           // Harary 2-coloring (Proposition 1)
  conflict_edge?: [string, string];
  boundary_contradictions: number;  // cut- count
  external_support_leaks: number;   // loss+ count
  unsafe_reasons: string[];
  member_ids: string[];
  boundary_ids: string[];      // memories excluded at boundary
}

export interface ZoneHealthOptions {
  maxDepth?: number;
  maxSize?: number;
  minEdgeStrength?: number;
}

// Internal row types
type TraversalEdgeRow = {
  source_id: string;
  target_id: string;
  edge_type: string;
  strength: number;
};
type ViolatedByEdgeRow = {
  source_id: string;
  target_id: string;
};
type MinimalMemoryRow = {
  id: string;
  content: string;
  state: string;
  starting_confidence: number;
  confirmations: number;
  times_tested: number;
  propagated_confidence: number | null;
};

/**
 * Build a zone health report for a given seed memory.
 *
 * This performs the core zone extraction algorithm:
 * 1. Seed safety evaluation
 * 2. BFS growth with safety gating + contradiction gating
 * 3. Boundary completion (cut- and loss+ edges)
 * 4. Harary 2-coloring for signed-cycle balance
 * 5. Zone quality scoring
 *
 * Does NOT include semantic expansion (requires AI/embeddings).
 * Does NOT fetch full memory rows or format output (caller's responsibility).
 */
export async function buildZoneHealth(
  db: D1Database,
  seedId: string,
  options?: ZoneHealthOptions,
): Promise<ZoneHealthReport> {
  const zoneStart = Date.now();
  const maxDepth = options?.maxDepth ?? 2;
  const maxSize = options?.maxSize ?? 20;
  const minEdgeStrength = options?.minEdgeStrength ?? 0.3;

  // --------------------------
  // Phase 1: Seed safety eval
  // --------------------------
  const seedSafety = await db.prepare(
    `SELECT id, state, outcome, retracted, violations, times_tested, confirmations
     FROM memories WHERE id = ? AND retracted = 0`
  ).bind(seedId).first<SafetyRow>();

  if (!seedSafety) {
    return {
      seed_id: seedId,
      zone_size: 0,
      quality_score: 0,
      quality_pct: 0,
      balanced: false,
      boundary_contradictions: 0,
      external_support_leaks: 0,
      unsafe_reasons: ['seed not found or retracted'],
      member_ids: [],
      boundary_ids: [],
    };
  }

  const unsafeReasons: string[] = [];
  if (seedSafety.state === 'violated') unsafeReasons.push('seed state=violated');
  if (seedSafety.state === 'resolved' && seedSafety.outcome === 'incorrect') {
    unsafeReasons.push('seed resolved incorrect');
  }
  if (parseViolationCount(seedSafety.violations) > 0) {
    unsafeReasons.push('seed has recorded violations');
  }

  // --------------------------
  // Phase 2: BFS growth (graph traversal)
  // --------------------------
  const zoneIds: string[] = [seedId];
  const zoneSet = new Set<string>(zoneIds);
  const seen = new Set<string>(zoneIds);
  const boundaryReasons = new Map<string, Set<string>>();

  let frontier: string[] = [seedId];
  for (let depth = 0; depth < maxDepth; depth++) {
    if (zoneIds.length >= maxSize) break;
    if (frontier.length === 0) break;

    const frontierSet = new Set(frontier);
    const edgeResults = await queryInChunks<TraversalEdgeRow>(
      db,
      (ph) => `SELECT source_id, target_id, edge_type, strength
       FROM edges
       WHERE edge_type IN ('derived_from', 'confirmed_by')
         AND strength >= ?
         AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
      frontier,
      [minEdgeStrength],
      [],
      2,
    );

    const candidates: string[] = [];
    const candidateSet = new Set<string>();
    for (const e of edgeResults) {
      if (frontierSet.has(e.source_id) && !seen.has(e.target_id) && !candidateSet.has(e.target_id)) {
        candidates.push(e.target_id);
        candidateSet.add(e.target_id);
      }
      if (frontierSet.has(e.target_id) && !seen.has(e.source_id) && !candidateSet.has(e.source_id)) {
        candidates.push(e.source_id);
        candidateSet.add(e.source_id);
      }
    }

    if (candidates.length === 0) {
      frontier = [];
      continue;
    }

    // Mark all as seen to avoid re-processing across depths
    for (const id of candidates) seen.add(id);

    const safetyResults = await queryInChunks<SafetyRow>(
      db,
      (ph) => `SELECT id, state, outcome, retracted, violations, times_tested, confirmations FROM memories WHERE id IN (${ph})`,
      candidates,
      [],
      [],
      1,
    );

    const safetyById = new Map<string, SafetyRow>();
    for (const r of safetyResults) safetyById.set(r.id, r);

    const eligible: string[] = [];
    for (const id of candidates) {
      const r = safetyById.get(id);
      if (!r) continue;
      if (r.retracted) continue;

      if (r.state === 'violated') {
        addBoundaryReason(boundaryReasons, id, 'excluded: state=violated');
        continue;
      }
      if (r.state === 'resolved' && r.outcome === 'incorrect') {
        addBoundaryReason(boundaryReasons, id, 'excluded: resolved incorrect');
        continue;
      }
      if (isOverwhelminglyViolated(r)) {
        const surv = r.times_tested > 0 ? Math.round(r.confirmations / r.times_tested * 100) : 0;
        addBoundaryReason(boundaryReasons, id, `excluded: survival rate ${surv}% (${r.confirmations}/${r.times_tested})`);
        continue;
      }
      eligible.push(id);
    }

    // Contradiction gate against current zone
    const newlyAdded: string[] = [];
    if (eligible.length > 0 && zoneIds.length < maxSize) {
      const candSet2 = new Set<string>(eligible);

      const contradictionResults = await queryContradictionGate<ViolatedByEdgeRow>(
        db,
        eligible,
        zoneIds,
      );

      const conflicts = new Map<string, Set<string>>();
      for (const e of contradictionResults) {
        if (candSet2.has(e.source_id) && zoneSet.has(e.target_id)) {
          (conflicts.get(e.source_id) ?? conflicts.set(e.source_id, new Set()).get(e.source_id)!).add(e.target_id);
        } else if (candSet2.has(e.target_id) && zoneSet.has(e.source_id)) {
          (conflicts.get(e.target_id) ?? conflicts.set(e.target_id, new Set()).get(e.target_id)!).add(e.source_id);
        }
      }

      for (const id of eligible) {
        if (zoneIds.length >= maxSize) break;
        const conflictWith = conflicts.get(id);
        if (conflictWith && conflictWith.size > 0) {
          for (const zid of conflictWith) {
            addBoundaryReason(boundaryReasons, id, `contradicts [${zid}] (violated_by)`);
          }
          continue;
        }

        zoneIds.push(id);
        zoneSet.add(id);
        newlyAdded.push(id);
      }
    }

    frontier = newlyAdded;
  }

  // --------------------------
  // Boundary completion: cut- (violated_by edges crossing boundary)
  // --------------------------
  const violatedEdgeResults = await queryInChunks<ViolatedByEdgeRow>(
    db,
    (ph) => `SELECT source_id, target_id
     FROM edges
     WHERE edge_type = 'violated_by'
       AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
    zoneIds,
    [],
    [],
    2,
  );

  const internalContradictions: Array<{ source_id: string; target_id: string }> = [];
  let cutMinusCount = 0;
  for (const e of violatedEdgeResults) {
    const sourceIn = zoneSet.has(e.source_id);
    const targetIn = zoneSet.has(e.target_id);
    if (sourceIn && targetIn) {
      internalContradictions.push({ source_id: e.source_id, target_id: e.target_id });
      continue;
    }
    if (sourceIn !== targetIn) {
      cutMinusCount++;
      const other = sourceIn ? e.target_id : e.source_id;
      const inZone = sourceIn ? e.source_id : e.target_id;
      if (!zoneSet.has(other)) {
        addBoundaryReason(boundaryReasons, other, `contradicts [${inZone}] (violated_by)`);
      }
    }
  }

  // --------------------------
  // External support dependency: loss+ (support edges crossing boundary)
  // --------------------------
  const traversalEdgeResults = await queryInChunks<TraversalEdgeRow>(
    db,
    (ph) => `SELECT source_id, target_id, edge_type, strength
     FROM edges
     WHERE edge_type IN ('derived_from', 'confirmed_by')
       AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
    zoneIds,
    [],
    [],
    2,
  );

  const internalEdges: Array<{ source_id: string; target_id: string; edge_type: string; strength: number }> = [];
  const internalKey = new Set<string>();
  let lossPlusCount = 0;
  for (const e of traversalEdgeResults) {
    const sourceIn = zoneSet.has(e.source_id);
    const targetIn = zoneSet.has(e.target_id);
    if (sourceIn && targetIn) {
      const key = `${e.source_id}|${e.target_id}|${e.edge_type}`;
      if (!internalKey.has(key)) {
        internalKey.add(key);
        internalEdges.push(e);
      }
    } else if (sourceIn !== targetIn) {
      lossPlusCount++;
    }
  }

  // --------------------------
  // Signed cycle detection (Harary 2-coloring, Proposition 1)
  // --------------------------
  let balanced = true;
  let conflictEdge: [string, string] | undefined;

  if (internalContradictions.length > 0) {
    const balance = checkSignedBalance(internalEdges, internalContradictions);
    balanced = balance.balanced;
    if (!balance.balanced) {
      conflictEdge = balance.conflictEdge;
      unsafeReasons.push(balance.conflictDescription ?? 'signed cycle detected (Harary 2-coloring failed)');
    }
  }

  // --------------------------
  // Zone quality scoring (Section V-A)
  // --------------------------
  // Fetch minimal confidence data for zone members to compute score
  const memberRows = await queryInChunks<MinimalMemoryRow>(
    db,
    (ph) => `SELECT id, content, state, starting_confidence, confirmations, times_tested, propagated_confidence
     FROM memories WHERE id IN (${ph}) AND retracted = 0`,
    zoneIds,
    [],
    [],
    1,
  );

  // Build Memory-compatible objects for scoreZone()
  const zoneMembers = memberRows.map(r => ({
    id: r.id,
    content: r.content,
    state: r.state,
    starting_confidence: r.starting_confidence,
    confirmations: r.confirmations,
    times_tested: r.times_tested,
    propagated_confidence: r.propagated_confidence,
  }));

  const qualityScore = scoreZone(
    zoneMembers as Parameters<typeof scoreZone>[0],
    cutMinusCount,
    lossPlusCount,
  );

  const boundaryIds = Array.from(boundaryReasons.keys()).filter(id => !zoneSet.has(id));

  getLog().info('zone_built', {
    seed_id: seedId,
    zone_size: zoneIds.length,
    quality_pct: Math.round(qualityScore * 100),
    balanced,
    boundary_contradictions: cutMinusCount,
    external_support_leaks: lossPlusCount,
    duration_ms: Date.now() - zoneStart,
  });

  return {
    seed_id: seedId,
    zone_size: zoneIds.length,
    quality_score: qualityScore,
    quality_pct: Math.round(qualityScore * 100),
    balanced,
    conflict_edge: conflictEdge,
    boundary_contradictions: cutMinusCount,
    external_support_leaks: lossPlusCount,
    unsafe_reasons: unsafeReasons,
    member_ids: zoneIds,
    boundary_ids: boundaryIds,
  };
}
