/**
 * Admin MCP tools for pantainos-memory.
 *
 * Maintenance and diagnostic tools for system administration.
 * Only accessible to admin users via CF Access.
 */

import { Hono } from 'hono';
import type { Env as BaseEnv } from '../types/index.js';
import type { Config } from '../lib/config.js';
import type { LoggingEnv } from '../lib/shared/hono/index.js';
import {
  handleMcpMessage,
  parseJsonRpcRequest,
  createToolRegistry,
  defineTool,
  errorResult,
  type ToolContext,
} from '../lib/shared/mcp/index.js';
import { deleteConditionVectors } from '../services/embedding-tables.js';
import { propagateResolution } from '../services/cascade.js';
import { callExternalLLM } from '../lib/embeddings.js';
import {
  buildInvalidatesIfPrompt,
  parseConditionResponse,
} from '../services/exposure-checker.js';
import type { Violation } from '../lib/shared/types/index.js';
import { computeSurprise } from '../services/surprise.js';
// Available for future admin tools:
// import { computeSystemStats, getSystemStatsSummary } from '../jobs/compute-stats.js';

type Env = BaseEnv & LoggingEnv;

type Variables = {
  config: Config;
  requestId: string;
  sessionId: string | undefined;
  userAgent: string | undefined;
  ipHash: string | undefined;
  cfAccessEmail: string | undefined;
};

