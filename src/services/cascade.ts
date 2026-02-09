/**
 * Cascade Service - Resolution Propagation
 *
 * When a prediction/inference resolves, this service:
 * 1. Traverses the graph to find related memories
 * 2. Determines cascade effects
 * 3. Applies automatic confidence propagation (Phase B):
 *    - incorrect → applyShock() on connected memories
 *    - correct → edge recovery on connected support edges
 *    - void → no propagation
 *
 * Philosophy (post Phase B): Propagate automatically, don't queue for review.
 * Shock propagation + daily batch convergence handle downstream effects.
 * Only overdue predictions still go through the resolver (task scheduler).
 */

import type { Env } from '../types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import { applyShock } from './shock-propagation.js';

// Lazy logger - avoids crypto in global scope
let _log: ReturnType<typeof createStandaloneLogger> | null = null;
function getLog() {
  if (!_log) {
    _log = createStandaloneLogger({
      component: 'CascadeService',
      requestId: 'cascade-init',
    });
  }
  return _log;
}

// ============================================
// Types
// ============================================

export type CascadeReason =
  | 'derived_prediction_resolved'  // A prediction derived from this resolved
  | 'shared_thought_violated'   // A shared thought was violated
  | 'supporting_evidence_changed'  // Evidence this depends on changed
  | 'related_prediction_resolved'  // A related prediction resolved
  // Upward propagation reasons
  | 'derived_evidence_validated'   // A prediction/inference derived from this was confirmed
  | 'derived_evidence_invalidated'; // A prediction/inference derived from this was violated

export interface CascadeEffect {
  target_id: string;
  target_type: string;
  reason: CascadeReason;
  source_id: string;
  source_outcome: 'correct' | 'incorrect' | 'void';
  edge_type: string;
  suggested_action: 'review';
}

export interface CascadeResult {
  source_id: string;
  outcome: 'correct' | 'incorrect' | 'void';
  effects: CascadeEffect[];
  events_queued: number;
}

// ============================================
// Graph Traversal
// ============================================

interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
}

interface MemoryRow {
  id: string;
  source: string | null;
  derived_from: string | null;
  resolves_by: number | null;
  content: string;
  state: string | null;
}

/**
 * Find all memories directly connected to a source memory.
 * Returns both incoming and outgoing edges.
 */
async function findConnectedMemories(
  db: D1Database,
  memoryId: string
): Promise<{
  memory: MemoryRow;
  edge: EdgeRow;
  direction: 'incoming' | 'outgoing';
}[]> {
  // Find outgoing edges (this memory → other)
  const outgoing = await db.prepare(`
    SELECT e.id, e.source_id, e.target_id, e.edge_type,
           m.id as memory_id, m.source, m.derived_from, m.resolves_by, m.content, m.state
    FROM edges e
    JOIN memories m ON m.id = e.target_id
    WHERE e.source_id = ? AND m.retracted = 0
  `).bind(memoryId).all<EdgeRow & { memory_id: string; source: string | null; derived_from: string | null; resolves_by: number | null; content: string; state: string | null }>();

  // Find incoming edges (other → this memory)
  const incoming = await db.prepare(`
    SELECT e.id, e.source_id, e.target_id, e.edge_type,
           m.id as memory_id, m.source, m.derived_from, m.resolves_by, m.content, m.state
    FROM edges e
    JOIN memories m ON m.id = e.source_id
    WHERE e.target_id = ? AND m.retracted = 0
  `).bind(memoryId).all<EdgeRow & { memory_id: string; source: string | null; derived_from: string | null; resolves_by: number | null; content: string; state: string | null }>();

  const results: { memory: MemoryRow; edge: EdgeRow; direction: 'incoming' | 'outgoing' }[] = [];

  for (const row of outgoing.results || []) {
    results.push({
      memory: {
        id: row.memory_id,
        source: row.source,
        derived_from: row.derived_from,
        resolves_by: row.resolves_by,
        content: row.content,
        state: row.state,
      },
      edge: {
        id: row.id,
        source_id: row.source_id,
        target_id: row.target_id,
        edge_type: row.edge_type,
      },
      direction: 'outgoing',
    });
  }

  for (const row of incoming.results || []) {
    results.push({
      memory: {
        id: row.memory_id,
        source: row.source,
        derived_from: row.derived_from,
        resolves_by: row.resolves_by,
        content: row.content,
        state: row.state,
      },
      edge: {
        id: row.id,
        source_id: row.source_id,
        target_id: row.target_id,
        edge_type: row.edge_type,
      },
      direction: 'incoming',
    });
  }

  return results;
}

// ============================================
// Cascade Logic
// ============================================

/**
 * Determine cascade effects when a prediction/inference resolves.
 *
 * All effects use suggested_action = 'review'. Confidence is fully derived
 * from the exposure checker (confirmations/times_tested), so there's nothing
 * to boost or damage manually.
 *
 * Downstream propagation (things derived FROM resolved memory):
 * - derived_prediction_resolved → review
 *
 * Upstream propagation (things resolved memory was derived FROM):
 * - derived_evidence_validated (correct outcome)
 * - derived_evidence_invalidated (incorrect outcome)
 * - supporting_evidence_changed (void outcome)
 *
 * Observations are never affected (facts don't change).
 *
 * @internal Exported for testing purposes
 */
