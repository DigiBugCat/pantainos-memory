/**
 * SQL Utilities for D1
 *
 * Helpers for working within D1's 100 bind-parameter limit.
 */

const MAX_PARAMS = 95; // D1 limit is 100, leave headroom for scalar params

/**
 * Execute a query with IN-clause chunking to stay under D1's 100-variable limit.
 *
 * Splits `ids` into chunks, runs the query for each chunk, and merges results.
 *
 * @param db - D1 database instance
 * @param buildQuery - receives a placeholder string (e.g. "?,?,?") and returns the full SQL
 * @param ids - array of IDs to spread into the IN clause(s)
 * @param scalarsBefore - scalar bind params placed before the IN spread(s)
 * @param scalarsAfter - scalar bind params placed after the IN spread(s)
 * @param spreadCount - how many times `ids` is spread in the bind call
 *                      (e.g. 2 for `source_id IN (?) OR target_id IN (?)`)
 */
export async function queryInChunks<T>(
  db: D1Database,
  buildQuery: (placeholders: string) => string,
  ids: string[],
  scalarsBefore: unknown[],
  scalarsAfter: unknown[],
  spreadCount: number,
): Promise<T[]> {
  if (ids.length === 0) return [];

  const scalarCount = scalarsBefore.length + scalarsAfter.length;
  const chunkSize = Math.max(1, Math.floor((MAX_PARAMS - scalarCount) / spreadCount));

  const results: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const sql = buildQuery(placeholders);

    // Build bind params: scalarsBefore + (chunk repeated spreadCount times) + scalarsAfter
    const bindParams: unknown[] = [...scalarsBefore];
    for (let s = 0; s < spreadCount; s++) {
      bindParams.push(...chunk);
    }
    bindParams.push(...scalarsAfter);

    const res = await db.prepare(sql).bind(...bindParams).all<T>();
    if (res.results) results.push(...res.results);
  }

  return results;
}

/**
 * Execute a contradiction gate query that spreads TWO different arrays.
 *
 * Pattern: `(source_id IN (eligible) AND target_id IN (zone))
 *        OR (target_id IN (eligible) AND source_id IN (zone))`
 *
 * Chunks `eligible` while keeping `zoneIds` constant per chunk.
 */
export async function queryContradictionGate<T>(
  db: D1Database,
  eligible: string[],
  zoneIds: string[],
): Promise<T[]> {
  if (eligible.length === 0 || zoneIds.length === 0) return [];

  // Each chunk uses: eligible_chunk * 2 + zoneIds * 2 params
  const fixedParams = zoneIds.length * 2;
  const chunkSize = Math.max(1, Math.floor((MAX_PARAMS - fixedParams) / 2));

  const results: T[] = [];
  for (let i = 0; i < eligible.length; i += chunkSize) {
    const chunk = eligible.slice(i, i + chunkSize);
    const eligiblePh = chunk.map(() => '?').join(',');
    const zonePh = zoneIds.map(() => '?').join(',');

    const sql = `SELECT source_id, target_id
       FROM edges
       WHERE edge_type = 'violated_by' AND (
         (source_id IN (${eligiblePh}) AND target_id IN (${zonePh}))
         OR (target_id IN (${eligiblePh}) AND source_id IN (${zonePh}))
       )`;

    const res = await db.prepare(sql).bind(...chunk, ...zoneIds, ...chunk, ...zoneIds).all<T>();
    if (res.results) results.push(...res.results);
  }

  return results;
}

interface FetchMemoryOptions {
  includeRetracted?: boolean;
}

/**
 * Bulk-fetch memories by IDs with D1-safe chunking.
 * Returned rows follow input ID order (missing IDs omitted).
 */
export async function fetchMemoriesByIds<T extends { id: string; retracted?: number }>(
  db: D1Database,
  ids: string[],
  options: FetchMemoryOptions = {},
): Promise<T[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const includeRetracted = options.includeRetracted ?? false;
  const rows = await queryInChunks<T>(
    db,
    (placeholders) =>
      `SELECT * FROM memories WHERE id IN (${placeholders}) ${includeRetracted ? '' : 'AND retracted = 0'}`,
    uniqueIds,
    [],
    [],
    1
  );

  const byId = new Map(rows.map((row) => [row.id, row]));
  return uniqueIds.map((id) => byId.get(id)).filter((row): row is T => Boolean(row));
}

/**
 * Bulk-fetch edges by source IDs with optional edge type filter.
 */
export async function fetchEdgesBySourceIds<T extends { source_id: string; edge_type?: string }>(
  db: D1Database,
  sourceIds: string[],
  edgeTypes?: string[],
): Promise<T[]> {
  const uniqueIds = [...new Set(sourceIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const typePlaceholders = edgeTypes && edgeTypes.length > 0
    ? ` AND edge_type IN (${edgeTypes.map(() => '?').join(',')})`
    : '';

  return queryInChunks<T>(
    db,
    (placeholders) =>
      `SELECT * FROM edges WHERE source_id IN (${placeholders})${typePlaceholders}`,
    uniqueIds,
    [],
    edgeTypes && edgeTypes.length > 0 ? edgeTypes : [],
    1
  );
}

/**
 * Bulk-fetch edges by target IDs with optional edge type filter.
 */
export async function fetchEdgesByTargetIds<T extends { target_id: string; edge_type?: string }>(
  db: D1Database,
  targetIds: string[],
  edgeTypes?: string[],
): Promise<T[]> {
  const uniqueIds = [...new Set(targetIds.filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  const typePlaceholders = edgeTypes && edgeTypes.length > 0
    ? ` AND edge_type IN (${edgeTypes.map(() => '?').join(',')})`
    : '';

  return queryInChunks<T>(
    db,
    (placeholders) =>
      `SELECT * FROM edges WHERE target_id IN (${placeholders})${typePlaceholders}`,
    uniqueIds,
    [],
    edgeTypes && edgeTypes.length > 0 ? edgeTypes : [],
    1
  );
}
