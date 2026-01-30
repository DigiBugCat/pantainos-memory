/**
 * Cascade Service - Resolution Propagation
 *
 * When a prediction/inference resolves, this service:
 * 1. Traverses the graph to find related memories
 * 2. Flags them for review (doesn't auto-modify)
 * 3. Queues events for agentic dispatch
 *
 * Philosophy: Mark for review, don't auto-cascade.
 * Let the agent/human make the final judgment on related memories.
 */

import type { Env } from '../types/index.js';
import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import { queueSignificantEvent, type SignificantEventType } from './event-queue.js';

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
  | 'shared_assumption_violated'   // A shared assumption was violated
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
  suggested_action: 'review' | 'boost_confidence' | 'damage_confidence';
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
  memory_type: string;
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
           m.id as memory_id, m.memory_type, m.content, m.state
    FROM edges e
    JOIN memories m ON m.id = e.target_id
    WHERE e.source_id = ? AND m.retracted = 0
  `).bind(memoryId).all<EdgeRow & { memory_id: string; memory_type: string; content: string; state: string | null }>();

  // Find incoming edges (other → this memory)
  const incoming = await db.prepare(`
    SELECT e.id, e.source_id, e.target_id, e.edge_type,
           m.id as memory_id, m.memory_type, m.content, m.state
    FROM edges e
    JOIN memories m ON m.id = e.source_id
    WHERE e.target_id = ? AND m.retracted = 0
  `).bind(memoryId).all<EdgeRow & { memory_id: string; memory_type: string; content: string; state: string | null }>();

  const results: { memory: MemoryRow; edge: EdgeRow; direction: 'incoming' | 'outgoing' }[] = [];

  for (const row of outgoing.results || []) {
    results.push({
      memory: {
        id: row.memory_id,
        memory_type: row.memory_type,
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
        memory_type: row.memory_type,
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
 * Downstream propagation (things derived FROM resolved memory):
 * - If prediction resolved CORRECT:
 *   - Inferences that derived_from this → boost_confidence
 *   - Other predictions sharing assumptions → review
 * - If prediction resolved INCORRECT:
 *   - Inferences that derived_from this → damage_confidence
 *   - Other predictions sharing assumptions → review (may be invalid)
 *
 * Upstream propagation (things resolved memory was derived FROM):
 * - If prediction resolved CORRECT:
 *   - The inference/prediction this was derived_from gets evidence_validated
 *   - (Its prediction came true, strengthening the original reasoning)
 * - If prediction resolved INCORRECT:
 *   - The inference/prediction this was derived_from gets evidence_invalidated
 *   - (Its prediction failed, questioning the original reasoning)
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
    if (memory.memory_type === 'obs') continue;

    // Skip already-resolved memories
    if (memory.state === 'resolved') continue;

    // Determine effect based on relationship
    let reason: CascadeReason;
    let suggestedAction: 'review' | 'boost_confidence' | 'damage_confidence';

    if (direction === 'incoming' && edge.edge_type === 'derived_from') {
      // DOWNSTREAM: This memory derived_from the resolved prediction
      // If the source was correct, this memory's derivation was sound
      // If the source was incorrect, this memory's foundation is weakened
      reason = 'derived_prediction_resolved';
      suggestedAction = sourceOutcome === 'correct' ? 'boost_confidence' : 'damage_confidence';
    } else if (direction === 'outgoing' && edge.edge_type === 'derived_from') {
      // UPSTREAM: The resolved prediction derived_from this memory
      // This memory contributed to a prediction that resolved
      // Propagate evidence validation/invalidation upward
      if (sourceOutcome === 'correct') {
        reason = 'derived_evidence_validated';
        suggestedAction = 'boost_confidence'; // Evidence this produced was validated
      } else if (sourceOutcome === 'incorrect') {
        reason = 'derived_evidence_invalidated';
        suggestedAction = 'review'; // Evidence this produced was invalidated, needs review
      } else {
        // void outcome - just review
        reason = 'supporting_evidence_changed';
        suggestedAction = 'review';
      }
    } else if (edge.edge_type === 'confirmed_by' || edge.edge_type === 'violated_by') {
      // Already processed through exposure checking
      continue;
    } else {
      // Generic relationship
      reason = 'related_prediction_resolved';
      suggestedAction = 'review';
    }

    effects.push({
      target_id: memory.id,
      target_type: memory.memory_type,
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
// Event Queueing
// ============================================

/**
 * Queue cascade events for agentic dispatch.
 * These events are batched and sent to the resolver agent.
 *
 * Maps effects to event types:
 * - Downstream (derived_prediction_resolved):
 *   - boost_confidence → cascade_boost
 *   - damage_confidence → cascade_damage
 * - Upstream (derived_evidence_validated/invalidated):
 *   - boost_confidence → evidence_validated
 *   - review → evidence_invalidated (or cascade_review)
 */
async function queueCascadeEvents(
  env: Env,
  sessionId: string | undefined,
  effects: CascadeEffect[]
): Promise<number> {
  let queued = 0;

  for (const effect of effects) {
    // Map suggested_action + reason to event_type
    let eventType: SignificantEventType;

    // Check if this is an upward propagation event
    if (effect.reason === 'derived_evidence_validated') {
      eventType = 'assumption:evidence_validated';
    } else if (effect.reason === 'derived_evidence_invalidated') {
      eventType = 'assumption:evidence_invalidated';
    } else {
      // Standard downstream cascade
      switch (effect.suggested_action) {
        case 'boost_confidence':
          eventType = 'assumption:cascade_boost';
          break;
        case 'damage_confidence':
          eventType = 'assumption:cascade_damage';
          break;
        default:
          eventType = 'assumption:cascade_review';
      }
    }

    try {
      await queueSignificantEvent(env, {
        session_id: sessionId,
        event_type: eventType,
        memory_id: effect.target_id,
        context: {
          reason: effect.reason,
          source_id: effect.source_id,
          source_outcome: effect.source_outcome,
          edge_type: effect.edge_type,
          suggested_action: effect.suggested_action,
        },
      });
      queued++;
    } catch (error) {
      getLog().warn('event_queue_failed', {
        event_type: eventType,
        target_id: effect.target_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return queued;
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
 * 2. Determine cascade effects
 * 3. Queue events for agentic dispatch
 *
 * @param env - Worker environment
 * @param memoryId - The resolved memory ID
 * @param outcome - How the memory was resolved
 * @param sessionId - Optional session ID for event batching
 */
export async function propagateResolution(
  env: Env,
  memoryId: string,
  outcome: 'correct' | 'incorrect' | 'void',
  sessionId?: string
): Promise<CascadeResult> {
  getLog().info('propagating', { memory_id: memoryId, outcome });

  // Find connected memories
  const connections = await findConnectedMemories(env.DB, memoryId);
  getLog().debug('connections_found', { memory_id: memoryId, count: connections.length });

  // Determine effects
  const effects = determineCascadeEffects(memoryId, outcome, connections);
  getLog().debug('effects_determined', { memory_id: memoryId, count: effects.length });

  // Queue events
  const eventsQueued = await queueCascadeEvents(env, sessionId, effects);
  getLog().debug('events_queued', { memory_id: memoryId, count: eventsQueued });

  return {
    source_id: memoryId,
    outcome,
    effects,
    events_queued: eventsQueued,
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
