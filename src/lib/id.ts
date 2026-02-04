/**
 * ID generation for Unified Memory Model
 *
 * Plain nanoid format: a1b2c3d4e5
 * No prefixes. The ID is just an identifier, not semantic metadata.
 *
 * The type of a memory is determined by field presence:
 *   - source → observation
 *   - derived_from → thought
 *   - resolves_by → time-bound thought (prediction)
 */

import { nanoid } from 'nanoid';

/**
 * Generate a unique ID for any entity.
 * @returns Plain nanoid string (10 characters)
 */
export function generateId(): string {
  return nanoid(10);
}

/**
 * Generate an ID for an edge
 * @returns Plain nanoid string (10 characters)
 */
export function generateEdgeId(): string {
  return nanoid(10);
}