export function determineCascadeEffects(
  sourceId: string,
  sourceOutcome: 'correct' | 'incorrect' | 'void',
  connections: { memory: MemoryRow; edge: EdgeRow; direction: 'incoming' | 'outgoing' }[]
): CascadeEffect[] {
  const effects: CascadeEffect[] = [];

  for (const { memory, edge, direction } of connections) {
    // Skip observations - facts don't cascade
    if (memory.source != null) continue;

    // Skip already-resolved memories
    if (memory.state === 'resolved') continue;

    // Determine effect based on relationship
    let reason: CascadeReason;
    const suggestedAction: 'review' = 'review';

    if (direction === 'incoming' && edge.edge_type === 'derived_from') {
      // DOWNSTREAM: This memory derived_from the resolved prediction
      reason = 'derived_prediction_resolved';
    } else if (direction === 'outgoing' && edge.edge_type === 'derived_from') {
      // UPSTREAM: The resolved prediction derived_from this memory
      if (sourceOutcome === 'correct') {
        reason = 'derived_evidence_validated';
      } else if (sourceOutcome === 'incorrect') {
        reason = 'derived_evidence_invalidated';
      } else {
        reason = 'supporting_evidence_changed';
      }
    } else if (edge.edge_type === 'confirmed_by' || edge.edge_type === 'violated_by') {
      // Already processed through exposure checking
      continue;
    } else {
      // Generic relationship
      reason = 'related_prediction_resolved';
    }

    // Derive display type from field presence
    const targetType = memory.source != null
      ? 'observation'
      : memory.resolves_by != null
        ? 'prediction'
        : 'thought';

    effects.push({
      target_id: memory.id,
      target_type: targetType,
      reason,
      source_id: sourceId,
      source_outcome: sourceOutcome,
      edge_type: edge.edge_type,
      suggested_action: suggestedAction,
    });
  }

  return effects;
}

// ============================================
// Automatic Propagation (Phase B — replaces event queueing)
// ============================================

/**
 * Apply automatic confidence propagation based on resolution outcome.
 *
 * - incorrect: Run shock propagation from the resolved memory (core-level shock)
 * - correct: Recover outgoing support edges (10% boost, capped at 1.0)
 * - void: No propagation — outcome is ambiguous
 *
 * This replaces the old queueCascadeEvents() which queued cascade_review,
 * evidence_validated, and evidence_invalidated events for the resolver agent.
 * Those events are no longer needed — propagation handles them automatically.
 */
async function applyAutomaticPropagation(
  env: Env,
  memoryId: string,
  outcome: 'correct' | 'incorrect' | 'void',
): Promise<number> {
  if (outcome === 'void') return 0;

  if (outcome === 'incorrect') {
    // Shock propagation: treat resolution as incorrect = core-level violation
    try {
      const shock = await applyShock(env, memoryId, 'core');
      getLog().info('cascade_shock_applied', {
        memory_id: memoryId,
        affected: shock.affected_count,
        max_drop: Math.round(shock.max_confidence_drop * 100),
      });
      return shock.affected_count;
    } catch (error) {
      getLog().warn('cascade_shock_failed', {
        memory_id: memoryId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  // correct: recover outgoing support edges
  try {
    await env.DB
      .prepare(
        `UPDATE edges SET strength = MIN(1.0, strength * 1.1)
         WHERE source_id = ? AND edge_type IN ('derived_from', 'confirmed_by')`
      )
      .bind(memoryId)
      .run();
    getLog().info('cascade_edge_recovery', { memory_id: memoryId });
    return 1; // at least one effect applied
  } catch (error) {
    getLog().warn('cascade_recovery_failed', {
      memory_id: memoryId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

// ============================================
// Main Entry Point
// ============================================

/**
 * Propagate resolution effects to related memories.
 *
 * Call this when a prediction/inference is resolved (correct/incorrect/void).
 * It will:
 * 1. Find all connected memories
 * 2. Determine cascade effects (for reporting)
 * 3. Apply automatic confidence propagation (shock or edge recovery)
 *
 * @param env - Worker environment
 * @param memoryId - The resolved memory ID
 * @param outcome - How the memory was resolved
 * @param sessionId - Optional session ID (kept for API compat, unused)
 */
export async function propagateResolution(
  env: Env,
  memoryId: string,
  outcome: 'correct' | 'incorrect' | 'void',
  _sessionId?: string
): Promise<CascadeResult> {
  getLog().info('propagating', { memory_id: memoryId, outcome });

  // Find connected memories (still useful for effect reporting)
  const connections = await findConnectedMemories(env.DB, memoryId);
  getLog().debug('connections_found', { memory_id: memoryId, count: connections.length });

  // Determine effects (for reporting — not for event queueing)
  const effects = determineCascadeEffects(memoryId, outcome, connections);
  getLog().debug('effects_determined', { memory_id: memoryId, count: effects.length });

  // Apply automatic propagation instead of queueing events
  const affected = await applyAutomaticPropagation(env, memoryId, outcome);
  getLog().info('propagation_applied', { memory_id: memoryId, outcome, affected });

  return {
    source_id: memoryId,
    outcome,
    effects,
    events_queued: affected,
  };
}

/**
 * Get cascade effects without queueing (for preview/dry-run).
 */
export async function previewCascade(
  env: Env,
  memoryId: string,
  outcome: 'correct' | 'incorrect' | 'void'
): Promise<CascadeEffect[]> {
  const connections = await findConnectedMemories(env.DB, memoryId);
  return determineCascadeEffects(memoryId, outcome, connections);
}