/** Text result wrapper */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/** Format timestamp to readable date */
function formatTs(ts: number): string {
  if (!ts) return 'never';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** Format relative time */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ============================================
// Tool Definitions
// ============================================

const createAdminTools = () => createToolRegistry<Env>([

  // ----------------------------------------
  // queue_status - View event queue state
  // ----------------------------------------
  defineTool({
    name: 'queue_status',
    description: 'View event queue state: pending counts by session, event type distribution, stuck sessions, dispatched history.',
    annotations: {
      title: 'Queue Status',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Summary shows counts, detailed shows individual events (default: summary)',
        },
        session_id: {
          type: 'string',
          description: 'Filter by specific session ID',
        },
      },
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const detailLevel = (args.detail_level as string) || 'summary';
      const sessionFilter = args.session_id as string | undefined;

      // Overall counts
      const overallResult = await ctx.env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN dispatched = 0 THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN dispatched = 1 THEN 1 ELSE 0 END) as dispatched,
          MIN(CASE WHEN dispatched = 0 THEN created_at END) as oldest_pending,
          MAX(created_at) as newest_event
        FROM memory_events
      `).first<{ total: number; pending: number; dispatched: number; oldest_pending: number | null; newest_event: number | null }>();

      // Pending by session
      let sessionQuery = `
        SELECT session_id, COUNT(*) as event_count, MAX(created_at) as last_activity,
               MIN(created_at) as oldest_event
        FROM memory_events
        WHERE dispatched = 0
      `;
      const sessionBinds: string[] = [];
      if (sessionFilter) {
        sessionQuery += ' AND session_id = ?';
        sessionBinds.push(sessionFilter);
      }
      sessionQuery += ' GROUP BY session_id ORDER BY last_activity DESC';

      const sessionsResult = await ctx.env.DB.prepare(sessionQuery)
        .bind(...sessionBinds)
        .all<{ session_id: string; event_count: number; last_activity: number; oldest_event: number }>();

      // Event type distribution (pending only)
      const typeResult = await ctx.env.DB.prepare(`
        SELECT event_type, COUNT(*) as count
        FROM memory_events
        WHERE dispatched = 0
        GROUP BY event_type
        ORDER BY count DESC
      `).all<{ event_type: string; count: number }>();

      let text = '=== EVENT QUEUE STATUS ===\n\n';
      text += `Total Events: ${overallResult?.total || 0}\n`;
      text += `  Pending: ${overallResult?.pending || 0}\n`;
      text += `  Dispatched: ${overallResult?.dispatched || 0}\n`;
      if (overallResult?.oldest_pending) {
        text += `  Oldest pending: ${timeAgo(overallResult.oldest_pending)}\n`;
      }

      if (typeResult.results.length > 0) {
        text += '\nPending by Type:\n';
        for (const t of typeResult.results) {
          text += `  ${t.event_type}: ${t.count}\n`;
        }
      }

      const sessions = sessionsResult.results || [];
      if (sessions.length > 0) {
        text += `\nSessions with Pending Events (${sessions.length}):\n`;
        const now = Date.now();
        for (const s of sessions) {
          const inactive = now - s.last_activity > 300_000; // 5 min
          const stuckLabel = inactive ? ' ⚠️ STUCK' : '';
          text += `\n  [${s.session_id}] ${s.event_count} events${stuckLabel}\n`;
          text += `    Last activity: ${timeAgo(s.last_activity)}\n`;
          text += `    Oldest event: ${timeAgo(s.oldest_event)}\n`;
        }
      }

      // Detailed mode: show individual events
      if (detailLevel === 'detailed') {
        let eventsQuery = `
          SELECT id, session_id, event_type, memory_id, violated_by, damage_level, created_at
          FROM memory_events
          WHERE dispatched = 0
        `;
        const eventsBinds: string[] = [];
        if (sessionFilter) {
          eventsQuery += ' AND session_id = ?';
          eventsBinds.push(sessionFilter);
        }
        eventsQuery += ' ORDER BY created_at DESC LIMIT 50';

        const eventsResult = await ctx.env.DB.prepare(eventsQuery)
          .bind(...eventsBinds)
          .all<{ id: string; session_id: string; event_type: string; memory_id: string; violated_by: string | null; damage_level: string | null; created_at: number }>();

        if (eventsResult.results.length > 0) {
          text += '\nRecent Pending Events (max 50):\n';
          for (const e of eventsResult.results) {
            text += `\n  ${e.id} [${e.event_type}]\n`;
            text += `    Memory: ${e.memory_id}\n`;
            if (e.violated_by) text += `    Violated by: ${e.violated_by}\n`;
            if (e.damage_level) text += `    Damage: ${e.damage_level}\n`;
            text += `    Created: ${timeAgo(e.created_at)}\n`;
          }
        }
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // queue_purge - Clear stale events
  // ----------------------------------------
  defineTool({
    name: 'queue_purge',
    description: 'Delete stale or dispatched events from the queue. Modes: dispatched_only (safe cleanup), session (clear specific session), all_pending (nuclear). Dry-run by default.',
    annotations: {
      title: 'Purge Queue Events',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['dispatched_only', 'session', 'all_pending'],
          description: 'What to purge',
        },
        session_id: {
          type: 'string',
          description: 'Required if mode=session',
        },
        older_than_hours: {
          type: 'number',
          description: 'Only purge events older than N hours (default: 24)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview what would be deleted (default: true)',
        },
      },
      required: ['mode'],
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const mode = args.mode as string;
      const sessionId = args.session_id as string | undefined;
      const olderThanHours = (args.older_than_hours as number) || 24;
      const dryRun = args.dry_run !== false; // default true

      const cutoff = Date.now() - (olderThanHours * 3600_000);

      let countQuery: string;
      let deleteQuery: string;
      const binds: (string | number)[] = [];

      switch (mode) {
        case 'dispatched_only':
          countQuery = 'SELECT COUNT(*) as count FROM memory_events WHERE dispatched = 1 AND dispatched_at < ?';
          deleteQuery = 'DELETE FROM memory_events WHERE dispatched = 1 AND dispatched_at < ?';
          binds.push(cutoff);
          break;
        case 'session':
          if (!sessionId) return errorResult('session_id is required for mode=session');
          countQuery = 'SELECT COUNT(*) as count FROM memory_events WHERE session_id = ? AND created_at < ?';
          deleteQuery = 'DELETE FROM memory_events WHERE session_id = ? AND created_at < ?';
          binds.push(sessionId, cutoff);
          break;
        case 'all_pending':
          countQuery = 'SELECT COUNT(*) as count FROM memory_events WHERE dispatched = 0 AND created_at < ?';
          deleteQuery = 'DELETE FROM memory_events WHERE dispatched = 0 AND created_at < ?';
          binds.push(cutoff);
          break;
        default:
          return errorResult(`Invalid mode: ${mode}`);
      }

      const countResult = await ctx.env.DB.prepare(countQuery).bind(...binds)
        .first<{ count: number }>();
      const count = countResult?.count || 0;

      if (dryRun) {
        return textResult(`[DRY RUN] Would delete ${count} events (mode: ${mode}, older than ${olderThanHours}h)\n\nSet dry_run: false to execute.`);
      }

      if (count === 0) {
        return textResult(`No events match criteria (mode: ${mode}, older than ${olderThanHours}h)`);
      }

      await ctx.env.DB.prepare(deleteQuery).bind(...binds).run();

      return textResult(`Deleted ${count} events (mode: ${mode}, older than ${olderThanHours}h)`);
    },
  }),

  // ----------------------------------------
  // memory_state - Override memory state
  // ----------------------------------------
  defineTool({
    name: 'memory_state',
    description: 'Manually set a memory\'s state (active, confirmed, violated, resolved). Useful for fixing stuck memories or overriding incorrect auto-resolution. Triggers cascade propagation when appropriate.',
    annotations: {
      title: 'Override Memory State',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to update' },
        new_state: {
          type: 'string',
          enum: ['active', 'confirmed', 'violated', 'resolved'],
          description: 'Target state',
        },
        outcome: {
          type: 'string',
          enum: ['correct', 'incorrect', 'voided'],
          description: 'Required if new_state=resolved',
        },
        reason: { type: 'string', description: 'Explanation for state change (audit trail)' },
      },
      required: ['memory_id', 'new_state', 'reason'],
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const memoryId = args.memory_id as string;
      const newState = args.new_state as string;
      const outcome = args.outcome as string | undefined;
      const reason = args.reason as string;

      if (newState === 'resolved' && !outcome) {
        return errorResult('outcome is required when setting state to resolved');
      }

      // Fetch current memory
      const memory = await ctx.env.DB.prepare(
        'SELECT id, content, state, outcome, source, retracted FROM memories WHERE id = ?'
      ).bind(memoryId).first<{ id: string; content: string; state: string; outcome: string | null; source: string | null; retracted: number }>();

      if (!memory) return errorResult(`Memory not found: ${memoryId}`);
      if (memory.retracted) return errorResult(`Memory is retracted: ${memoryId}`);

      const oldState = memory.state;
      const now = Date.now();

      // Build update
      const updates: string[] = ['state = ?', 'updated_at = ?'];
      const values: (string | number | null)[] = [newState, now];

      if (newState === 'resolved') {
        updates.push('outcome = ?', 'resolved_at = ?');
        values.push(outcome!, now);
      } else if (newState === 'active') {
        // Reset outcome when reverting to active
        updates.push('outcome = NULL', 'resolved_at = NULL');
      }

      values.push(memoryId);
      await ctx.env.DB.prepare(
        `UPDATE memories SET ${updates.join(', ')} WHERE id = ?`
      ).bind(...values).run();

      // Clean up condition vectors if transitioning away from active
      if (newState !== 'active' && oldState === 'active') {
        await deleteConditionVectors(ctx.env, memoryId).catch(() => {});
      }

      let text = `Memory state updated\n\n`;
      text += `[${memoryId}] ${memory.content.slice(0, 100)}...\n`;
      text += `  Old state: ${oldState}\n`;
      text += `  New state: ${newState}${outcome ? ` (outcome: ${outcome})` : ''}\n`;
      text += `  Reason: ${reason}\n`;

      // Trigger cascade if resolving
      if (newState === 'resolved' && outcome) {
        try {
          const cascadeOutcome = outcome === 'correct' ? 'correct' : outcome === 'incorrect' ? 'incorrect' : 'void';
          await propagateResolution(ctx.env, memoryId, cascadeOutcome);
          text += '\nCascade propagation triggered.';
        } catch (err) {
          text += `\nCascade failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // condition_vectors_cleanup - Clean stale vectors
  // ----------------------------------------
  defineTool({
    name: 'condition_vectors_cleanup',
    description: 'Delete condition vectors (invalidates_if, confirms_if) from Vectorize for memories that are no longer active (violated, resolved, retracted). Prevents stale conditions from triggering future exposure checks.',
    annotations: {
      title: 'Cleanup Condition Vectors',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: {
          type: 'string',
          description: 'Clean specific memory ID (optional, omit for batch)',
        },
        batch_size: {
          type: 'number',
          description: 'How many memories to process (default: 50, max: 200)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview what would be cleaned (default: true)',
        },
      },
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const specificId = args.memory_id as string | undefined;
      const batchSize = Math.min((args.batch_size as number) || 50, 200);
      const dryRun = args.dry_run !== false;

      let query: string;
      const binds: (string | number)[] = [];

      if (specificId) {
        query = `SELECT id, content, invalidates_if, confirms_if, state, retracted
                 FROM memories WHERE id = ?`;
        binds.push(specificId);
      } else {
        query = `SELECT id, content, invalidates_if, confirms_if, state, retracted
                 FROM memories
                 WHERE (state IN ('resolved', 'violated', 'confirmed') OR retracted = 1)
                   AND (invalidates_if IS NOT NULL OR confirms_if IS NOT NULL)
                 LIMIT ?`;
        binds.push(batchSize);
      }

      const result = await ctx.env.DB.prepare(query).bind(...binds)
        .all<{ id: string; content: string; invalidates_if: string | null; confirms_if: string | null; state: string; retracted: number }>();

      const memories = result.results || [];
      if (memories.length === 0) {
        return textResult('No memories found needing condition vector cleanup.');
      }

      let totalInvalidates = 0;
      let totalConfirms = 0;
      const details: string[] = [];

      for (const m of memories) {
        const invCount = m.invalidates_if ? JSON.parse(m.invalidates_if).length : 0;
        const confCount = m.confirms_if ? JSON.parse(m.confirms_if).length : 0;
        totalInvalidates += invCount;
        totalConfirms += confCount;

        if (!dryRun) {
          await deleteConditionVectors(ctx.env, m.id, invCount || 10, confCount || 10);
        }

        details.push(`  [${m.id}] ${m.state}${m.retracted ? ' (retracted)' : ''} — ${invCount} inv, ${confCount} conf vectors`);
      }

      let text = dryRun ? '=== CONDITION VECTORS CLEANUP (DRY RUN) ===\n\n' : '=== CONDITION VECTORS CLEANUP ===\n\n';
      text += `Memories scanned: ${memories.length}\n`;
      text += `Vectors to ${dryRun ? 'clean' : 'cleaned'}:\n`;
      text += `  INVALIDATES_VECTORS: ${totalInvalidates}\n`;
      text += `  CONFIRMS_VECTORS: ${totalConfirms}\n`;
      text += `\nDetails:\n${details.join('\n')}`;

      if (dryRun) {
        text += '\n\nSet dry_run: false to execute.';
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // system_diagnostics - Health dashboard
  // ----------------------------------------
  defineTool({
    name: 'system_diagnostics',
    description: 'System health overview: memory state distribution, exposure check status, event queue health, system stats, edge counts, and graph metrics.',
    annotations: {
      title: 'System Diagnostics',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        include_samples: {
          type: 'boolean',
          description: 'Include sample memories from each state category (default: false)',
        },
      },
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const includeSamples = args.include_samples === true;

      // Memory state distribution
      const stateResult = await ctx.env.DB.prepare(`
        SELECT state, COUNT(*) as count
        FROM memories WHERE retracted = 0
        GROUP BY state
      `).all<{ state: string; count: number }>();

      // Retracted count
      const retractedResult = await ctx.env.DB.prepare(
        'SELECT COUNT(*) as count FROM memories WHERE retracted = 1'
      ).first<{ count: number }>();

      // Type distribution
      const typeResult = await ctx.env.DB.prepare(`
        SELECT
          SUM(CASE WHEN source IS NOT NULL THEN 1 ELSE 0 END) as observations,
          SUM(CASE WHEN derived_from IS NOT NULL AND resolves_by IS NULL THEN 1 ELSE 0 END) as thoughts,
          SUM(CASE WHEN resolves_by IS NOT NULL THEN 1 ELSE 0 END) as predictions
        FROM memories WHERE retracted = 0
      `).first<{ observations: number; thoughts: number; predictions: number }>();

      // Exposure check status
      const exposureResult = await ctx.env.DB.prepare(`
        SELECT exposure_check_status, COUNT(*) as count
        FROM memories WHERE retracted = 0
        GROUP BY exposure_check_status
      `).all<{ exposure_check_status: string | null; count: number }>();

      // Edge counts
      const edgeResult = await ctx.env.DB.prepare(`
        SELECT edge_type, COUNT(*) as count
        FROM edges
        GROUP BY edge_type
      `).all<{ edge_type: string; count: number }>();

      const totalEdges = (edgeResult.results || []).reduce((sum, e) => sum + e.count, 0);

      // Event queue
      const queueResult = await ctx.env.DB.prepare(`
        SELECT
          SUM(CASE WHEN dispatched = 0 THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN dispatched = 1 THEN 1 ELSE 0 END) as dispatched,
          COUNT(DISTINCT CASE WHEN dispatched = 0 THEN session_id END) as active_sessions
        FROM memory_events
      `).first<{ pending: number; dispatched: number; active_sessions: number }>();

      // Stuck sessions (inactive > 5 min with pending events)
      const stuckResult = await ctx.env.DB.prepare(`
        SELECT COUNT(DISTINCT session_id) as count
        FROM memory_events
        WHERE dispatched = 0
        GROUP BY session_id
        HAVING MAX(created_at) < ?
      `).bind(Date.now() - 300_000).all<{ count: number }>();

      // System stats
      const statsResult = await ctx.env.DB.prepare(
        'SELECT key, value, updated_at FROM system_stats ORDER BY key'
      ).all<{ key: string; value: number; updated_at: number }>();

      // Brittle memories (low times_tested)
      const brittleResult = await ctx.env.DB.prepare(
        'SELECT COUNT(*) as count FROM memories WHERE retracted = 0 AND times_tested < 3'
      ).first<{ count: number }>();

      // Orphan memories (no edges at all)
      const orphanResult = await ctx.env.DB.prepare(`
        SELECT COUNT(*) as count FROM memories m
        WHERE m.retracted = 0
          AND m.derived_from IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id = m.id OR e.target_id = m.id)
      `).first<{ count: number }>();

      // Build output
      const totalActive = (stateResult.results || []).reduce((sum, s) => sum + s.count, 0);
      let text = '=== SYSTEM DIAGNOSTICS ===\n\n';

      // Memory counts
      text += `Memories: ${totalActive} active + ${retractedResult?.count || 0} retracted\n`;
      text += `  Observations: ${typeResult?.observations || 0}\n`;
      text += `  Thoughts: ${typeResult?.thoughts || 0}\n`;
      text += `  Predictions: ${typeResult?.predictions || 0}\n\n`;

      // State distribution
      text += 'State Distribution:\n';
      for (const s of (stateResult.results || [])) {
        const pct = totalActive > 0 ? Math.round(s.count / totalActive * 100) : 0;
        text += `  ${s.state}: ${s.count} (${pct}%)\n`;
      }

      // Exposure check status
      text += '\nExposure Check Status:\n';
      for (const e of (exposureResult.results || [])) {
        text += `  ${e.exposure_check_status || 'null'}: ${e.count}\n`;
      }

      // Graph health
      text += `\nGraph:\n`;
      text += `  Total edges: ${totalEdges}\n`;
      for (const e of (edgeResult.results || [])) {
        text += `    ${e.edge_type}: ${e.count}\n`;
      }
      text += `  Orphan thoughts: ${orphanResult?.count || 0}\n`;
      text += `  Brittle (< 3 tests): ${brittleResult?.count || 0}\n`;

      // Event queue
      text += `\nEvent Queue:\n`;
      text += `  Pending: ${queueResult?.pending || 0}\n`;
      text += `  Dispatched: ${queueResult?.dispatched || 0}\n`;
      text += `  Active sessions: ${queueResult?.active_sessions || 0}\n`;
      text += `  Stuck sessions: ${stuckResult.results?.length || 0}\n`;

      // System stats
      if (statsResult.results && statsResult.results.length > 0) {
        text += '\nSystem Stats:\n';
        for (const s of statsResult.results) {
          const val = s.key.includes('confidence') ? `${Math.round(s.value * 100)}%` : String(Math.round(s.value * 100) / 100);
          text += `  ${s.key}: ${val} (updated ${formatTs(s.updated_at)})\n`;
        }
      }

      // Optional: sample memories from each state
      if (includeSamples) {
        for (const s of (stateResult.results || [])) {
          const samples = await ctx.env.DB.prepare(
            'SELECT id, content FROM memories WHERE state = ? AND retracted = 0 LIMIT 3'
          ).bind(s.state).all<{ id: string; content: string }>();

          if (samples.results && samples.results.length > 0) {
            text += `\nSample ${s.state} memories:\n`;
            for (const m of samples.results) {
              text += `  [${m.id}] ${m.content.slice(0, 80)}...\n`;
            }
          }
        }
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // force_dispatch - Manually trigger dispatch
  // ----------------------------------------
  defineTool({
    name: 'force_dispatch',
    description: 'View pending events for a session. Shows what would be dispatched if the inactivity timer triggers.',
    annotations: {
      title: 'View Session Events',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_id: { type: 'string', description: 'Session ID to inspect' },
      },
      required: ['session_id'],
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const sessionId = args.session_id as string;

      const result = await ctx.env.DB.prepare(`
        SELECT id, event_type, memory_id, violated_by, damage_level, context, created_at
        FROM memory_events
        WHERE session_id = ? AND dispatched = 0
        ORDER BY created_at
      `).bind(sessionId).all<{
        id: string; event_type: string; memory_id: string;
        violated_by: string | null; damage_level: string | null;
        context: string; created_at: number;
      }>();

      const events = result.results || [];
      if (events.length === 0) {
        return textResult(`No pending events for session: ${sessionId}`);
      }

      let text = `=== PENDING EVENTS FOR SESSION ${sessionId} ===\n`;
      text += `Total: ${events.length} events\n\n`;

      // Group by type
      const byType: Record<string, typeof events> = {};
      for (const e of events) {
        if (!byType[e.event_type]) byType[e.event_type] = [];
        byType[e.event_type].push(e);
      }

      for (const [type, typeEvents] of Object.entries(byType)) {
        text += `${type} (${typeEvents.length}):\n`;
        for (const e of typeEvents) {
          text += `  ${e.id} — memory: ${e.memory_id}`;
          if (e.violated_by) text += ` violated_by: ${e.violated_by}`;
          if (e.damage_level) text += ` [${e.damage_level}]`;
          text += ` (${timeAgo(e.created_at)})\n`;
        }
        text += '\n';
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // graph_health - Find graph anomalies
  // ----------------------------------------
  defineTool({
    name: 'graph_health',
    description: 'Find graph anomalies: orphan edges (pointing to deleted memories), duplicate edges, memories with broken derived_from references.',
    annotations: {
      title: 'Graph Health Check',
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        check: {
          type: 'string',
          enum: ['orphan_edges', 'broken_derivations', 'duplicate_edges', 'all'],
          description: 'Which anomaly to check for (default: all)',
        },
      },
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const check = (args.check as string) || 'all';
      let text = '=== GRAPH HEALTH CHECK ===\n\n';

      // Orphan edges
      if (check === 'orphan_edges' || check === 'all') {
        const orphanEdges = await ctx.env.DB.prepare(`
          SELECT e.id, e.source_id, e.target_id, e.edge_type
          FROM edges e
          LEFT JOIN memories ms ON e.source_id = ms.id
          LEFT JOIN memories mt ON e.target_id = mt.id
          WHERE ms.id IS NULL OR mt.id IS NULL
          LIMIT 50
        `).all<{ id: string; source_id: string; target_id: string; edge_type: string }>();

        text += `Orphan Edges: ${orphanEdges.results?.length || 0}\n`;
        for (const e of (orphanEdges.results || [])) {
          text += `  ${e.id}: ${e.source_id} --[${e.edge_type}]--> ${e.target_id}\n`;
        }
        text += '\n';
      }

      // Broken derivations
      if (check === 'broken_derivations' || check === 'all') {
        // Find thoughts whose derived_from references don't exist
        const thoughts = await ctx.env.DB.prepare(`
          SELECT id, content, derived_from
          FROM memories
          WHERE derived_from IS NOT NULL AND retracted = 0
          LIMIT 200
        `).all<{ id: string; content: string; derived_from: string }>();

        let brokenCount = 0;
        const brokenDetails: string[] = [];
        for (const t of (thoughts.results || [])) {
          try {
            const refs: string[] = JSON.parse(t.derived_from);
            for (const ref of refs) {
              const exists = await ctx.env.DB.prepare(
                'SELECT id FROM memories WHERE id = ? AND retracted = 0'
              ).bind(ref).first<{ id: string }>();
              if (!exists) {
                brokenCount++;
                brokenDetails.push(`  [${t.id}] references missing [${ref}]`);
                if (brokenDetails.length >= 20) break;
              }
            }
          } catch { /* skip malformed JSON */ }
          if (brokenDetails.length >= 20) break;
        }

        text += `Broken Derivations: ${brokenCount}${brokenCount >= 20 ? '+' : ''}\n`;
        for (const d of brokenDetails) {
          text += d + '\n';
        }
        text += '\n';
      }

      // Duplicate edges
      if (check === 'duplicate_edges' || check === 'all') {
        const dupes = await ctx.env.DB.prepare(`
          SELECT source_id, target_id, edge_type, COUNT(*) as count
          FROM edges
          GROUP BY source_id, target_id, edge_type
          HAVING count > 1
          LIMIT 50
        `).all<{ source_id: string; target_id: string; edge_type: string; count: number }>();

        text += `Duplicate Edges: ${dupes.results?.length || 0}\n`;
        for (const d of (dupes.results || [])) {
          text += `  ${d.source_id} --[${d.edge_type}]--> ${d.target_id} (${d.count}x)\n`;
        }
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // bulk_retract - Retract memory + descendants
  // ----------------------------------------
  defineTool({
    name: 'bulk_retract',
    description: 'Retract a memory and optionally cascade retraction to all derived descendants. Removes condition vectors and marks as retracted.',
    annotations: {
      title: 'Bulk Retract',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: { type: 'string', description: 'Memory ID to retract' },
        reason: { type: 'string', description: 'Retraction reason' },
        cascade: {
          type: 'boolean',
          description: 'Also retract all downstream thoughts derived from this memory (default: false)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview what would be retracted (default: true)',
        },
      },
      required: ['memory_id', 'reason'],
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const memoryId = args.memory_id as string;
      const reason = args.reason as string;
      const cascade = args.cascade === true;
      const dryRun = args.dry_run !== false;

      // Verify memory exists
      const memory = await ctx.env.DB.prepare(
        'SELECT id, content, retracted FROM memories WHERE id = ?'
      ).bind(memoryId).first<{ id: string; content: string; retracted: number }>();

      if (!memory) return errorResult(`Memory not found: ${memoryId}`);
      if (memory.retracted) return errorResult(`Memory already retracted: ${memoryId}`);

      // Collect IDs to retract
      const toRetract = [memoryId];

      if (cascade) {
        // Walk derivation graph downward
        const visited = new Set([memoryId]);
        const queue = [memoryId];

        while (queue.length > 0) {
          const currentId = queue.shift()!;
          // Find thoughts that derive from this memory
          const descendants = await ctx.env.DB.prepare(`
            SELECT id FROM memories
            WHERE derived_from LIKE ? AND retracted = 0
          `).bind(`%${currentId}%`).all<{ id: string }>();

          for (const d of (descendants.results || [])) {
            if (!visited.has(d.id)) {
              visited.add(d.id);
              toRetract.push(d.id);
              queue.push(d.id);
            }
          }
        }
      }

      if (dryRun) {
        let text = `[DRY RUN] Would retract ${toRetract.length} memor${toRetract.length === 1 ? 'y' : 'ies'}:\n\n`;
        for (const id of toRetract.slice(0, 20)) {
          const m = await ctx.env.DB.prepare('SELECT content FROM memories WHERE id = ?')
            .bind(id).first<{ content: string }>();
          text += `  [${id}] ${(m?.content || '').slice(0, 80)}...\n`;
        }
        if (toRetract.length > 20) text += `  ... and ${toRetract.length - 20} more\n`;
        text += `\nReason: ${reason}\nSet dry_run: false to execute.`;
        return textResult(text);
      }

      // Execute retraction
      const now = Date.now();
      for (const id of toRetract) {
        await ctx.env.DB.prepare(`
          UPDATE memories SET retracted = 1, retracted_at = ?, retraction_reason = ?, updated_at = ?
          WHERE id = ?
        `).bind(now, reason, now, id).run();

        // Clean up vectors
        await deleteConditionVectors(ctx.env, id).catch(() => {});
      }

      return textResult(`Retracted ${toRetract.length} memor${toRetract.length === 1 ? 'y' : 'ies'}.\n\nReason: ${reason}`);
    },
  }),

  // ----------------------------------------
  // re_evaluate_violations - Re-check false violations with improved LLM judge
  // ----------------------------------------
  defineTool({
    name: 're_evaluate_violations',
    description: 'Re-evaluate violated memories using the current LLM judge (gpt-5-mini + improved prompts). Identifies false positive violations and optionally clears them, restoring memories to active state. Use after prompt improvements or model upgrades to clean up historical false violations.',
    annotations: {
      title: 'Re-evaluate Violations',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        memory_id: {
          type: 'string',
          description: 'Re-evaluate a specific memory ID (optional, omit for batch)',
        },
        batch_size: {
          type: 'number',
          description: 'How many violated memories to process (default: 10, max: 50)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview results without modifying state (default: true)',
        },
        confidence_threshold: {
          type: 'number',
          description: 'Minimum confidence to keep a violation as valid (default: 0.7)',
        },
      },
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const memoryId = args.memory_id as string | undefined;
      const batchSize = Math.min((args.batch_size as number) || 10, 50);
      const dryRun = args.dry_run !== false; // default true
      const confidenceThreshold = (args.confidence_threshold as number) || 0.7;

      // Check LLM judge is configured
      if (!ctx.env.LLM_JUDGE_URL) {
        return errorResult('LLM_JUDGE_URL not configured. Cannot re-evaluate without LLM judge.');
      }

      // Fetch violated memories
      let violatedMemories: Array<{
        id: string;
        content: string;
        violations: string;
        contradictions: number;
        times_tested: number;
        state: string;
      }>;

      if (memoryId) {
        const row = await ctx.env.DB.prepare(
          `SELECT id, content, violations, contradictions, times_tested, state
           FROM memories WHERE id = ? AND retracted = 0`
        ).bind(memoryId).first();
        violatedMemories = row ? [row as typeof violatedMemories[0]] : [];
      } else {
        // Order by updated_at ASC so recently re-evaluated (kept) violations
        // don't keep appearing at the top of every batch
        const oneHourAgo = Date.now() - 3600_000;
        const result = await ctx.env.DB.prepare(
          `SELECT id, content, violations, contradictions, times_tested, state
           FROM memories
           WHERE state = 'violated' AND retracted = 0
             AND updated_at < ?
           ORDER BY updated_at ASC
           LIMIT ?`
        ).bind(oneHourAgo, batchSize).all();
        violatedMemories = (result.results || []) as typeof violatedMemories;
      }

      if (violatedMemories.length === 0) {
        return textResult('No violated memories found to re-evaluate.');
      }

      let text = `${dryRun ? '[DRY RUN] ' : ''}Re-evaluating ${violatedMemories.length} violated memor${violatedMemories.length === 1 ? 'y' : 'ies'}...\n\n`;

      let cleared = 0;
      let kept = 0;
      let errors = 0;

      for (const memory of violatedMemories) {
        const violations: Violation[] = JSON.parse(memory.violations || '[]');
        if (violations.length === 0) {
          text += `[${memory.id}] No violations in array (state mismatch) — ${dryRun ? 'would clear' : 'clearing'} state\n`;
          if (!dryRun) {
            await ctx.env.DB.prepare(
              `UPDATE memories SET state = 'active', updated_at = ? WHERE id = ?`
            ).bind(Date.now(), memory.id).run();
          }
          cleared++;
          continue;
        }

        text += `--- [${memory.id}] ${memory.content.slice(0, 80)}... ---\n`;

        // Re-evaluate each violation in this memory
        const keptViolations: Violation[] = [];
        const clearedViolations: Violation[] = [];

        for (const violation of violations) {
          try {
            // Fetch the triggering observation
            const obs = await ctx.env.DB.prepare(
              'SELECT content FROM memories WHERE id = ?'
            ).bind(violation.obs_id).first<{ content: string }>();

            if (!obs) {
              text += `  [SKIP] obs ${violation.obs_id} not found — keeping violation\n`;
              keptViolations.push(violation);
              continue;
            }

            // Build prompt based on violation source type
            const prompt = buildInvalidatesIfPrompt(
              obs.content,
              violation.condition,
              memory.content
            );

            // Call LLM judge
            const responseText = await callExternalLLM(
              ctx.env.LLM_JUDGE_URL!,
              prompt,
              { apiKey: ctx.env.LLM_JUDGE_API_KEY, model: ctx.env.LLM_JUDGE_MODEL }
            );

            const result = parseConditionResponse(responseText);

            if (result.matches && result.confidence >= confidenceThreshold) {
              // Violation is still valid
              keptViolations.push(violation);
              text += `  [KEEP] "${violation.condition}" — matches=${result.matches} conf=${result.confidence.toFixed(2)} — ${result.reasoning?.slice(0, 100) || ''}\n`;
            } else {
              // False positive!
              clearedViolations.push(violation);
              text += `  [CLEAR] "${violation.condition}" — matches=${result.matches} conf=${result.confidence.toFixed(2)} — ${result.reasoning?.slice(0, 100) || ''}\n`;
            }
          } catch (err) {
            text += `  [ERROR] "${violation.condition}" — ${err instanceof Error ? err.message : String(err)}\n`;
            keptViolations.push(violation); // keep on error (conservative)
            errors++;
          }
        }

        // Apply changes if not dry run
        if (clearedViolations.length > 0 && !dryRun) {
          const now = Date.now();
          const contradictionsRemoved = clearedViolations.length;
          const newContradictions = Math.max(0, memory.contradictions - contradictionsRemoved);

          if (keptViolations.length === 0) {
            // All violations cleared — restore to active
            await ctx.env.DB.prepare(
              `UPDATE memories
               SET violations = '[]',
                   contradictions = ?,
                   state = 'active',
                   updated_at = ?
               WHERE id = ?`
            ).bind(newContradictions, now, memory.id).run();

            // Remove violated_by edges for cleared violations
            for (const v of clearedViolations) {
              await ctx.env.DB.prepare(
                `DELETE FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = 'violated_by'`
              ).bind(v.obs_id, memory.id).run();
            }
          } else {
            // Some violations remain — keep violated state but update violations array
            await ctx.env.DB.prepare(
              `UPDATE memories
               SET violations = ?,
                   contradictions = ?,
                   updated_at = ?
               WHERE id = ?`
            ).bind(JSON.stringify(keptViolations), newContradictions, now, memory.id).run();

            // Remove edges for cleared violations only
            for (const v of clearedViolations) {
              await ctx.env.DB.prepare(
                `DELETE FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = 'violated_by'`
              ).bind(v.obs_id, memory.id).run();
            }
          }
        }

        if (clearedViolations.length > 0) cleared++;
        if (keptViolations.length > 0) kept++;
        text += '\n';
      }

      text += `\n--- Summary ---\n`;
      text += `Memories with false positives cleared: ${cleared}\n`;
      text += `Memories with valid violations kept: ${kept}\n`;
      text += `Errors: ${errors}\n`;
      if (dryRun) {
        text += `\nThis was a DRY RUN. Set dry_run: false to apply changes.`;
      }

      return textResult(text);
    },
  }),

  // ----------------------------------------
  // backfill_surprise - Fan-out surprise calculation
  // ----------------------------------------
  defineTool({
    name: 'backfill_surprise',
    description: 'Backfill surprise scores for all existing memories that have NULL surprise. Fans out N parallel workers, each processing a slice of memories. Safe to re-run — skips memories that already have a surprise score.',
    annotations: {
      title: 'Backfill Surprise Scores',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object' as const,
      properties: {
        parallelism: {
          type: 'number',
          description: 'Number of parallel workers (default: 10, max: 20)',
        },
        batch_size: {
          type: 'number',
          description: 'Total memories to process this run (default: 200, max: 1500)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview count without processing (default: false)',
        },
      },
    },
    handler: async (args: Record<string, unknown>, ctx: ToolContext<Env>) => {
      const parallelism = Math.min((args.parallelism as number) || 10, 20);
      const batchSize = Math.min((args.batch_size as number) || 200, 1500);
      const dryRun = args.dry_run === true;

      // Count remaining
      const countResult = await ctx.env.DB.prepare(
        `SELECT COUNT(*) as total FROM memories WHERE retracted = 0 AND surprise IS NULL`
      ).first<{ total: number }>();
      const remaining = countResult?.total || 0;

      if (remaining === 0) {
        return textResult('All memories already have surprise scores. Nothing to backfill.');
      }

      const toProcess = Math.min(batchSize, remaining);

      if (dryRun) {
        return textResult(`[DRY RUN] ${remaining} memories need surprise backfill.\nWould process ${toProcess} in ${parallelism} parallel workers (${Math.ceil(toProcess / parallelism)} each).`);
      }

      // Fetch IDs to process
      const rows = await ctx.env.DB.prepare(
        `SELECT id FROM memories WHERE retracted = 0 AND surprise IS NULL ORDER BY created_at ASC LIMIT ?`
      ).bind(toProcess).all<{ id: string }>();

      const ids = (rows.results || []).map(r => r.id);
      if (ids.length === 0) {
        return textResult('No memories to backfill.');
      }

      // Split into N slices
      const slices: string[][] = Array.from({ length: parallelism }, () => []);
      for (let i = 0; i < ids.length; i++) {
        slices[i % parallelism].push(ids[i]);
      }

      // Track failure reasons
      const failureReasons: Record<string, string[]> = {
        no_vector: [],
        empty_values: [],
        compute_error: [],
      };

      // Worker function: processes a slice sequentially
      async function processSlice(sliceIds: string[]): Promise<{ computed: number; failed: number }> {
        let computed = 0;
        let failed = 0;

        for (const id of sliceIds) {
          try {
            // Get embedding from Vectorize
            const vectors = await ctx.env.MEMORY_VECTORS.getByIds([id]);
            if (!vectors || vectors.length === 0) {
              failed++;
              if (failureReasons.no_vector.length < 5) failureReasons.no_vector.push(id);
              continue;
            }
            if (!vectors[0].values?.length) {
              failed++;
              if (failureReasons.empty_values.length < 5) failureReasons.empty_values.push(id);
              continue;
            }

            const embedding: number[] = Array.isArray(vectors[0].values)
              ? vectors[0].values
              : [...vectors[0].values] as number[];

            const surprise = await computeSurprise(ctx.env, id, embedding);

            await ctx.env.DB.prepare(
              'UPDATE memories SET surprise = ?, updated_at = ? WHERE id = ?'
            ).bind(surprise, Date.now(), id).run();

            computed++;
          } catch (err) {
            failed++;
            if (failureReasons.compute_error.length < 5) {
              failureReasons.compute_error.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        return { computed, failed };
      }

      // Fan out N workers in parallel
      const results = await Promise.all(
        slices.filter(s => s.length > 0).map(processSlice)
      );

      const totalComputed = results.reduce((sum, r) => sum + r.computed, 0);
      const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
      const stillRemaining = remaining - totalComputed;

      let text = `=== SURPRISE BACKFILL COMPLETE ===\n\n`;
      text += `Computed: ${totalComputed}\n`;
      text += `Failed: ${totalFailed}\n`;
      text += `Remaining: ${stillRemaining}\n`;
      text += `Workers: ${slices.filter(s => s.length > 0).length} (parallelism: ${parallelism})\n`;

      if (totalFailed > 0) {
        text += `\n--- Failure Breakdown ---\n`;
        if (failureReasons.no_vector.length > 0) {
          text += `No vector in Vectorize (${failureReasons.no_vector.length} samples): ${failureReasons.no_vector.join(', ')}\n`;
        }
        if (failureReasons.empty_values.length > 0) {
          text += `Empty embedding values (${failureReasons.empty_values.length} samples): ${failureReasons.empty_values.join(', ')}\n`;
        }
        if (failureReasons.compute_error.length > 0) {
          text += `Compute errors (${failureReasons.compute_error.length} samples):\n`;
          for (const e of failureReasons.compute_error) text += `  ${e}\n`;
        }
      }

      if (stillRemaining > 0) {
        text += `\nRun again to process the next batch.`;
      }

      return textResult(text);
    },
  }),

]);


// ============================================
// Admin MCP Router
// ============================================

const adminMcpRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

adminMcpRouter.post('/', async (c) => {
  const body = await c.req.text();
  const parsed = parseJsonRpcRequest(body);

  if ('error' in parsed) {
    return c.json(parsed.error);
  }

  const toolRegistry = createAdminTools();

  const context: ToolContext<Env> = {
    userEmail: c.get('cfAccessEmail') || c.req.header('CF-Access-Authenticated-User-Email') || 'admin',
    env: c.env,
    sessionId: c.get('sessionId'),
  };

  const response = await handleMcpMessage(
    parsed.request,
    {
      name: 'pantainos-memory-admin',
      version: '1.0.0',
      toolRegistry,
    },
    context
  );

  if (response === null) {
    return c.body(null, 204);
  }

  return c.json(response);
});

adminMcpRouter.get('/.well-known/oauth-protected-resource', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  });
});

export default adminMcpRouter;
