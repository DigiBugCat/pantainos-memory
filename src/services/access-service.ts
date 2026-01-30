/**
 * Access Service
 *
 * Records access events for audit trail and analytics.
 * Tracks who accessed what entities, when, and in what context.
 */

import { nanoid } from 'nanoid';
import type {
  RecordAccessParams,
  AccessEvent,
  AccessEventRow,
  AccessLogResponse,
  AccessType,
  EntityType,
} from '../types/index.js';

/**
 * Record an access event.
 * Call this whenever an entity is read/queried.
 */
export async function recordAccess(
  db: D1Database,
  params: RecordAccessParams
): Promise<string> {
  const {
    entityId,
    entityType,
    accessType,
    sessionId,
    requestId,
    userAgent,
    ipHash,
    queryText,
    queryParams,
    resultRank,
    similarityScore,
  } = params;

  const now = Date.now();
  const id = `acc-${nanoid(12)}`;

  await db.prepare(
    `INSERT INTO access_events (
      id, entity_id, entity_type, access_type,
      session_id, request_id, user_agent, ip_hash,
      query_text, query_params, result_rank, similarity_score,
      accessed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    entityId,
    entityType,
    accessType,
    sessionId ?? null,
    requestId ?? null,
    userAgent ?? null,
    ipHash ?? null,
    queryText ?? null,
    queryParams ? JSON.stringify(queryParams) : null,
    resultRank ?? null,
    similarityScore ?? null,
    now
  ).run();

  return id;
}

/**
 * Record multiple access events in a batch (for search results).
 */
export async function recordAccessBatch(
  db: D1Database,
  events: RecordAccessParams[]
): Promise<void> {
  if (events.length === 0) return;

  const now = Date.now();
  const statements = events.map(params => {
    const id = `acc-${nanoid(12)}`;
    return db.prepare(
      `INSERT INTO access_events (
        id, entity_id, entity_type, access_type,
        session_id, request_id, user_agent, ip_hash,
        query_text, query_params, result_rank, similarity_score,
        accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      params.entityId,
      params.entityType,
      params.accessType,
      params.sessionId ?? null,
      params.requestId ?? null,
      params.userAgent ?? null,
      params.ipHash ?? null,
      params.queryText ?? null,
      params.queryParams ? JSON.stringify(params.queryParams) : null,
      params.resultRank ?? null,
      params.similarityScore ?? null,
      now
    );
  });

  await db.batch(statements);
}

/**
 * Get access log for an entity.
 */
export async function getAccessLog(
  db: D1Database,
  entityId: string,
  limit: number = 20
): Promise<AccessLogResponse | null> {
  // Infer entity type from ID prefix
  const entityType = inferEntityType(entityId);
  if (!entityType) {
    return null;
  }

  // Get total count
  const countResult = await db.prepare(
    `SELECT COUNT(*) as total FROM access_events WHERE entity_id = ?`
  ).bind(entityId).first<{ total: number }>();

  const totalAccesses = countResult?.total ?? 0;

  // Get unique sessions
  const sessionsResult = await db.prepare(
    `SELECT COUNT(DISTINCT session_id) as count FROM access_events
     WHERE entity_id = ? AND session_id IS NOT NULL`
  ).bind(entityId).first<{ count: number }>();

  const uniqueSessions = sessionsResult?.count ?? 0;

  // Get access by type
  const typeRows = await db.prepare(
    `SELECT access_type, COUNT(*) as count FROM access_events
     WHERE entity_id = ?
     GROUP BY access_type`
  ).bind(entityId).all<{ access_type: string; count: number }>();

  const accessByType: Record<AccessType, number> = {} as Record<AccessType, number>;
  for (const row of typeRows.results ?? []) {
    accessByType[row.access_type as AccessType] = row.count;
  }

  // Get recent events
  const rows = await db.prepare(
    `SELECT * FROM access_events
     WHERE entity_id = ?
     ORDER BY accessed_at DESC
     LIMIT ?`
  ).bind(entityId, limit).all<AccessEventRow>();

  const recentEvents: AccessEvent[] = (rows.results ?? []).map(row => ({
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type as EntityType,
    accessType: row.access_type as AccessType,
    sessionId: row.session_id ?? undefined,
    requestId: row.request_id ?? undefined,
    userAgent: row.user_agent ?? undefined,
    ipHash: row.ip_hash ?? undefined,
    queryText: row.query_text ?? undefined,
    queryParams: row.query_params ? JSON.parse(row.query_params) : undefined,
    resultRank: row.result_rank ?? undefined,
    similarityScore: row.similarity_score ?? undefined,
    accessedAt: new Date(row.accessed_at).toISOString(),
  }));

  return {
    entityId,
    entityType,
    totalAccesses,
    uniqueSessions,
    accessByType,
    recentEvents,
  };
}

/**
 * Query access events with filters.
 */
export async function queryAccessEvents(
  db: D1Database,
  filters: {
    entityId?: string;
    sessionId?: string;
    accessType?: AccessType;
    limit?: number;
  }
): Promise<AccessEvent[]> {
  const { entityId, sessionId, accessType, limit = 50 } = filters;

  let query = 'SELECT * FROM access_events WHERE 1=1';
  const bindings: (string | number)[] = [];

  if (entityId) {
    query += ' AND entity_id = ?';
    bindings.push(entityId);
  }

  if (sessionId) {
    query += ' AND session_id = ?';
    bindings.push(sessionId);
  }

  if (accessType) {
    query += ' AND access_type = ?';
    bindings.push(accessType);
  }

  query += ' ORDER BY accessed_at DESC LIMIT ?';
  bindings.push(limit);

  const rows = await db.prepare(query).bind(...bindings).all<AccessEventRow>();

  return (rows.results ?? []).map(row => ({
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type as EntityType,
    accessType: row.access_type as AccessType,
    sessionId: row.session_id ?? undefined,
    requestId: row.request_id ?? undefined,
    userAgent: row.user_agent ?? undefined,
    ipHash: row.ip_hash ?? undefined,
    queryText: row.query_text ?? undefined,
    queryParams: row.query_params ? JSON.parse(row.query_params) : undefined,
    resultRank: row.result_rank ?? undefined,
    similarityScore: row.similarity_score ?? undefined,
    accessedAt: new Date(row.accessed_at).toISOString(),
  }));
}

/**
 * Infer entity type from ID prefix.
 * v4: Both infer- and pred- prefixes map to 'assumption' type.
 */
function inferEntityType(id: string): EntityType | null {
  if (id.startsWith('obs-')) return 'obs';
  // Both infer- and pred- prefixes are assumptions
  if (id.startsWith('infer-')) return 'assumption';
  if (id.startsWith('pred-')) return 'assumption';
  // Legacy prefixes
  if (id.startsWith('thought-') || id.startsWith('note-')) return 'assumption';
  if (id.startsWith('mem-')) return 'obs';
  return null;
}
