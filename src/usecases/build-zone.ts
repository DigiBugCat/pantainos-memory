/**
 * Build Reasoning Zone — Usecase
 *
 * Constructs a locally consistent reasoning zone: a mutually non-contradictory
 * cluster of memories around a seed, plus boundary contradictions and
 * external support dependency.
 *
 * Algorithm phases:
 * 1. Seed selection (by ID or semantic query)
 * 1.5. Seed safety evaluation
 * 2. BFS growth with safety gates + contradiction gates
 * 3. Semantic expansion (optional, when zone is small)
 * 4. Boundary completion (cut- and loss+ flow analysis)
 * 4.5. Signed cycle detection (Harary 2-coloring)
 * 5. Output assembly
 *
 * Extracted from mcp.ts for reuse by both MCP and REST routes.
 */

import type { Env, Memory, MemoryRow } from '../types/index.js';
import type { Config } from '../lib/config.js';
import { generateEmbedding, searchSimilar } from '../lib/embeddings.js';
import { queryInChunks, queryContradictionGate } from '../lib/sql-utils.js';
import { rowToMemory } from '../lib/transforms.js';
import {
  parseViolationCount,
  isOverwhelminglyViolated,
  addBoundaryReason,
  checkSignedBalance,
  type SafetyRow,
  type ZoneParams,
} from '../lib/zones.js';

// ============================================
// Types
// ============================================

export interface BuildZoneOptions {
  query?: string;
  memoryId?: string;
  maxDepth?: number;
  maxSize?: number;
  includeSemantic?: boolean;
  minEdgeStrength?: number;
}

export interface BuildZoneResult {
  success: true;
  seedId: string;
  zoneParams: ZoneParams;
  /** All zone + boundary memory IDs (for access recording) */
  allMemoryIds: string[];
}

export interface BuildZoneError {
  success: false;
  error: string;
}

type TraversalEdgeRow = { source_id: string; target_id: string; edge_type: string; strength: number };
type ViolatedByEdgeRow = { source_id: string; target_id: string };

// ============================================
// Main Function
// ============================================

