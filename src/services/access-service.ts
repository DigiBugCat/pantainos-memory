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
  HistoryEntityType,
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
    entityType: row.entity_type as HistoryEntityType,
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
    entityType: row.entity_type as HistoryEntityType,
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
 * Aggregated memory access for session recap.
 */
export interface SessionMemoryAccess {
  memoryId: string;
  content: string;
  displayType: 'observation' | 'thought' | 'prediction';
  accessTypes: string[];
  queryTexts: string[];
  lastAccessed: number;
  accessCount: number;
  state: string;
}

/**
 * Query memories accessed in a session, grouped and deduplicated.
 * Uses sessionId when available, falls back to time-based window.
 */
export async function querySessionMemories(
  db: D1Database,
  filters: { sessionId?: string; sinceMinutes?: number; limit?: number }
): Promise<SessionMemoryAccess[]> {
  const { sessionId, sinceMinutes = 30, limit = 30 } = filters;

  const cutoff = Date.now() - sinceMinutes * 60 * 1000;

  let query: string;
  const bindings: (string | number)[] = [];

  if (sessionId) {
    query = `
      SELECT
        a.entity_id AS memory_id,
        m.content,
        m.source,
        m.derived_from,
        m.resolves_by,
        m.state,
        GROUP_CONCAT(DISTINCT a.access_type) AS access_types,
        GROUP_CONCAT(DISTINCT a.query_text) AS query_texts,
        MAX(a.accessed_at) AS last_accessed,
        COUNT(*) AS access_count
      FROM access_events a
      JOIN memories m ON m.id = a.entity_id AND m.retracted = 0
      WHERE a.session_id = ?
      GROUP BY a.entity_id
      ORDER BY last_accessed DESC
      LIMIT ?
    `;
    bindings.push(sessionId, limit);
  } else {
    query = `
      SELECT
        a.entity_id AS memory_id,
        m.content,
        m.source,
        m.derived_from,
        m.resolves_by,
        m.state,
        GROUP_CONCAT(DISTINCT a.access_type) AS access_types,
        GROUP_CONCAT(DISTINCT a.query_text) AS query_texts,
        MAX(a.accessed_at) AS last_accessed,
        COUNT(*) AS access_count
      FROM access_events a
      JOIN memories m ON m.id = a.entity_id AND m.retracted = 0
      WHERE a.accessed_at > ?
      GROUP BY a.entity_id
      ORDER BY last_accessed DESC
      LIMIT ?
    `;
    bindings.push(cutoff, limit);
  }

  const rows = await db.prepare(query).bind(...bindings).all<{
    memory_id: string;
    content: string;
    source: string | null;
    derived_from: string | null;
    resolves_by: number | null;
    state: string;
    access_types: string;
    query_texts: string | null;
    last_accessed: number;
    access_count: number;
  }>();

  return (rows.results ?? []).map(row => {
    let displayType: 'observation' | 'thought' | 'prediction';
    if (row.source !== null) {
      displayType = 'observation';
    } else if (row.resolves_by !== null) {
      displayType = 'prediction';
    } else {
      displayType = 'thought';
    }

    return {
      memoryId: row.memory_id,
      content: row.content,
      displayType,
      accessTypes: row.access_types ? row.access_types.split(',') : [],
      queryTexts: row.query_texts ? row.query_texts.split(',') : [],
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      state: row.state,
    };
  });
}

/**
 * Infer entity type from ID prefix.
 * Note: With unified model, IDs no longer have prefixes.
 * This function is kept for legacy compatibility only.
 */
function inferEntityType(_id: string): HistoryEntityType | null {
  // With unified model, we can't infer type from ID
  // Return null to indicate lookup is required
  return null;
}
