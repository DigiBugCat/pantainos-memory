/**
 * Reasoning Zones — Pure Functions
 *
 * Extracted from mcp.ts for testability.
 * Implements zone scoring (Nikooroo & Engel, Section V-A)
 * and zone formatting.
 */

import { getDisplayType } from './shared/types/index.js';

// Re-use the Memory type from transforms
import type { Memory } from './shared/types/memory.js';

// ============================================
// Zone Types
// ============================================

export interface ZoneParams {
  seedId: string;
  query?: string;
  zoneMembers: Memory[];
  semanticMemberIds: Set<string>;
  internalEdges: Array<{ source_id: string; target_id: string; edge_type: string; strength: number }>;
  boundary: Array<{ memory: Memory; reasons: string[] }>;
  cutMinusEdges: Array<{ source_id: string; target_id: string; edge_type: 'violated_by' }>;
  lossPlusEdges: Array<{ source_id: string; target_id: string; edge_type: 'derived_from' | 'confirmed_by' }>;
  unsafeReasons: string[];
}

export interface SafetyRow {
  id: string;
  state: string;
  outcome: string | null;
  retracted: number;
  violations: string | null;
  times_tested: number;
  confirmations: number;
}

// ============================================
// Pure Functions
// ============================================

export function truncate(text: string, max: number): string {
  const trimmed = (text || '').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}

export function formatConfidence(m: { confirmations?: number; times_tested?: number }): string {
  const times = m.times_tested ?? 0;
  const confs = m.confirmations ?? 0;
  if (times <= 0) return 'untested';
  const pct = Math.round((confs / times) * 100);
  return `${pct}% (${confs}/${times})`;
}

/**
 * Parse violation count from JSON string.
 */
export function parseViolationCount(violations: string | null | undefined): number {
  if (!violations) return 0;
  try {
    const arr = JSON.parse(violations);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Check if a memory is overwhelmingly violated (survival rate < 50%).
 * Memories with some violations but decent survival are still included in zones.
 */
export function isOverwhelminglyViolated(r: SafetyRow): boolean {
  const violations = parseViolationCount(r.violations);
  if (violations === 0) return false;
  if (r.confirmations === 0) return true; // violations with no confirmations
  return r.times_tested > 0 && (r.confirmations / r.times_tested) < 0.5;
}

/**
 * Compute zone quality score (adapted from Nikooroo & Engel, Section V-A).
 * S(Z) = mean(confidence) - λ·cut-(Z)/|Z| - ρ·loss+(Z)/|Z|
 * Where cut- = boundary contradiction flow, loss+ = external support leakage.
 */
export function scoreZone(
  zoneMembers: Memory[],
  cutMinusCount: number,
  lossPlusCount: number
): number {
  if (zoneMembers.length === 0) return 0;
  const meanConf = zoneMembers.reduce((s, m) => {
    const earned = m.times_tested > 0 ? m.confirmations / m.times_tested : m.starting_confidence;
    return s + earned;
  }, 0) / zoneMembers.length;

  const lambda = 0.2; // contradiction penalty weight
  const rho = 0.1;    // support leakage penalty weight
  const n = zoneMembers.length;
  return Math.max(0, Math.min(1, meanConf - lambda * cutMinusCount / n - rho * lossPlusCount / n));
}

/**
 * Add a reason to the boundary reasons map.
 */
export function addBoundaryReason(map: Map<string, Set<string>>, id: string, reason: string): void {
  if (!map.has(id)) map.set(id, new Set());
  map.get(id)!.add(reason);
}

/**
 * Format a reasoning zone for MCP text output.
 */
export function formatZone(params: ZoneParams): string {
  const {
    seedId,
    query,
    zoneMembers,
    semanticMemberIds,
    internalEdges,
    boundary,
    cutMinusEdges,
    lossPlusEdges,
    unsafeReasons,
  } = params;

  const safe = unsafeReasons.length === 0;
  const status = safe ? 'consistent' : 'unsafe';
  const quality = scoreZone(zoneMembers, cutMinusEdges.length, lossPlusEdges.length);
  const qualityPct = Math.round(quality * 100);

  let text = `=== REASONING ZONE === (seed: [${seedId}])\n`;
  if (query) text += `query: "${query}"\n`;
  text += `${zoneMembers.length} memories | ${status} | quality: ${qualityPct}% | ${boundary.length} boundary\n`;
  text += `boundary contradictions (cut-): ${cutMinusEdges.length}\n`;
  text += `external support dependency (loss+): ${lossPlusEdges.length}\n\n`;

  text += `--- ZONE MEMBERS ---\n`;
  if (zoneMembers.length === 0) {
    text += '(none)\n';
  } else {
    const lines = zoneMembers.map((m, i) => {
      const type = getDisplayType(m);
      const semantic = semanticMemberIds.has(m.id) ? ' (semantic)' : '';
      return `${i + 1}. [${m.id}] ${truncate(m.content, 120)}\n   ${type} | ${m.state} | ${formatConfidence(m)}${semantic}`;
    });
    text += `${lines.join('\n\n')}\n`;
  }

  text += `\n--- EDGES (within zone) ---\n`;
  if (internalEdges.length === 0) {
    text += '(none)\n';
  } else {
    const edgeLines = internalEdges.map(e => {
      const str = e.strength < 1.0 ? ` (${e.strength.toFixed(2)})` : '';
      return `  [${e.source_id}] --${e.edge_type}${str}--> [${e.target_id}]`;
    });
    text += `${edgeLines.join('\n')}\n`;
  }

  text += `\n--- BOUNDARY ---\n`;
  if (boundary.length === 0) {
    text += '(none)\n';
  } else {
    for (const item of boundary) {
      text += `[${item.memory.id}] ${truncate(item.memory.content, 120)}\n`;
      for (const reason of item.reasons) {
        text += `  - ${reason}\n`;
      }
      text += '\n';
    }
    text = text.trimEnd() + '\n';
  }

  text += `\n--- BOUNDARY FLOWS ---\n`;
  text += `cut- (contradiction crossings):\n`;
  if (cutMinusEdges.length === 0) {
    text += '  (none)\n';
  } else {
    for (const e of cutMinusEdges) {
      text += `  [${e.source_id}] --violated_by--> [${e.target_id}]\n`;
    }
  }

  text += `loss+ (external support crossings):\n`;
  if (lossPlusEdges.length === 0) {
    text += '  (none)\n';
  } else {
    for (const e of lossPlusEdges) {
      text += `  [${e.source_id}] --${e.edge_type}--> [${e.target_id}]\n`;
    }
  }

  text += '\n';
  if (safe) {
    text += 'Zone is safe for inference: all members are mutually consistent under violated_by + state/outcome/violations gate.';
  } else {
    text += `Zone is NOT safe for inference: ${unsafeReasons.join('; ')}`;
  }

  return text.trimEnd();
}
