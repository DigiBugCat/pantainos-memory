/**
 * Source normalization helpers for observation provenance.
 */

/** Normalize source for storage and confidence lookups. */
export function normalizeSource(input: string): string {
  return input.trim().toLowerCase();
}

/** Check whether a source is non-empty after normalization. */
export function isNonEmptySource(input: string): boolean {
  return normalizeSource(input).length > 0;
}