export async function buildZone(
  env: Env,
  config: Config,
  requestId: string,
  options: BuildZoneOptions,
): Promise<BuildZoneResult | BuildZoneError> {
  const {
    query,
    memoryId: rawMemoryId,
    maxDepth: rawMaxDepth,
    maxSize: rawMaxSize,
    includeSemantic: rawIncludeSemantic,
    minEdgeStrength: rawMinEdgeStrength,
  } = options;

  const maxDepth = rawMaxDepth ?? 3;
  const maxSize = rawMaxSize ?? 30;
  const includeSemantic = rawIncludeSemantic ?? true;
  const minEdgeStrength = rawMinEdgeStrength ?? 0.3;

  if (!query && !rawMemoryId) {
    return { success: false, error: 'At least one of "query" or "memory_id" is required' };
  }
  if (maxDepth < 1 || maxDepth > 5) {
    return { success: false, error: 'max_depth must be between 1 and 5' };
  }
  if (maxSize < 5 || maxSize > 100) {
    return { success: false, error: 'max_size must be between 5 and 100' };
  }

  // --------------------------
  // Phase 1: Seed selection
  // --------------------------
  let seedId: string | null = null;
  let seedRow: MemoryRow | null = null;

  if (rawMemoryId) {
    seedId = rawMemoryId;
    seedRow = await env.DB.prepare(
      `SELECT * FROM memories WHERE id = ? AND retracted = 0`
    ).bind(seedId).first<MemoryRow>();
    if (!seedRow) return { success: false, error: `Memory not found: ${seedId}` };
  } else if (query) {
    const queryEmbedding = await generateEmbedding(env.AI, query, config, requestId);
    const matches = await searchSimilar(env, queryEmbedding, 10, config.search.minSimilarity, requestId);

    for (const match of matches) {
      const row = await env.DB.prepare(
        `SELECT * FROM memories WHERE id = ? AND retracted = 0`
      ).bind(match.id).first<MemoryRow>();
      if (row) {
        seedId = match.id;
        seedRow = row;
        break;
      }
    }

    if (!seedId || !seedRow) {
      return { success: false, error: 'No seed found for query (no non-retracted matches)' };
    }
  }

  if (!seedId || !seedRow) {
    return { success: false, error: 'Failed to resolve seed' };
  }

  // --------------------------
  // Phase 1.5: Seed safety eval
  // --------------------------
  const unsafeReasons: string[] = [];
  if (seedRow.state === 'violated') unsafeReasons.push('seed state=violated');
  const seedOutcome = (seedRow as unknown as Record<string, unknown>).outcome as string | null;
  if (seedRow.state === 'resolved' && seedOutcome === 'incorrect') unsafeReasons.push('seed resolved incorrect');
  if (parseViolationCount(seedRow.violations) > 0) unsafeReasons.push('seed has recorded violations');

  // --------------------------
  // Phase 2: BFS growth (graph)
  // --------------------------
  const zoneIds: string[] = [seedId];
  const zoneSet = new Set<string>(zoneIds);
  const seen = new Set<string>(zoneIds);
  const semanticMemberIds = new Set<string>();
  const boundaryReasons = new Map<string, Set<string>>();

  let frontier: string[] = [seedId];
  for (let depth = 0; depth < maxDepth; depth++) {
    if (zoneIds.length >= maxSize) break;
    if (frontier.length === 0) break;

    const frontierSet = new Set(frontier);
    const edgeResults = await queryInChunks<TraversalEdgeRow>(
      env.DB,
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

    for (const id of candidates) seen.add(id);

    const { eligible } = await applySafetyAndContradictionGates(
      env.DB, candidates, zoneIds, zoneSet, boundaryReasons,
    );

    const newlyAdded: string[] = [];
    for (const id of eligible) {
      if (zoneIds.length >= maxSize) break;
      zoneIds.push(id);
      zoneSet.add(id);
      newlyAdded.push(id);
    }

    frontier = newlyAdded;
  }

  // --------------------------
  // Phase 3: Semantic expansion (optional)
  // --------------------------
  if (includeSemantic && query && zoneIds.length < 5 && zoneIds.length < maxSize) {
    const queryEmbedding = await generateEmbedding(env.AI, query, config, requestId);
    const matches = await searchSimilar(env, queryEmbedding, 25, config.search.minSimilarity, requestId);

    const candidates: string[] = [];
    for (const m of matches) {
      if (zoneSet.has(m.id) || seen.has(m.id)) continue;
      candidates.push(m.id);
    }

    if (candidates.length > 0) {
      for (const id of candidates) seen.add(id);

      const { eligible } = await applySafetyAndContradictionGates(
        env.DB, candidates, zoneIds, zoneSet, boundaryReasons,
      );

      for (const id of eligible) {
        if (zoneIds.length >= maxSize) break;
        zoneIds.push(id);
        zoneSet.add(id);
        semanticMemberIds.add(id);
      }
    }
  }

  // --------------------------
  // Phase 4: Boundary completion (cut-)
  // --------------------------
  const violatedEdgeResults = await queryInChunks<ViolatedByEdgeRow>(
    env.DB,
    (ph) => `SELECT source_id, target_id
     FROM edges
     WHERE edge_type = 'violated_by'
       AND (source_id IN (${ph}) OR target_id IN (${ph}))`,
    zoneIds,
    [],
    [],
    2,
  );

  const cutMinusEdges: Array<{ source_id: string; target_id: string; edge_type: 'violated_by' }> = [];
  const internalContradictions: Array<{ source_id: string; target_id: string }> = [];
  for (const e of violatedEdgeResults) {
    const sourceIn = zoneSet.has(e.source_id);
    const targetIn = zoneSet.has(e.target_id);
    if (sourceIn && targetIn) {
      internalContradictions.push({ source_id: e.source_id, target_id: e.target_id });
      continue;
    }
    if (sourceIn !== targetIn) {
      cutMinusEdges.push({ source_id: e.source_id, target_id: e.target_id, edge_type: 'violated_by' });
    }

    const other = sourceIn ? e.target_id : e.source_id;
    const inZone = sourceIn ? e.source_id : e.target_id;
    if (!zoneSet.has(other)) {
      addBoundaryReason(boundaryReasons, other, `contradicts [${inZone}] (violated_by)`);
    }
  }

  // --------------------------
  // External support dependency (loss+)
  // --------------------------
  const traversalEdgeResults = await queryInChunks<TraversalEdgeRow>(
    env.DB,
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
  const lossPlusEdges: Array<{ source_id: string; target_id: string; edge_type: 'derived_from' | 'confirmed_by' }> = [];
  const internalKey = new Set<string>();
  for (const e of traversalEdgeResults) {
    const sourceIn = zoneSet.has(e.source_id);
    const targetIn = zoneSet.has(e.target_id);
    if (sourceIn && targetIn) {
      const key = `${e.source_id}|${e.target_id}|${e.edge_type}`;
      if (!internalKey.has(key)) {
        internalKey.add(key);
        internalEdges.push({ source_id: e.source_id, target_id: e.target_id, edge_type: e.edge_type, strength: e.strength });
      }
    } else if (sourceIn !== targetIn) {
      lossPlusEdges.push({
        source_id: e.source_id,
        target_id: e.target_id,
        edge_type: e.edge_type as 'derived_from' | 'confirmed_by',
      });
    }
  }

  // --------------------------
  // Phase 4.5: Signed cycle detection (Harary 2-coloring)
  // --------------------------
  if (internalContradictions.length > 0) {
    const balance = checkSignedBalance(internalEdges, internalContradictions);
    if (!balance.balanced) {
      unsafeReasons.push(balance.conflictDescription ?? 'signed cycle detected (Harary 2-coloring failed)');
    }
    for (const e of internalContradictions) {
      internalEdges.push({ source_id: e.source_id, target_id: e.target_id, edge_type: 'violated_by', strength: 1.0 });
    }
  }

  // --------------------------
  // Phase 5: Fetch full rows for output
  // --------------------------
  const boundaryIds = Array.from(boundaryReasons.keys()).filter(id => !zoneSet.has(id));
  const idsToFetch = Array.from(new Set([...zoneIds, ...boundaryIds]));

  const memById = new Map<string, MemoryRow>();
  if (idsToFetch.length > 0) {
    const fetchedRows = await queryInChunks<MemoryRow>(
      env.DB,
      (ph) => `SELECT * FROM memories WHERE id IN (${ph}) AND retracted = 0`,
      idsToFetch,
      [],
      [],
      1,
    );
    for (const r of fetchedRows) memById.set(r.id, r);
  }

  const zoneMembers: Memory[] = [];
  for (const id of zoneIds) {
    const row = memById.get(id);
    if (!row) continue;
    zoneMembers.push(rowToMemory(row));
  }

  const boundary: Array<{ memory: Memory; reasons: string[] }> = [];
  for (const [id, reasons] of boundaryReasons.entries()) {
    if (zoneSet.has(id)) continue;
    const row = memById.get(id);
    if (!row) continue;
    boundary.push({ memory: rowToMemory(row), reasons: Array.from(reasons) });
  }

  const zoneParams: ZoneParams = {
    seedId,
    query,
    zoneMembers,
    semanticMemberIds,
    internalEdges,
    boundary,
    cutMinusEdges,
    lossPlusEdges,
    unsafeReasons,
  };

  return {
    success: true,
    seedId,
    zoneParams,
    allMemoryIds: idsToFetch,
  };
}

// ============================================
// Internal Helpers
// ============================================

/**
 * Apply safety gates + contradiction gates to a batch of candidate IDs.
 * Returns the list of eligible IDs (those that passed both gates) and
 * any new boundary entries.
 */
async function applySafetyAndContradictionGates(
  db: D1Database,
  candidates: string[],
  zoneIds: string[],
  zoneSet: Set<string>,
  boundaryReasons: Map<string, Set<string>>,
): Promise<{ eligible: string[] }> {
  // Safety gate
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

  const safetyPassed: string[] = [];
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
    safetyPassed.push(id);
  }

  // Contradiction gate against current zone
  const eligible: string[] = [];

  if (safetyPassed.length > 0) {
    const candSet = new Set<string>(safetyPassed);

    const contradictionResults = await queryContradictionGate<ViolatedByEdgeRow>(
      db,
      safetyPassed,
      zoneIds,
    );

    const conflicts = new Map<string, Set<string>>();
    for (const e of contradictionResults) {
      if (candSet.has(e.source_id) && zoneSet.has(e.target_id)) {
        (conflicts.get(e.source_id) ?? conflicts.set(e.source_id, new Set()).get(e.source_id)!).add(e.target_id);
      } else if (candSet.has(e.target_id) && zoneSet.has(e.source_id)) {
        (conflicts.get(e.target_id) ?? conflicts.set(e.target_id, new Set()).get(e.target_id)!).add(e.source_id);
      }
    }

    for (const id of safetyPassed) {
      const conflictWith = conflicts.get(id);
      if (conflictWith && conflictWith.size > 0) {
        for (const zid of conflictWith) {
          addBoundaryReason(boundaryReasons, id, `contradicts [${zid}] (violated_by)`);
        }
        continue;
      }
      eligible.push(id);
    }
  }

  return { eligible };
}
