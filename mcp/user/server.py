"""FastMCP server for Pantainos Memory — 15 user-facing tools.

Each tool proxies to the CF Worker REST API via httpx. Notifications
are polled after each tool call and prepended to the response.
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
import notifications

mcp = FastMCP("memory")
_ro = ToolAnnotations(readOnlyHint=True)
_rw = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)
_rw_idempotent = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True)


async def _with_notifications(result: str, session_id: str | None = None) -> str:
    """Prepend unread notifications to tool result text."""
    header = await notifications.fetch_and_format(session_id)
    if header:
        return header + result
    return result


def _fmt(data: dict[str, Any]) -> str:
    """Format response dict as readable JSON."""
    return json.dumps(data, indent=2, default=str)


# ─── Write Tools ───────────────────────────────────────────────────────────────


@mcp.tool(annotations=_rw)
async def observe(
    content: str,
    source: str | None = None,
    source_url: str | None = None,
    derived_from: list[str] | None = None,
    invalidates_if: list[str] | None = None,
    confirms_if: list[str] | None = None,
    assumes: list[str] | None = None,
    resolves_by: str | None = None,
    outcome_condition: str | None = None,
    tags: list[str] | None = None,
    obsidian_sources: list[str] | None = None,
    atomic_override: bool | None = None,
) -> str:
    """Store a new memory. Every memory is a perception — what you saw, read, inferred, or predicted.

    At least one of `source` or `derived_from` is required.

    Args:
        content: The memory content
        source: Free-text provenance (e.g. "market", "sec-10k", "reddit", "human", "agent-research")
        source_url: URL/link where this information came from
        derived_from: Source memory IDs this memory derives from
        invalidates_if: Conditions that would prove this wrong
        confirms_if: Conditions that would strengthen this
        assumes: Underlying assumptions
        resolves_by: Deadline as date string (e.g. "2026-03-15") or Unix timestamp
        outcome_condition: Success/failure criteria (required if resolves_by set)
        tags: Optional tags for categorization
        obsidian_sources: Obsidian vault file paths that reference this memory
        atomic_override: Bypass atomicity check for intentionally composite notes
    """
    body: dict[str, Any] = {"content": content}
    if source is not None:
        body["source"] = source
    if source_url is not None:
        body["source_url"] = source_url
    if derived_from is not None:
        body["derived_from"] = derived_from
    if invalidates_if is not None:
        body["invalidates_if"] = invalidates_if
    if confirms_if is not None:
        body["confirms_if"] = confirms_if
    if assumes is not None:
        body["assumes"] = assumes
    if resolves_by is not None:
        body["resolves_by"] = resolves_by
    if outcome_condition is not None:
        body["outcome_condition"] = outcome_condition
    if tags is not None:
        body["tags"] = tags
    if obsidian_sources is not None:
        body["obsidian_sources"] = obsidian_sources
    if atomic_override is not None:
        body["atomic_override"] = atomic_override

    data = await client.post("/observe", body)
    result = f"Stored [{data.get('id', '?')}]\n{content[:100]}{'...' if len(content) > 100 else ''}"
    return await _with_notifications(result)


@mcp.tool(annotations=_rw)
async def update(
    memory_id: str,
    content: str | None = None,
    source: str | None = None,
    source_url: str | None = None,
    derived_from: list[str] | None = None,
    invalidates_if: list[str] | None = None,
    confirms_if: list[str] | None = None,
    assumes: list[str] | None = None,
    resolves_by: str | None = None,
    outcome_condition: str | None = None,
    tags: list[str] | None = None,
    obsidian_sources: list[str] | None = None,
) -> str:
    """Update a memory's content or metadata. Arrays are merged, not replaced.

    For fundamental thesis changes, use resolve(outcome="superseded") + observe() instead.

    Args:
        memory_id: ID of the memory to update
        content: New content text (replaces existing)
        source: Free-text provenance string
        source_url: URL/link where this information came from
        derived_from: Replace derived_from IDs
        invalidates_if: Conditions to ADD (not replace)
        confirms_if: Conditions to ADD (not replace)
        assumes: Assumptions to ADD
        resolves_by: Deadline as date string or Unix timestamp
        outcome_condition: Success/failure criteria
        tags: Tags to ADD (not replace)
        obsidian_sources: Obsidian vault file paths to ADD (not replace)
    """
    body: dict[str, Any] = {"memory_id": memory_id}
    if content is not None:
        body["content"] = content
    if source is not None:
        body["source"] = source
    if source_url is not None:
        body["source_url"] = source_url
    if derived_from is not None:
        body["derived_from"] = derived_from
    if invalidates_if is not None:
        body["invalidates_if"] = invalidates_if
    if confirms_if is not None:
        body["confirms_if"] = confirms_if
    if assumes is not None:
        body["assumes"] = assumes
    if resolves_by is not None:
        body["resolves_by"] = resolves_by
    if outcome_condition is not None:
        body["outcome_condition"] = outcome_condition
    if tags is not None:
        body["tags"] = tags
    if obsidian_sources is not None:
        body["obsidian_sources"] = obsidian_sources

    data = await client.post("/update", body)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_rw_idempotent)
async def resolve(
    memory_id: str,
    outcome: str,
    reason: str,
    replaced_by: str | None = None,
    force: bool = False,
) -> str:
    """Resolve a memory as correct, incorrect, superseded, or voided.

    Args:
        memory_id: ID of the memory to resolve
        outcome: One of: correct, incorrect, voided, superseded
        reason: Explanation for why this outcome was chosen (audit trail)
        replaced_by: ID of newer memory that replaces this one (creates supersedes edge)
        force: Allow re-resolution of already-resolved memories
    """
    body: dict[str, Any] = {
        "memory_id": memory_id,
        "outcome": outcome,
        "reason": reason,
    }
    if replaced_by is not None:
        body["replaced_by"] = replaced_by
    if force:
        body["force"] = True

    data = await client.post("/resolve", body)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_rw_idempotent)
async def refresh_stats(summary_only: bool = False) -> str:
    """Manually trigger system statistics recomputation.

    Updates max_times_tested, median_times_tested, and per-source learned_confidence.
    Normally runs daily via cron.

    Args:
        summary_only: If true, only return current stats without recomputing
    """
    data = await client.post("/refresh-stats", {"summary_only": summary_only})
    return await _with_notifications(_fmt(data))


# ─── Read Tools ────────────────────────────────────────────────────────────────


@mcp.tool(annotations=_ro)
async def find(
    query: str,
    has_source: bool | None = None,
    has_derived_from: bool | None = None,
    time_bound: bool | None = None,
    limit: int = 10,
    min_similarity: float | None = None,
) -> str:
    """Search memories by meaning. Results ranked by similarity, confidence, surprise, centrality.

    Args:
        query: Natural language search query
        has_source: Filter to memories with external source
        has_derived_from: Filter to memories derived from other memories
        time_bound: Filter to time-bound memories
        limit: Max results (default: 10, max: 100)
        min_similarity: Minimum similarity threshold (0-1)
    """
    body: dict[str, Any] = {"query": query, "limit": limit}
    if has_source is not None:
        body["has_source"] = has_source
    if has_derived_from is not None:
        body["has_derived_from"] = has_derived_from
    if time_bound is not None:
        body["time_bound"] = time_bound
    if min_similarity is not None:
        body["min_similarity"] = min_similarity

    data = await client.post("/find", body)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def recall(memory_id: str) -> str:
    """Get a memory by ID with confidence stats, state, and derivation edges.

    Args:
        memory_id: ID of the memory to recall
    """
    data = await client.get(f"/recall/{memory_id}")
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def stats() -> str:
    """Get memory statistics (counts by type, edge count, robustness)."""
    data = await client.get("/stats")
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def pending(
    overdue: bool = False,
    limit: int = 20,
    offset: int = 0,
) -> str:
    """List time-bound memories past their resolves_by deadline.

    Args:
        overdue: Only show overdue memories (default: false shows all pending)
        limit: Max results (default: 20)
        offset: Skip first N results for pagination
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if overdue:
        params["overdue"] = "true"
    data = await client.get("/pending", params)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def insights(view: str = "recent", limit: int = 20, offset: int = 0) -> str:
    """Analyze knowledge graph health.

    Args:
        view: One of: hubs, orphans, untested, failing, recent (default: recent)
        limit: Max results (default: 20)
        offset: Skip first N results for pagination
    """
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    data = await client.get(f"/insights/{view}", params)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def reference(
    memory_id: str,
    direction: str = "both",
    depth: int = 2,
) -> str:
    """Follow the derivation graph from a memory.

    Args:
        memory_id: ID of the memory to traverse from
        direction: up (ancestors), down (descendants), both (default: both)
        depth: Max traversal depth (default: 2, max: 10)
    """
    params: dict[str, Any] = {"direction": direction, "depth": depth}
    data = await client.get(f"/reference/{memory_id}", params)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def roots(memory_id: str) -> str:
    """Trace a memory back to its root perceptions. Walks the derivation chain to find original sources.

    Args:
        memory_id: ID of the memory to trace roots for
    """
    data = await client.get(f"/roots/{memory_id}")
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def zones(
    query: str | None = None,
    memory_id: str | None = None,
    max_depth: int = 3,
    max_size: int = 30,
    include_semantic: bool = True,
    min_edge_strength: float = 0.3,
) -> str:
    """Return a locally consistent reasoning zone around a seed.

    A mutually non-contradictory cluster of memories, plus boundary contradictions
    and external support dependency.

    Args:
        query: Semantic seed query (optional if memory_id given)
        memory_id: Direct seed memory ID (optional if query given)
        max_depth: Graph traversal depth (default: 3, max: 5)
        max_size: Max zone members (default: 30, max: 100)
        include_semantic: Supplement with semantic search if zone is small
        min_edge_strength: Minimum edge strength to traverse (0-1)
    """
    body: dict[str, Any] = {
        "max_depth": max_depth,
        "max_size": max_size,
        "include_semantic": include_semantic,
        "min_edge_strength": min_edge_strength,
    }
    if query is not None:
        body["query"] = query
    if memory_id is not None:
        body["memory_id"] = memory_id

    data = await client.post("/zones", body)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def between(memory_ids: list[str], limit: int = 5) -> str:
    """Find memories that bridge two given memories.

    Args:
        memory_ids: IDs of memories to find bridges between (minimum 2)
        limit: Max bridges to return (default: 5, max: 20)
    """
    data = await client.post("/between", {"memory_ids": memory_ids, "limit": limit})
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def surprising(limit: int = 10, min_surprise: float = 0.3) -> str:
    """Find the most surprising memories — highest prediction error from the knowledge graph.

    Args:
        limit: Max results (default: 10, max: 50)
        min_surprise: Minimum surprise threshold 0-1 (default: 0.3)
    """
    params: dict[str, Any] = {"limit": limit, "min_surprise": min_surprise}
    data = await client.get("/surprising", params)
    return await _with_notifications(_fmt(data))


@mcp.tool(annotations=_ro)
async def session_recap(
    minutes: int = 30,
    limit: int = 30,
    raw: bool = False,
) -> str:
    """Summarize memories accessed in the current session.

    Args:
        minutes: Time window in minutes (default: 30, max: 1440)
        limit: Max memories to include (default: 30, max: 100)
        raw: Skip LLM summarization, return structured list
    """
    body: dict[str, Any] = {"minutes": minutes, "limit": limit}
    if raw:
        body["raw"] = True
    data = await client.post("/session-recap", body)
    return await _with_notifications(_fmt(data))


# ─── CLI ───────────────────────────────────────────────────────────────────────


def cli() -> None:
    """Run the user MCP server."""
    import logging

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s"
    )

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    path = os.environ.get("MCP_PATH", "/mcp")

    logging.info("Starting Pantainos Memory MCP (user) on %s:%s%s", host, port, path)

    mcp.run(transport="http", host=host, port=port, path=path)


if __name__ == "__main__":
    cli()
