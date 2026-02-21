"""FastMCP server for Pantainos Memory — 10 admin tools.

Each tool proxies to the CF Worker REST API at /api/admin/*.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

import client

mcp = FastMCP("memory-admin")
_ro = ToolAnnotations(readOnlyHint=True)
_rw = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_destructive = ToolAnnotations(readOnlyHint=False, destructiveHint=True)


def _fmt(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2, default=str)


@mcp.tool(annotations=_ro)
async def queue_status(
    detail_level: str = "summary",
    session_id: str | None = None,
) -> str:
    """View event queue state: pending counts, event type distribution, stuck sessions.

    Args:
        detail_level: summary or detailed (default: summary)
        session_id: Filter by specific session ID
    """
    body: dict[str, Any] = {"detail_level": detail_level}
    if session_id is not None:
        body["session_id"] = session_id
    data = await client.post("/admin/queue-status", body)
    return _fmt(data)


@mcp.tool(annotations=_destructive)
async def queue_purge(
    mode: str,
    session_id: str | None = None,
    older_than_hours: float = 24,
    dry_run: bool = True,
) -> str:
    """Delete stale or dispatched events from the queue.

    Args:
        mode: dispatched_only (safe), session (clear specific session), all_pending (nuclear)
        session_id: Required if mode=session
        older_than_hours: Only purge events older than N hours (default: 24)
        dry_run: Preview what would be deleted (default: true)
    """
    body: dict[str, Any] = {
        "mode": mode,
        "older_than_hours": older_than_hours,
        "dry_run": dry_run,
    }
    if session_id is not None:
        body["session_id"] = session_id
    data = await client.post("/admin/queue-purge", body)
    return _fmt(data)


@mcp.tool(annotations=_rw)
async def memory_state(
    memory_id: str,
    new_state: str,
    reason: str,
    outcome: str | None = None,
) -> str:
    """Override a memory's state. Triggers cascade propagation when appropriate.

    Args:
        memory_id: Memory ID to update
        new_state: active, confirmed, violated, or resolved
        reason: Explanation for state change (audit trail)
        outcome: correct, incorrect, or voided — required if new_state=resolved
    """
    body: dict[str, Any] = {
        "memory_id": memory_id,
        "new_state": new_state,
        "reason": reason,
    }
    if outcome is not None:
        body["outcome"] = outcome
    data = await client.post("/admin/memory-state", body)
    return _fmt(data)


@mcp.tool(annotations=_destructive)
async def condition_vectors_cleanup(
    memory_id: str | None = None,
    batch_size: int = 50,
    dry_run: bool = True,
) -> str:
    """Delete condition vectors for non-active memories. Prevents stale exposure checks.

    Args:
        memory_id: Clean specific memory (optional, omit for batch)
        batch_size: How many memories to process (default: 50, max: 200)
        dry_run: Preview what would be cleaned (default: true)
    """
    body: dict[str, Any] = {"batch_size": batch_size, "dry_run": dry_run}
    if memory_id is not None:
        body["memory_id"] = memory_id
    data = await client.post("/admin/condition-vectors-cleanup", body)
    return _fmt(data)


@mcp.tool(annotations=_ro)
async def system_diagnostics(include_samples: bool = False) -> str:
    """System health: memory states, exposure status, queue health, graph metrics.

    Args:
        include_samples: Include sample memories from each state category
    """
    params: dict[str, Any] = {}
    if include_samples:
        params["include_samples"] = "true"
    data = await client.get("/admin/system-diagnostics", params)
    return _fmt(data)


@mcp.tool(annotations=_ro)
async def force_dispatch(session_id: str) -> str:
    """View pending events for a session. Shows what would be dispatched.

    Args:
        session_id: Session ID to inspect
    """
    data = await client.get("/admin/force-dispatch", {"session_id": session_id})
    return _fmt(data)


@mcp.tool(annotations=_ro)
async def graph_health(check: str = "all") -> str:
    """Find graph anomalies: orphan edges, broken derivations, duplicate edges.

    Args:
        check: orphan_edges, broken_derivations, duplicate_edges, or all (default: all)
    """
    data = await client.get("/admin/graph-health", {"check": check})
    return _fmt(data)


@mcp.tool(annotations=_destructive)
async def bulk_retract(
    memory_id: str,
    reason: str,
    cascade: bool = False,
    dry_run: bool = True,
) -> str:
    """Retract a memory and optionally cascade to all derived descendants.

    Args:
        memory_id: Memory ID to retract
        reason: Retraction reason
        cascade: Also retract downstream thoughts derived from this memory
        dry_run: Preview what would be retracted (default: true)
    """
    data = await client.post("/admin/bulk-retract", {
        "memory_id": memory_id,
        "reason": reason,
        "cascade": cascade,
        "dry_run": dry_run,
    })
    return _fmt(data)


@mcp.tool(annotations=_rw)
async def re_evaluate_violations(
    memory_id: str | None = None,
    batch_size: int = 10,
    dry_run: bool = True,
    confidence_threshold: float = 0.7,
) -> str:
    """Re-evaluate violated memories using the current LLM judge. Identifies false positives.

    Args:
        memory_id: Re-evaluate a specific memory (optional, omit for batch)
        batch_size: How many violated memories to process (default: 10, max: 50)
        dry_run: Preview results without modifying state (default: true)
        confidence_threshold: Min confidence to keep a violation valid (default: 0.7)
    """
    body: dict[str, Any] = {
        "batch_size": batch_size,
        "dry_run": dry_run,
        "confidence_threshold": confidence_threshold,
    }
    if memory_id is not None:
        body["memory_id"] = memory_id
    data = await client.post("/admin/re-evaluate-violations", body)
    return _fmt(data)


@mcp.tool(annotations=_rw)
async def backfill_surprise(
    parallelism: int = 5,
    batch_size: int = 50,
    dry_run: bool = True,
) -> str:
    """Backfill surprise scores for memories missing them. Fan-out parallel workers.

    Args:
        parallelism: Number of parallel workers (default: 5)
        batch_size: Memories per worker batch (default: 50)
        dry_run: Preview what would be backfilled (default: true)
    """
    data = await client.post("/admin/backfill-surprise", {
        "parallelism": parallelism,
        "batch_size": batch_size,
        "dry_run": dry_run,
    })
    return _fmt(data)


# ─── CLI ───────────────────────────────────────────────────────────────────────


def cli() -> None:
    """Run the admin MCP server."""
    import logging

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s"
    )

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("ADMIN_PORT", "8001"))
    path = os.environ.get("MCP_PATH", "/mcp")

    logging.info("Starting Pantainos Memory MCP (admin) on %s:%s%s", host, port, path)

    mcp.run(transport="http", host=host, port=port, path=path)


if __name__ == "__main__":
    cli()
