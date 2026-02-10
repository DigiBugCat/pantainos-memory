/**
 * Data Transforms - Unified Memory Model
 *
 * Convert between database row types and API types.
 */

import type { Memory, MemoryRow, MemoryState, ObservationSource, ExposureCheckStatus } from './shared/types/index.js';

/**
 * Convert a MemoryRow from D1 to a Memory object for API responses.
 */
export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    source: (row.source as ObservationSource) || undefined,
    source_url: row.source_url || undefined,
    derived_from: row.derived_from ? JSON.parse(row.derived_from) : undefined,
    assumes: row.assumes ? JSON.parse(row.assumes) : undefined,
    invalidates_if: row.invalidates_if ? JSON.parse(row.invalidates_if) : undefined,
    confirms_if: row.confirms_if ? JSON.parse(row.confirms_if) : undefined,
    outcome_condition: row.outcome_condition || undefined,
    resolves_by: row.resolves_by || undefined,
    // Confidence model
    starting_confidence: row.starting_confidence ?? 0.5,
    confirmations: row.confirmations,
    times_tested: row.times_tested,
    contradictions: row.contradictions ?? 0,
    centrality: row.centrality,
    propagated_confidence: row.propagated_confidence ?? undefined,
    state: (row.state as MemoryState) || 'active',
    violations: row.violations ? JSON.parse(row.violations) : [],
    retracted: Boolean(row.retracted),
    retracted_at: row.retracted_at || undefined,
    retraction_reason: row.retraction_reason || undefined,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    obsidian_sources: row.obsidian_sources ? JSON.parse(row.obsidian_sources) : undefined,
    session_id: row.session_id || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at || undefined,
    // Exposure check tracking
    exposure_check_status: (row.exposure_check_status as ExposureCheckStatus) || 'pending',
    exposure_check_completed_at: row.exposure_check_completed_at || undefined,
    // Cascade tracking
    cascade_boosts: row.cascade_boosts || 0,
    cascade_damages: row.cascade_damages || 0,
    last_cascade_at: row.last_cascade_at || undefined,
  };
}

/**
 * Convert a Memory object to a MemoryRow for D1 storage.
 */
export function memoryToRow(memory: Memory): Partial<MemoryRow> {
  return {
    id: memory.id,
    content: memory.content,
    source: memory.source,
    source_url: memory.source_url ?? null,
    derived_from: memory.derived_from ? JSON.stringify(memory.derived_from) : null,
    assumes: memory.assumes ? JSON.stringify(memory.assumes) : null,
    invalidates_if: memory.invalidates_if ? JSON.stringify(memory.invalidates_if) : null,
    confirms_if: memory.confirms_if ? JSON.stringify(memory.confirms_if) : null,
    outcome_condition: memory.outcome_condition,
    resolves_by: memory.resolves_by,
    // Confidence model
    starting_confidence: memory.starting_confidence,
    confirmations: memory.confirmations,
    times_tested: memory.times_tested,
    contradictions: memory.contradictions,
    centrality: memory.centrality,
    propagated_confidence: memory.propagated_confidence ?? null,
    state: memory.state,
    violations: memory.violations ? JSON.stringify(memory.violations) : '[]',
    retracted: memory.retracted ? 1 : 0,
    retracted_at: memory.retracted_at,
    retraction_reason: memory.retraction_reason,
    tags: memory.tags ? JSON.stringify(memory.tags) : null,
    obsidian_sources: memory.obsidian_sources ? JSON.stringify(memory.obsidian_sources) : null,
    session_id: memory.session_id,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    // Exposure check tracking
    exposure_check_status: memory.exposure_check_status,
    exposure_check_completed_at: memory.exposure_check_completed_at,
    // Cascade tracking
    cascade_boosts: memory.cascade_boosts,
    cascade_damages: memory.cascade_damages,
    last_cascade_at: memory.last_cascade_at,
  };
}
