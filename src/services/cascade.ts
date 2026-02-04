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
// Event Queueing
// ============================================

/**
 * Queue cascade events for agentic dispatch.
 * These events are batched and sent to the resolver agent.
 *
 * Maps effects to event types:
 * - Upstream: evidence_validated / evidence_invalidated (informational)
 * - Everything else: cascade_review
 */
async function queueCascadeEvents(
  env: Env,
  sessionId: string | undefined,
  effects: CascadeEffect[]
): Promise<number> {
  let queued = 0;

  for (const effect of effects) {
    // Map reason to event_type
    let eventType: SignificantEventType;

    // Check if this is an upward propagation event (informational)
    if (effect.reason === 'derived_evidence_validated') {
      eventType = 'thought:evidence_validated';
    } else if (effect.reason === 'derived_evidence_invalidated') {
      eventType = 'thought:evidence_invalidated';
    } else {
      // All cascade effects are review-only
      eventType = 'thought:cascade_review';
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
