/**
 * Compute Stats Job - Daily Background Job
 *
 * Computes and stores system-wide statistics for the confidence model:
 * - max_times_tested: Global max for log-scale normalization
 * - median_times_tested: For insights and debugging
 * - Per-source learned_confidence: Track record for each source
 *
 * Run via cron trigger at 3 AM UTC daily.
 */

import { createStandaloneLogger } from '../lib/shared/logging/index.js';
import type { Env } from '../types/index.js';

// ============================================
// Configuration
// ============================================

/** Minimum tests required before source track record is considered */
const MIN_TESTS_FOR_TRACK_RECORD = 5;

/** Time window for track record calculation (6 months) */
const TRACK_RECORD_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

// ============================================
// Stats Computation
// ============================================

interface ComputeStatsResult {
  maxTimesTested: number;
  medianTimesTested: number;
  sourceTrackRecords: Record<string, number>;
  totalMemories: number;
  timestamp: number;
}

/**
 * Compute and store all system statistics.
 */
export async function computeSystemStats(
  env: Env,
  requestId: string
): Promise<ComputeStatsResult> {
  const log = createStandaloneLogger({
    component: 'ComputeStatsJob',
    requestId,
  });

  log.info('starting_stats_computation');
  const now = Date.now();

  // 1. Compute max_times_tested
  const maxResult = await env.DB.prepare(`
    SELECT MAX(times_tested) as max_times_tested, COUNT(*) as total
    FROM memories
    WHERE retracted = 0
  `).first<{ max_times_tested: number | null; total: number }>();

  const maxTimesTested = maxResult?.max_times_tested ?? 10;
  const totalMemories = maxResult?.total ?? 0;

  log.debug('max_times_tested_computed', { value: maxTimesTested, total: totalMemories });

  // Store max_times_tested
  await env.DB.prepare(`
    INSERT OR REPLACE INTO system_stats (key, value, updated_at)
    VALUES ('max_times_tested', ?, ?)
  `).bind(maxTimesTested, now).run();

  // 2. Compute median_times_tested
  const medianResult = await env.DB.prepare(`
    SELECT times_tested
    FROM memories
    WHERE retracted = 0
    ORDER BY times_tested
    LIMIT 1
    OFFSET (SELECT COUNT(*) / 2 FROM memories WHERE retracted = 0)
  `).first<{ times_tested: number }>();

  const medianTimesTested = medianResult?.times_tested ?? 0;

  log.debug('median_times_tested_computed', { value: medianTimesTested });

  // Store median_times_tested
  await env.DB.prepare(`
    INSERT OR REPLACE INTO system_stats (key, value, updated_at)
    VALUES ('median_times_tested', ?, ?)
  `).bind(medianTimesTested, now).run();

  // 3. Compute per-source track records (observations only)
  const windowStart = now - TRACK_RECORD_WINDOW_MS;
  const sourceResults = await env.DB.prepare(`
    SELECT
      source,
      AVG(CAST(confirmations AS REAL) / NULLIF(times_tested, 0)) as avg_confidence,
      COUNT(*) as count,
      SUM(times_tested) as total_tests
    FROM memories
    WHERE source IS NOT NULL
      AND times_tested >= ?
      AND created_at > ?
      AND retracted = 0
    GROUP BY source
  `).bind(MIN_TESTS_FOR_TRACK_RECORD, windowStart)
    .all<{ source: string; avg_confidence: number | null; count: number; total_tests: number }>();

  const sourceTrackRecords: Record<string, number> = {};

  for (const row of sourceResults.results || []) {
    if (row.avg_confidence !== null) {
      sourceTrackRecords[row.source] = row.avg_confidence;

      // Store in system_stats
      await env.DB.prepare(`
        INSERT OR REPLACE INTO system_stats (key, value, updated_at)
        VALUES (?, ?, ?)
      `).bind(`source:${row.source}:learned_confidence`, row.avg_confidence, now).run();

      log.debug('source_track_record_computed', {
        source: row.source,
        learned_confidence: row.avg_confidence,
        sample_count: row.count,
        total_tests: row.total_tests,
      });
    }
  }

  log.info('stats_computation_complete', {
    max_times_tested: maxTimesTested,
    median_times_tested: medianTimesTested,
    source_count: Object.keys(sourceTrackRecords).length,
    total_memories: totalMemories,
  });

  return {
    maxTimesTested,
    medianTimesTested,
    sourceTrackRecords,
    totalMemories,
    timestamp: now,
  };
}

// ============================================
// Stats Retrieval
// ============================================

/**
 * Get a system stat by key.
 */
export async function getSystemStat(
  db: D1Database,
  key: string
): Promise<number | null> {
  const result = await db.prepare(`
    SELECT value FROM system_stats WHERE key = ?
  `).bind(key).first<{ value: number }>();

  return result?.value ?? null;
}

/**
 * Get max_times_tested for normalization.
 * Falls back to default if not yet computed.
 */
export async function getMaxTimesTested(db: D1Database): Promise<number> {
  const value = await getSystemStat(db, 'max_times_tested');
  return value ?? 10; // Default fallback
}

/**
 * Get learned starting confidence for a source.
 * Falls back to null if not yet computed (caller should use bootstrap default).
 */
export async function getLearnedConfidence(
  db: D1Database,
  source: string
): Promise<number | null> {
  return getSystemStat(db, `source:${source}:learned_confidence`);
}

/**
 * Get starting confidence for an observation source.
 * Tries learned value first, falls back to bootstrap default.
 */
export async function getStartingConfidenceForSource(
  db: D1Database,
  source: string
): Promise<number> {
  // Import defaults here to avoid circular dependency
  const { SOURCE_STARTING_CONFIDENCE } = await import('../services/confidence.js');

  // Try learned value first
  const learned = await getLearnedConfidence(db, source);
  if (learned !== null) {
    return learned;
  }

  // Fall back to bootstrap default
  return SOURCE_STARTING_CONFIDENCE[source] ?? 0.50;
}

// ============================================
// All Stats Summary
// ============================================

export interface SystemStatsSummary {
  max_times_tested: number | null;
  median_times_tested: number | null;
  source_track_records: Record<string, number>;
  last_updated: number | null;
}

/**
 * Get a summary of all system stats.
 */
export async function getSystemStatsSummary(db: D1Database): Promise<SystemStatsSummary> {
  const results = await db.prepare(`
    SELECT key, value, updated_at FROM system_stats
  `).all<{ key: string; value: number; updated_at: number }>();

  const summary: SystemStatsSummary = {
    max_times_tested: null,
    median_times_tested: null,
    source_track_records: {},
    last_updated: null,
  };

  for (const row of results.results || []) {
    if (row.key === 'max_times_tested') {
      summary.max_times_tested = row.value;
    } else if (row.key === 'median_times_tested') {
      summary.median_times_tested = row.value;
    } else if (row.key.startsWith('source:') && row.key.endsWith(':learned_confidence')) {
      const source = row.key.replace('source:', '').replace(':learned_confidence', '');
      summary.source_track_records[source] = row.value;
    }

    // Track latest update time
    if (summary.last_updated === null || row.updated_at > summary.last_updated) {
      summary.last_updated = row.updated_at;
    }
  }

  return summary;
}
