/**
 * Typed ID generation for the Cognitive Loop model (v4)
 *
 * ID format: {type}-{random}
 * - obs-xxxxxxxxxx   (observation)
 * - infer-xxxxxxxxxx (general assumption - no deadline)
 * - pred-xxxxxxxxxx  (time-bound assumption - has deadline)
 * - edge-xxxxxxxxxx  (graph edge)
 *
 * Note: We keep infer/pred prefixes for ID semantics even though
 * the DB type is unified as 'assumption'. This preserves:
 * - Backward compatibility with existing IDs
 * - Semantic meaning in the ID itself
 */

import { nanoid } from 'nanoid';
import type { MemoryType } from './shared/types/index.js';

/** Extended type for ID generation (includes legacy prefixes and edge) */
type IdType = MemoryType | 'infer' | 'pred' | 'edge';

/**
 * Generate a typed ID
 * @param type - ID type (obs, assumption, infer, pred, edge)
 * @returns Prefixed ID string
 *
 * For assumptions:
 * - Use 'infer' for general assumptions (no deadline)
 * - Use 'pred' for time-bound assumptions (has deadline)
 * - 'assumption' defaults to 'infer' prefix
 */
export function generateId(type: IdType): string {
  // Map 'assumption' to 'infer' prefix for backwards compatibility
  const prefix = type === 'assumption' ? 'infer' : type;
  return `${prefix}-${nanoid(10)}`;
}

/**
 * Parse the memory type from an ID
 * @param id - Memory ID
 * @returns MemoryType or null for legacy/unknown IDs
 */
export function parseIdType(id: string): MemoryType | null {
  if (id.startsWith('obs-')) return 'obs';
  // Both infer- and pred- prefixes map to 'assumption' type
  if (id.startsWith('infer-')) return 'assumption';
  if (id.startsWith('pred-')) return 'assumption';
  // Legacy support for 'note-' IDs (map to assumption)
  if (id.startsWith('note-')) return 'assumption';
  return null; // Legacy ID without prefix
}

/**
 * Check if an ID represents a time-bound assumption
 * @param id - Memory ID
 * @returns true if pred- prefix (time-bound assumption)
 */
export function isTimeBound(id: string): boolean {
  return id.startsWith('pred-');
}

/**
 * Get the memory type, checking ID prefix first, then falling back to DB value
 * @param id - Memory ID
 * @param dbType - Optional type from database
 * @returns MemoryType (defaults to 'obs' for legacy IDs)
 */
export function getMemoryType(id: string, dbType?: string): MemoryType {
  const prefixType = parseIdType(id);
  if (prefixType) return prefixType;
  // Handle both new and legacy DB types
  if (dbType === 'assumption' || dbType === 'infer' || dbType === 'pred') {
    return 'assumption';
  }
  if (dbType === 'obs') return 'obs';
  // Legacy mapping: 'note' -> 'assumption'
  if (dbType === 'note') return 'assumption';
  return 'obs'; // Legacy IDs are treated as observations
}

/**
 * Check if an ID is for an observation
 * Note: Legacy IDs (no prefix) are treated as observations, but edge IDs are not.
 */
export function isObservation(id: string): boolean {
  if (id.startsWith('edge-')) return false;
  const type = parseIdType(id);
  return type === 'obs' || type === null;
}

/**
 * Check if an ID is for an assumption (infer- or pred- prefix)
 */
export function isAssumption(id: string): boolean {
  return id.startsWith('infer-') || id.startsWith('pred-') || id.startsWith('note-');
}

/**
 * @deprecated Use isAssumption - kept for migration
 */
export function isInference(id: string): boolean {
  return id.startsWith('infer-') || id.startsWith('note-');
}

/**
 * @deprecated Use isTimeBound - kept for migration
 */
export function isPrediction(id: string): boolean {
  return id.startsWith('pred-');
}

/**
 * Check if an ID is for an edge
 */
export function isEdge(id: string): boolean {
  return id.startsWith('edge-');
}
