/**
 * History Service - Cognitive Loop Architecture (v3)
 *
 * Records version snapshots of entities when they are created or modified.
 * Enables tracking content changes over time for all entity types.
 * Updated for 3-primitive model: obs, infer, pred
 */

import { nanoid } from 'nanoid';
import type { RecordVersionParams, EntityVersion, EntityVersionRow, HistoryResponse, HistoryEntityType } from '../types/index.js';

/**
 * Record a new version of an entity.
 * Call this whenever an entity is created or modified.
 */
export async function recordVersion(
  db: D1Database,
  params: RecordVersionParams
): Promise<string> {
  const {
    entityId,
    entityType,
    changeType,
    contentSnapshot,
    changeReason,
    changedFields,
    sessionId,
    requestId,
    userAgent,
    ipHash,
  } = params;

  const now = Date.now();
  const id = `ver-${nanoid(12)}`;

  // Get next version number
  const lastVersion = await db.prepare(
    `SELECT MAX(version_number) as max_version FROM entity_versions WHERE entity_id = ?`
  ).bind(entityId).first<{ max_version: number | null }>();

  const versionNumber = (lastVersion?.max_version ?? 0) + 1;

  await db.prepare(
    `INSERT INTO entity_versions (
      id, entity_id, entity_type, version_number,
      content_snapshot, change_type, change_reason, changed_fields,
      session_id, request_id, user_agent, ip_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    entityId,
    entityType,
    versionNumber,
    JSON.stringify(contentSnapshot),
    changeType,
    changeReason ?? null,
    changedFields ? JSON.stringify(changedFields) : null,
    sessionId ?? null,
    requestId ?? null,
    userAgent ?? null,
    ipHash ?? null,
    now
  ).run();

  return id;
}

/**
 * Get version history for an entity.
 */
export async function getHistory(
  db: D1Database,
  entityId: string,
  limit: number = 20
): Promise<HistoryResponse | null> {
  // Infer entity type from ID prefix
  const entityType = inferEntityType(entityId);
  if (!entityType) {
    return null;
  }

  // Get versions
  const rows = await db.prepare(
    `SELECT * FROM entity_versions
     WHERE entity_id = ?
     ORDER BY version_number DESC
     LIMIT ?`
  ).bind(entityId, limit).all<EntityVersionRow>();

  if (!rows.results || rows.results.length === 0) {
    return null;
  }

  const versions: EntityVersion[] = rows.results.map(row => ({
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type as HistoryEntityType,
    versionNumber: row.version_number,
    contentSnapshot: JSON.parse(row.content_snapshot),
    changeType: row.change_type as EntityVersion['changeType'],
    changeReason: row.change_reason ?? undefined,
    changedFields: row.changed_fields ? JSON.parse(row.changed_fields) : undefined,
    sessionId: row.session_id ?? undefined,
    requestId: row.request_id ?? undefined,
    userAgent: row.user_agent ?? undefined,
    ipHash: row.ip_hash ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  return {
    entityId,
    entityType,
    currentVersion: versions[0].versionNumber,
    versions,
  };
}

/**
 * Get a specific version of an entity.
 */
export async function getVersion(
  db: D1Database,
  entityId: string,
  versionNumber: number
): Promise<EntityVersion | null> {
  const row = await db.prepare(
    `SELECT * FROM entity_versions
     WHERE entity_id = ? AND version_number = ?`
  ).bind(entityId, versionNumber).first<EntityVersionRow>();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    entityId: row.entity_id,
    entityType: row.entity_type as HistoryEntityType,
    versionNumber: row.version_number,
    contentSnapshot: JSON.parse(row.content_snapshot),
    changeType: row.change_type as EntityVersion['changeType'],
    changeReason: row.change_reason ?? undefined,
    changedFields: row.changed_fields ? JSON.parse(row.changed_fields) : undefined,
    sessionId: row.session_id ?? undefined,
    requestId: row.request_id ?? undefined,
    userAgent: row.user_agent ?? undefined,
    ipHash: row.ip_hash ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Infer entity type from ID prefix.
 * Note: With unified model, IDs no longer have prefixes.
 * This function is kept for edge IDs only.
 */
function inferEntityType(_id: string): HistoryEntityType | null {
  // With unified model, we can't infer type from ID
  // Caller should provide entityType explicitly
  return null;
}
