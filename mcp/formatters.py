"""Human-readable formatting for MCP tool responses.

Ports the formatting logic from src/routes/mcp.ts so tool output is
compact and scannable rather than raw JSON dumps.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any


def _outcome_icon(state: str | None, outcome: str | None = None) -> str:
    if state == "resolved":
        if outcome == "incorrect":
            return " ❌"
        if outcome == "superseded":
            return " ⏰"
        if outcome == "correct":
            return " ✅"
        if outcome == "voided":
            return " 🚫"
    if state == "violated":
        return " ⚠️"
    if state == "confirmed":
        return " ✓"
    return ""


def _resolves_by(ts: int | float | None) -> str:
    if ts is None:
        return "no deadline"
    ms = ts * 1000 if ts < 1e12 else ts
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _pct(value: float | int) -> int:
    return round(value * 100) if value <= 1 else round(value)


# ── Per-tool formatters ──────────────────────────────────────────────────────


def fmt_find(data: dict[str, Any]) -> str:
    results = data.get("results", [])
    query = data.get("query", "")
    if not results:
        return f'No results for "{query}"'

    lines: list[str] = []
    for i, r in enumerate(results, 1):
        m = r.get("memory", {})
        content = m.get("content", "")[:80]
        sim = _pct(r.get("similarity", 0))
        conf = _pct(r.get("confidence", 0))
        icon = _outcome_icon(m.get("state"), m.get("outcome"))
        surp = r.get("surprise")
        surp_str = f" surp:{_pct(surp)}%" if surp is not None else ""
        lines.append(
            f"{i}. [{m.get('id', '?')}] {content}{icon}\n"
            f"   sim:{sim}% conf:{conf}%{surp_str}"
        )

    return f'Found {len(results)} for "{query}":\n\n' + "\n\n".join(lines)


def fmt_recall(data: dict[str, Any]) -> str:
    m = data.get("memory", data)

    state_label = m.get("state", "active")
    if state_label == "resolved" and m.get("outcome"):
        state_label = f"resolved:{m['outcome']}"

    tt = m.get("times_tested", 0)
    confs = m.get("confirmations", 0)
    confidence = f"{round(confs / tt * 100)}%" if tt > 0 else "untested"

    traits: list[str] = []
    if m.get("source"):
        traits.append("sourced")
    df = m.get("derived_from")
    if df and len(df) > 0:
        traits.append("derived")
    if m.get("resolves_by"):
        traits.append("time-bound")
    trait_label = ", ".join(traits) if traits else "standalone"

    text = f"[{m.get('id', '?')}] {m.get('content', '')}\n"
    text += f"{trait_label} | {state_label} | {confidence}\n"

    if m.get("source"):
        text += f"Source: {m['source']}\n"

    violations = m.get("violations", [])
    if violations:
        for v in violations:
            text += f'Violation: "{v.get("condition", "")}" (by {v.get("obs_id", "?")})\n'

    connections = data.get("connections", [])
    if connections:
        ids = ", ".join(f"[{c.get('target_id', '?')}]" for c in connections)
        text += f"Connections: {ids}\n"

    return text.rstrip()


def fmt_resolve(data: dict[str, Any]) -> str:
    mid = data.get("memory_id", "?")
    outcome = data.get("outcome", "?")
    cascade = data.get("cascade_count", 0)
    text = f"[{mid}] resolved:{outcome}"
    if cascade:
        text += f" ({cascade} cascade)"
    if data.get("cascade_error"):
        text += f" cascade_error: {data['cascade_error']}"
    return text


def fmt_stats(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, default=str)


def fmt_pending(data: dict[str, Any]) -> str:
    memories = data.get("memories", data.get("results", []))
    total = data.get("total", len(memories))
    offset = data.get("offset", 0)

    if not memories:
        return "No pending time-bound memories"

    lines: list[str] = []
    for m in memories:
        deadline = _resolves_by(m.get("resolves_by"))
        lines.append(f"[{m.get('id', '?')}] {m.get('content', '')}\n   Resolves by: {deadline}")

    fr = offset + 1
    to = offset + len(memories)
    return f"=== PENDING RESOLUTION === (showing {fr}-{to} of {total})\n\n" + "\n\n".join(lines)


def fmt_insights(data: dict[str, Any]) -> str:
    view = data.get("view", "?")
    memories = data.get("memories", data.get("results", []))
    total = data.get("total", len(memories))
    offset = data.get("offset", 0)

    if not memories:
        return f'No memories in "{view}" view'

    lines: list[str] = []
    for m in memories:
        icon = _outcome_icon(m.get("state"), m.get("outcome"))
        tt = m.get("times_tested", 0)
        confs = m.get("confirmations", 0)
        conf_str = (
            f" ({round(confs / tt * 100)}% conf, {tt} tests)" if tt > 0 else ""
        )
        lines.append(f"[{m.get('id', '?')}] {m.get('content', '')}{icon}{conf_str}")

    fr = offset + 1
    to = offset + len(memories)
    return f"=== {view.upper()} === (showing {fr}-{to} of {total})\n\n" + "\n".join(lines)


def fmt_reference(data: dict[str, Any]) -> str:
    nodes = data.get("nodes", [])
    edges = data.get("edges", [])
    root_id = data.get("root", "?")

    if not nodes:
        return f"No graph data for [{root_id}]"

    # Build adjacency: source_id -> [(target_id, edge_type)]
    children: dict[str, list[tuple[str, str]]] = {}
    parents: dict[str, list[tuple[str, str]]] = {}
    for e in edges:
        src = e.get("source_id", "")
        tgt = e.get("target_id", "")
        etype = e.get("edge_type", "derives_from")
        children.setdefault(src, []).append((tgt, etype))
        parents.setdefault(tgt, []).append((src, etype))

    node_map = {n.get("id", ""): n for n in nodes}

    def _label(nid: str) -> str:
        n = node_map.get(nid, {})
        content = n.get("content", "")[:60]
        return f"[{nid}] {content}"

    lines = [_label(root_id)]

    # Show descendants (down)
    visited: set[str] = {root_id}

    def _walk_down(nid: str, indent: int) -> None:
        for child_id, _ in children.get(nid, []):
            if child_id not in visited:
                visited.add(child_id)
                lines.append(f"{'  ' * indent}> {_label(child_id)}")
                _walk_down(child_id, indent + 1)

    _walk_down(root_id, 1)

    # Show ancestors (up)
    for parent_id, _ in parents.get(root_id, []):
        if parent_id not in visited:
            visited.add(parent_id)
            lines.append(f"  < {_label(parent_id)}")

    return "\n".join(lines)


def fmt_roots(data: dict[str, Any]) -> str:
    roots = data.get("roots", data.get("results", []))
    if not roots:
        return "No root memories found"

    lines: list[str] = []
    for r in roots:
        lines.append(f"[{r.get('id', '?')}] {r.get('content', '')}")

    return f"Root memories ({len(roots)}):\n\n" + "\n".join(lines)


def fmt_zones(data: dict[str, Any]) -> str:
    memories = data.get("memories", [])
    edges = data.get("edges", [])
    stats = data.get("stats", {})

    if not memories:
        return "Empty zone"

    total = stats.get("total_memories", len(memories))
    total_edges = stats.get("total_edges", len(edges))

    lines = [f"Zone: {total} members, {total_edges} edges"]
    for m in memories:
        content = m.get("content", "")[:60]
        lines.append(f"[{m.get('id', '?')}] {content}")

    return "\n".join(lines)


def fmt_between(data: dict[str, Any]) -> str:
    bridges = data.get("bridges", data.get("results", []))
    if not bridges:
        return "No bridging memories found"

    lines: list[str] = []
    for b in bridges:
        m = b if isinstance(b, dict) and "content" in b else b.get("memory", b)
        lines.append(f"[{m.get('id', '?')}] {m.get('content', '')}")

    return f"Bridges ({len(bridges)}):\n\n" + "\n".join(lines)


def fmt_surprising(data: dict[str, Any]) -> str:
    results = data.get("results", data.get("memories", []))
    if not results:
        return "No surprising memories found"

    lines: list[str] = []
    for i, r in enumerate(results, 1):
        m = r if "content" in r else r.get("memory", r)
        surp = r.get("surprise", m.get("surprise"))
        surp_str = f" surp:{_pct(surp)}%" if surp is not None else ""
        lines.append(f"{i}. [{m.get('id', '?')}] {m.get('content', '')}{surp_str}")

    return f"Most surprising ({len(results)}):\n\n" + "\n".join(lines)


def fmt_session_recap(data: dict[str, Any]) -> str:
    # The REST endpoint already formats via LLM or raw fallback
    if "summary" in data:
        summary = data["summary"]
        ids = data.get("memory_ids", [])
        total = data.get("total", 0)
        text = f"=== SESSION RECAP === ({total} memories)\n\n{summary}"
        if ids:
            text += "\n\nReferenced: " + ", ".join(f"[{mid}]" for mid in ids)
        return text
    return json.dumps(data, indent=2, default=str)


def fmt_trace(data: dict[str, Any]) -> str:
    """Format memory trace timeline."""
    memory = data.get("memory", {})
    timeline = data.get("timeline", [])
    summary = data.get("summary", {})

    if not memory:
        return data.get("error", "Memory not found")

    mid = memory.get("id", "?")
    content = memory.get("content", "")[:80]
    state = memory.get("state", "?")
    source = memory.get("source", "unknown")
    created = _ts(memory.get("created_at"))

    lines = [
        f"[{mid}] {content}",
        f"State: {state} | Source: {source} | Created: {created}",
        "",
    ]

    if timeline:
        lines.append(f"Timeline ({len(timeline)} events):")
        for entry in timeline:
            ts = _ts(entry.get("timestamp"))
            etype = entry.get("type", "?")

            if etype == "version":
                change = entry.get("change_type", "?")
                reason = entry.get("change_reason")
                fields = entry.get("changed_fields")
                detail = change
                if fields:
                    detail += f" — changed: {fields}"
                if reason:
                    detail += f" ({reason})"
                lines.append(f"  {ts}  VERSION   {detail}")

            elif etype == "edge":
                edge_type = entry.get("edge_type", "?")
                other = entry.get("other_id", "?")
                direction = "→" if entry.get("direction") == "outgoing" else "←"
                lines.append(f"  {ts}  EDGE      {edge_type} {direction} [{other}]")

            elif etype == "event":
                event_type = entry.get("event_type", "?")
                dispatched = "✓" if entry.get("dispatched") else "pending"
                ctx = entry.get("context_summary") or ""
                ctx_str = f" — {ctx}" if ctx else ""
                lines.append(f"  {ts}  EVENT     {event_type} — dispatched {dispatched}{ctx_str}")

            elif etype == "access":
                access_type = entry.get("access_type", "?")
                query = entry.get("query_text") or ""
                query_str = f' (query: "{query[:40]}")' if query else ""
                lines.append(f"  {ts}  ACCESS    {access_type}{query_str}")
    else:
        lines.append("No timeline events found.")

    lines.append("")
    lines.append(
        f"Summary: {summary.get('versions', 0)} versions, "
        f"{summary.get('edges', 0)} edges, "
        f"{summary.get('events', 0)} events, "
        f"{summary.get('accesses', 0)} accesses"
    )

    return "\n".join(lines)


def _ts(value: int | float | None) -> str:
    """Format a millisecond timestamp as MM-DD HH:MM."""
    if value is None:
        return "??-?? ??:??"
    ms = value * 1000 if value < 1e12 else value
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%m-%d %H:%M")


def fmt_diagnostics(data: dict[str, Any]) -> str:
    """Format system diagnostics as scannable text."""
    if not data.get("success"):
        return data.get("error", "Diagnostics failed")

    mem = data.get("memories", {})
    graph = data.get("graph", {})
    queue = data.get("queue", {})
    exposure = mem.get("exposure_check", {})

    total_active = mem.get("total_active", 0)
    retracted = mem.get("retracted", 0)
    observations = mem.get("observations", 0)
    thoughts = mem.get("thoughts", 0)
    predictions = mem.get("predictions", 0)
    states = mem.get("state_distribution", {})

    total_edges = graph.get("total_edges", 0)
    edge_types = graph.get("edge_types", {})
    orphans = graph.get("orphan_thoughts", 0)
    brittle = graph.get("brittle", 0)

    pending = queue.get("pending", 0)
    dispatched = queue.get("dispatched", 0)
    sessions = queue.get("active_sessions", 0)

    exp_completed = exposure.get("completed", 0)
    exp_pending = exposure.get("pending", 0)
    exp_processing = exposure.get("processing", 0)

    # Build state line
    state_parts = []
    for s in ["active", "violated", "confirmed", "resolved", "draft"]:
        if states.get(s, 0) > 0:
            state_parts.append(f"{states[s]:,} {s}")

    # Build edge type line
    edge_parts = []
    for et, count in edge_types.items():
        edge_parts.append(f"{count:,} {et}")

    lines = [
        "=== SYSTEM HEALTH ===",
        "",
        f"Memories: {total_active:,} active ({retracted:,} retracted)",
        f"  Observations: {observations:,} | Thoughts: {thoughts:,} | Predictions: {predictions:,}",
    ]
    if state_parts:
        lines.append(f"  States: {', '.join(state_parts)}")

    lines.append("")
    lines.append(f"Graph: {total_edges:,} edges" + (f" ({', '.join(edge_parts)})" if edge_parts else ""))
    if orphans or brittle:
        lines.append(f"  {orphans:,} orphan thoughts | {brittle:,} brittle (<3 tests)")

    lines.append("")
    lines.append(f"Queue: {pending:,} pending, {dispatched:,} dispatched, {sessions:,} active sessions")

    if any([exp_completed, exp_pending, exp_processing]):
        lines.append("")
        lines.append(f"Exposure: {exp_completed:,} completed, {exp_pending:,} pending, {exp_processing:,} processing")

    # Include samples if present
    samples = data.get("samples")
    if samples:
        lines.append("")
        lines.append("Samples:")
        for state, mems in samples.items():
            for m in mems:
                lines.append(f"  [{m.get('id', '?')}] {state}: {m.get('content', '')}")

    return "\n".join(lines)


def fmt_admin(data: dict[str, Any]) -> str:
    """Admin tool formatter — concise, actionable output."""
    success = data.get("success", False)

    # Bulk retract
    if "retracted" in data:
        count = data["retracted"]
        reason = data.get("reason", "")
        cascade = data.get("cascade_retracted", 0)
        text = f"Retracted {count} memor{'y' if count == 1 else 'ies'}"
        if cascade:
            text += f" + {cascade} cascade"
        if reason:
            text += f" ({reason})"
        return text

    # Queue status
    if "pending_count" in data or "event_types" in data:
        return json.dumps(data, indent=2, default=str)

    # Queue purge
    if "purged" in data:
        return f"Purged {data['purged']} events" + (" (dry run)" if data.get("dry_run") else "")

    # Memory state change
    if "previous_state" in data or "new_state" in data:
        mid = data.get("memory_id", "?")
        prev = data.get("previous_state", "?")
        new = data.get("new_state", data.get("state", "?"))
        return f"[{mid}] {prev} → {new}"

    # Condition vectors cleanup
    if "cleaned" in data:
        return f"Cleaned {data['cleaned']} condition vectors" + (" (dry run)" if data.get("dry_run") else "")

    # Diagnostics / generic success
    if success and len(data) <= 2:
        return "Done"

    # Dry run results with items
    if "would_retract" in data:
        items = data["would_retract"]
        if isinstance(items, list):
            lines = [f"Would retract {len(items)} memories:"]
            for m in items[:10]:
                mid = m.get("id", "?") if isinstance(m, dict) else m
                content = m.get("content", "") if isinstance(m, dict) else ""
                lines.append(f"  [{mid}] {content[:80]}")
            return "\n".join(lines)

    return json.dumps(data, indent=2, default=str)


def fmt_default(data: dict[str, Any]) -> str:
    """Fallback — pretty JSON."""
    return json.dumps(data, indent=2, default=str)
