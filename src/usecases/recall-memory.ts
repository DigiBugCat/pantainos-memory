import type { EdgeRow, Memory, MemoryRow } from '../types/index.js';
import { rowToMemory } from '../lib/transforms.js';
import { fetchEdgesBySourceIds, fetchEdgesByTargetIds, fetchMemoriesByIds } from '../lib/sql-utils.js';

export interface RecallMemoryResult {
  row: MemoryRow;
  memory: Memory;
  edges: EdgeRow[];
  connections: Memory[];
}

export async function recallMemory(
  db: D1Database,
  id: string
): Promise<RecallMemoryResult | null> {
  const row = await db.prepare(
    `SELECT * FROM memories WHERE id = ?`
  ).bind(id).first<MemoryRow>();

  if (!row) return null;

  const [outgoing, incoming] = await Promise.all([
    fetchEdgesBySourceIds<EdgeRow>(db, [id]),
    fetchEdgesByTargetIds<EdgeRow>(db, [id]),
  ]);

  const edges = [...outgoing, ...incoming];
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source_id !== id) connectedIds.add(edge.source_id);
    if (edge.target_id !== id) connectedIds.add(edge.target_id);
  }

  const connectionRows = await fetchMemoriesByIds<MemoryRow>(db, [...connectedIds], {
    includeRetracted: false,
  });

  return {
    row,
    memory: rowToMemory(row),
    edges,
    connections: connectionRows.map((r) => rowToMemory(r)),
  };
}
