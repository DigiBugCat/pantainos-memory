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
