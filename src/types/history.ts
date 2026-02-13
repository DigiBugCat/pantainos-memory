/**
 * History & Audit Tracking Types - Unified Memory Model
 *
 * All memories use 'memory' as entity type. 'edge' for graph edges.
 */

// ============================================
// Entity Types for History Tracking
// ============================================

/**
 * Entity types tracked in history.
 * 'memory' for all memories, 'edge' for graph edges.
 */
export type HistoryEntityType = 'memory' | 'edge';

// ============================================
// Version History Types
// ============================================

export type ChangeType =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'violated'
  | 'confirmed'
  | 'retracted'
  | 'resolved'
  | 'reclassified_as_observation'
  | 'reclassified_as_thought';

export interface EntityVersion {
  id: string;
  entityId: string;
  entityType: HistoryEntityType;
  versionNumber: number;
  contentSnapshot: Record<string, unknown>;
  changeType: ChangeType;
  changeReason?: string;
  changedFields?: string[];
  sessionId?: string;
  requestId?: string;
  userAgent?: string;
  ipHash?: string;
  createdAt: string;
}

export interface EntityVersionRow {
  id: string;
  entity_id: string;
  entity_type: string;
  version_number: number;
  content_snapshot: string;
  change_type: string;
  change_reason: string | null;
  changed_fields: string | null;
  session_id: string | null;
  request_id: string | null;
  user_agent: string | null;
  ip_hash: string | null;
  created_at: number;
}

export interface RecordVersionParams {
  entityId: string;
  entityType: HistoryEntityType;
  changeType: ChangeType;
  contentSnapshot: Record<string, unknown>;
  changeReason?: string;
  changedFields?: string[];
  sessionId?: string;
  requestId?: string;
  userAgent?: string;
  ipHash?: string;
}

export interface HistoryResponse {
  entityId: string;
  entityType: HistoryEntityType;
  currentVersion: number;
  versions: EntityVersion[];
}

// ============================================
// Access Event Types
// ============================================

export type AccessType =
  | 'recall'
  | 'find'
  | 'reference'
  | 'between'
  | 'insights'
  | 'knowledge'
  | 'pending'
  | 'collisions'
  | 'roots'
  | 'bulk_read';

export interface AccessEvent {
  id: string;
  entityId: string;
  entityType: HistoryEntityType;
  accessType: AccessType;
  sessionId?: string;
  requestId?: string;
  userAgent?: string;
  ipHash?: string;
  queryText?: string;
  queryParams?: Record<string, unknown>;
  resultRank?: number;
  similarityScore?: number;
  accessedAt: string;
}

export interface AccessEventRow {
  id: string;
  entity_id: string;
  entity_type: string;
  access_type: string;
  session_id: string | null;
  request_id: string | null;
  user_agent: string | null;
  ip_hash: string | null;
  query_text: string | null;
  query_params: string | null;
  result_rank: number | null;
  similarity_score: number | null;
  accessed_at: number;
}

export interface RecordAccessParams {
  entityId: string;
  entityType: HistoryEntityType;
  accessType: AccessType;
  sessionId?: string;
  requestId?: string;
  userAgent?: string;
  ipHash?: string;
  queryText?: string;
  queryParams?: Record<string, unknown>;
  resultRank?: number;
  similarityScore?: number;
}

export interface AccessLogResponse {
  entityId: string;
  entityType: HistoryEntityType;
  totalAccesses: number;
  uniqueSessions: number;
  accessByType: Record<AccessType, number>;
  recentEvents: AccessEvent[];
}

// ============================================
// Actor Context (extracted from request)
// ============================================

export interface ActorContext {
  sessionId?: string;
  requestId?: string;
  userAgent?: string;
  ipHash?: string;
}
