"""FastMCP server for Pantainos Memory — 10 admin tools.

Each tool proxies to the CF Worker REST API at /api/admin/*.
"""

from __future__ import annotations

import os
import sys
from typing import Annotated, Any, Literal

from pydantic import Field

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastmcp import FastMCP
from mcp.types import ToolAnnotations

import client
import formatters as fmt

mcp = FastMCP("memory-admin")
_ro = ToolAnnotations(readOnlyHint=True)
_rw = ToolAnnotations(readOnlyHint=False, destructiveHint=False)
_destructive = ToolAnnotations(readOnlyHint=False, destructiveHint=True)


def _body(**kwargs: Any) -> dict[str, Any]:
    """Build request body, dropping None values."""
    return {k: v for k, v in kwargs.items() if v is not None}


@mcp.tool(annotations=_ro)
async def queue_status(
    detail_level: Annotated[Literal["summary", "detailed"], Field(description="Level of detail in response")] = "summary",
    session_id: Annotated[str | None, Field(description="Filter by specific session ID")] = None,
) -> str:
    """View event queue state: pending counts, event type distribution, stuck sessions."""
    body = _body(detail_level=detail_level, session_id=session_id)
    data = await client.post("/admin/queue-status", body)
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_destructive)
async def queue_purge(
    mode: Annotated[Literal["dispatched_only", "session", "all_pending"], Field(description="Purge mode — dispatched_only (safe), session (clear specific session), all_pending (nuclear)")],
    session_id: Annotated[str | None, Field(description="Required if mode=session")] = None,
    older_than_hours: Annotated[float, Field(24, description="Only purge events older than N hours", ge=0)] = 24,
    dry_run: Annotated[bool, Field(description="Preview what would be deleted (default: true)")] = True,
) -> str:
    """Delete stale or dispatched events from the queue."""
    body = _body(
        mode=mode, session_id=session_id,
        older_than_hours=older_than_hours, dry_run=dry_run,
    )
    data = await client.post("/admin/queue-purge", body)
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_rw)
async def memory_state(
    memory_id: Annotated[str, Field(description="Memory ID to update")],
    new_state: Annotated[Literal["active", "confirmed", "violated", "resolved"], Field(description="Target state")],
    reason: Annotated[str, Field(description="Explanation for state change (audit trail)")],
    outcome: Annotated[Literal["correct", "incorrect", "voided"] | None, Field(description="Required if new_state=resolved")] = None,
) -> str:
    """Override a memory's state. Triggers cascade propagation when appropriate."""
    body = _body(
        memory_id=memory_id, new_state=new_state,
        reason=reason, outcome=outcome,
    )
    data = await client.post("/admin/memory-state", body)
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_destructive)
async def condition_vectors_cleanup(
    memory_id: Annotated[str | None, Field(description="Clean specific memory (optional, omit for batch)")] = None,
    batch_size: Annotated[int, Field(50, description="How many memories to process", ge=1, le=200)] = 50,
    dry_run: Annotated[bool, Field(description="Preview what would be cleaned (default: true)")] = True,
) -> str:
    """Delete condition vectors for non-active memories. Prevents stale exposure checks."""
    body = _body(memory_id=memory_id, batch_size=batch_size, dry_run=dry_run)
    data = await client.post("/admin/condition-vectors-cleanup", body)
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_ro)
async def system_diagnostics(
    include_samples: Annotated[bool, Field(description="Include sample memories from each state category")] = False,
) -> str:
    """System health: memory states, exposure status, queue health, graph metrics."""
    params: dict[str, Any] = {}
    if include_samples:
        params["include_samples"] = "true"
    data = await client.get("/admin/system-diagnostics", params)
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_ro)
async def force_dispatch(
    session_id: Annotated[str, Field(description="Session ID to inspect")],
) -> str:
    """View pending events for a session. Shows what would be dispatched."""
    data = await client.get("/admin/force-dispatch", {"session_id": session_id})
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_ro)
async def graph_health(
    check: Annotated[Literal["orphan_edges", "broken_derivations", "duplicate_edges", "all"], Field(description="Which anomaly check to run")] = "all",
) -> str:
    """Find graph anomalies: orphan edges, broken derivations, duplicate edges."""
    data = await client.get("/admin/graph-health", {"check": check})
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_destructive)
async def bulk_retract(
    memory_id: Annotated[str, Field(description="Memory ID to retract")],
    reason: Annotated[str, Field(description="Retraction reason")],
    cascade: Annotated[bool, Field(description="Also retract downstream thoughts derived from this memory")] = False,
    dry_run: Annotated[bool, Field(description="Preview what would be retracted (default: true)")] = True,
) -> str:
    """Retract a memory and optionally cascade to all derived descendants."""
    data = await client.post("/admin/bulk-retract", {
        "memory_id": memory_id,
        "reason": reason,
        "cascade": cascade,
        "dry_run": dry_run,
    })
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_rw)
async def re_evaluate_violations(
    memory_id: Annotated[str | None, Field(description="Re-evaluate a specific memory (optional, omit for batch)")] = None,
    batch_size: Annotated[int, Field(10, description="How many violated memories to process", ge=1, le=50)] = 10,
    dry_run: Annotated[bool, Field(description="Preview results without modifying state (default: true)")] = True,
    confidence_threshold: Annotated[float, Field(0.7, description="Min confidence to keep a violation valid", ge=0, le=1)] = 0.7,
) -> str:
    """Re-evaluate violated memories using the current LLM judge. Identifies false positives."""
    body = _body(
        memory_id=memory_id, batch_size=batch_size,
        dry_run=dry_run, confidence_threshold=confidence_threshold,
    )
    data = await client.post("/admin/re-evaluate-violations", body)
    return fmt.fmt_admin(data)


@mcp.tool(annotations=_rw)
async def backfill_surprise(
    parallelism: Annotated[int, Field(5, description="Number of parallel workers", ge=1, le=20)] = 5,
    batch_size: Annotated[int, Field(50, description="Memories per worker batch", ge=1, le=200)] = 50,
    dry_run: Annotated[bool, Field(description="Preview what would be backfilled (default: true)")] = True,
) -> str:
    """Backfill surprise scores for memories missing them. Fan-out parallel workers."""
    data = await client.post("/admin/backfill-surprise", {
        "parallelism": parallelism,
        "batch_size": batch_size,
        "dry_run": dry_run,
    })
    return fmt.fmt_admin(data)


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
