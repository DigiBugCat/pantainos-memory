"""FastMCP server for Pantainos Memory — 15 user-facing tools.

Each tool proxies to the CF Worker REST API via httpx. Notifications
are polled after each tool call and prepended to the response.
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


def _body(**kwargs: Any) -> dict[str, Any]:
    """Build request body, dropping None values."""
    return {k: v for k, v in kwargs.items() if v is not None}


# ─── Write Tools ───────────────────────────────────────────────────────────────


@mcp.tool(annotations=_rw)
async def observe(
    content: Annotated[str, Field(description="The memory content")],
    source: Annotated[str | None, Field(description='Free-text provenance (e.g. "market", "sec-10k", "reddit", "human", "agent-research")')] = None,
    source_url: Annotated[str | None, Field(description="URL/link where this information came from")] = None,
    derived_from: Annotated[list[str] | None, Field(description="Source memory IDs this memory derives from")] = None,
    invalidates_if: Annotated[list[str] | None, Field(description="Conditions that would prove this wrong")] = None,
    confirms_if: Annotated[list[str] | None, Field(description="Conditions that would strengthen this")] = None,
    assumes: Annotated[list[str] | None, Field(description="Underlying assumptions")] = None,
    resolves_by: Annotated[str | None, Field(description='Deadline as date string (e.g. "2026-03-15") or Unix timestamp')] = None,
    outcome_condition: Annotated[str | None, Field(description="Success/failure criteria (required if resolves_by set)")] = None,
    tags: Annotated[list[str] | None, Field(description="Optional tags for categorization")] = None,
    obsidian_sources: Annotated[list[str] | None, Field(description="Obsidian vault file paths that reference this memory")] = None,
    atomic_override: Annotated[bool | None, Field(description="Bypass atomicity check for intentionally composite notes")] = None,
) -> str:
    """Store a new memory. Every memory is a perception — what you saw, read, inferred, or predicted.

    At least one of `source` or `derived_from` is required.

    If the completeness check has warnings, the memory is saved as a draft (not indexed, not
    searchable). Use the override tool to commit it.
    """
    body = _body(
        content=content, source=source, source_url=source_url,
        derived_from=derived_from, invalidates_if=invalidates_if,
        confirms_if=confirms_if, assumes=assumes, resolves_by=resolves_by,
        outcome_condition=outcome_condition, tags=tags,
        obsidian_sources=obsidian_sources, atomic_override=atomic_override,
    )
    data = await client.post("/observe", body)
    mem_id = data.get("id", "?")
    status = data.get("status", "active")
    preview = f"{content[:100]}{'...' if len(content) > 100 else ''}"

    if status == "draft":
        warnings = data.get("warnings", {})
        missing = warnings.get("missing_fields", [])
        reasoning = warnings.get("reasoning", "")
        result = f"Draft [{mem_id}] — saved but NOT committed\n{preview}\n"
        if missing:
            for f in missing:
                result += f"\n- {f.get('field', '?')}: {f.get('reason', '')}"
        if reasoning:
            result += f"\n\n{reasoning}"
        result += f'\n\nTo commit: call override(memory_id="{mem_id}")'
    else:
        result = f"Stored [{mem_id}]\n{preview}"

    return await _with_notifications(result)


@mcp.tool(annotations=_rw)
async def update(
    memory_id: Annotated[str, Field(description="ID of the memory to update")],
    content: Annotated[str | None, Field(description="New content text (replaces existing)")] = None,
    source: Annotated[str | None, Field(description="Free-text provenance string")] = None,
    source_url: Annotated[str | None, Field(description="URL/link where this information came from")] = None,
    derived_from: Annotated[list[str] | None, Field(description="Replace derived_from IDs")] = None,
    invalidates_if: Annotated[list[str] | None, Field(description="Conditions to ADD (not replace)")] = None,
    confirms_if: Annotated[list[str] | None, Field(description="Conditions to ADD (not replace)")] = None,
    assumes: Annotated[list[str] | None, Field(description="Assumptions to ADD")] = None,
    resolves_by: Annotated[str | None, Field(description="Deadline as date string or Unix timestamp")] = None,
    outcome_condition: Annotated[str | None, Field(description="Success/failure criteria")] = None,
    tags: Annotated[list[str] | None, Field(description="Tags to ADD (not replace)")] = None,
    obsidian_sources: Annotated[list[str] | None, Field(description="Obsidian vault file paths to ADD (not replace)")] = None,
) -> str:
    """Update a memory's content or metadata. Arrays are merged, not replaced.

    For fundamental thesis changes, use resolve(outcome="superseded") + observe() instead.
    """
    body = _body(
        memory_id=memory_id, content=content, source=source, source_url=source_url,
        derived_from=derived_from, invalidates_if=invalidates_if,
        confirms_if=confirms_if, assumes=assumes, resolves_by=resolves_by,
        outcome_condition=outcome_condition, tags=tags, obsidian_sources=obsidian_sources,
    )
    data = await client.post("/update", body)
    return await _with_notifications(fmt.fmt_recall(data))


@mcp.tool(annotations=_rw_idempotent)
async def resolve(
    memory_id: Annotated[str, Field(description="ID of the memory to resolve")],
    outcome: Annotated[Literal["correct", "incorrect", "voided", "superseded"], Field(description="Resolution outcome")],
    reason: Annotated[str, Field(description="Explanation for why this outcome was chosen (audit trail)")],
    replaced_by: Annotated[str | None, Field(description="ID of newer memory that replaces this one (creates supersedes edge)")] = None,
    force: Annotated[bool, Field(description="Allow re-resolution of already-resolved memories")] = False,
) -> str:
    """Resolve a memory as correct, incorrect, superseded, or voided."""
    body = _body(
        memory_id=memory_id, outcome=outcome, reason=reason,
        replaced_by=replaced_by, force=force if force else None,
    )
    data = await client.post("/resolve", body)
    return await _with_notifications(fmt.fmt_default(data))


@mcp.tool(annotations=_rw_idempotent)
async def refresh_stats(
    summary_only: Annotated[bool, Field(description="If true, only return current stats without recomputing")] = False,
) -> str:
    """Manually trigger system statistics recomputation.

    Updates max_times_tested, median_times_tested, and per-source learned_confidence.
    Normally runs daily via cron.
    """
    data = await client.post("/refresh-stats", {"summary_only": summary_only})
    return await _with_notifications(fmt.fmt_stats(data))


@mcp.tool(annotations=_rw_idempotent)
async def override(
    memory_id: Annotated[str, Field(description="ID of the draft memory to commit")],
) -> str:
    """Commit a draft memory to active. Runs the full pipeline (vectorize + exposure check).

    Use this after observe saves a memory as draft due to completeness warnings.
    """
    data = await client.post("/override", {"memory_id": memory_id})
    if data.get("success"):
        return await _with_notifications(f"Committed [{memory_id}] — now active and indexed")
    return await _with_notifications(f"Failed: {data.get('error', 'unknown error')}")


# ─── Read Tools ────────────────────────────────────────────────────────────────


@mcp.tool(annotations=_ro)
async def find(
    query: Annotated[str, Field(description="Natural language search query")],
    has_source: Annotated[bool | None, Field(description="Filter to memories with external source")] = None,
    has_derived_from: Annotated[bool | None, Field(description="Filter to memories derived from other memories")] = None,
    time_bound: Annotated[bool | None, Field(description="Filter to time-bound memories")] = None,
    limit: Annotated[int, Field(10, description="Max results", ge=1, le=100)] = 10,
    min_similarity: Annotated[float | None, Field(description="Minimum similarity threshold (0-1)", ge=0, le=1)] = None,
) -> str:
    """Search memories by meaning. Results ranked by similarity, confidence, surprise, centrality."""
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
    return await _with_notifications(fmt.fmt_find(data))


@mcp.tool(annotations=_ro)
async def recall(
    memory_id: Annotated[str, Field(description="ID of the memory to recall")],
) -> str:
    """Get a memory by ID with confidence stats, state, and derivation edges."""
    data = await client.get(f"/recall/{memory_id}")
    return await _with_notifications(fmt.fmt_recall(data))


@mcp.tool(annotations=_ro)
async def stats() -> str:
    """Get memory statistics (counts by type, edge count, robustness)."""
    data = await client.get("/stats")
    return await _with_notifications(fmt.fmt_stats(data))


@mcp.tool(annotations=_ro)
async def pending(
    overdue: Annotated[bool, Field(description="Only show overdue memories (default: false shows all pending)")] = False,
    limit: Annotated[int, Field(20, description="Max results", ge=1, le=100)] = 20,
    offset: Annotated[int, Field(0, description="Skip first N results for pagination", ge=0)] = 0,
) -> str:
    """List time-bound memories past their resolves_by deadline."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    if overdue:
        params["overdue"] = "true"
    data = await client.get("/pending", params)
    return await _with_notifications(fmt.fmt_pending(data))


@mcp.tool(annotations=_ro)
async def insights(
    view: Annotated[Literal["hubs", "orphans", "untested", "failing", "recent"], Field(description="Analysis view")] = "recent",
    limit: Annotated[int, Field(20, description="Max results", ge=1, le=100)] = 20,
    offset: Annotated[int, Field(0, description="Skip first N results for pagination", ge=0)] = 0,
) -> str:
    """Analyze knowledge graph health."""
    params: dict[str, Any] = {"limit": limit, "offset": offset}
    data = await client.get(f"/insights/{view}", params)
    # Inject view name for formatter
    data["view"] = view
    return await _with_notifications(fmt.fmt_insights(data))


@mcp.tool(annotations=_ro)
async def reference(
    memory_id: Annotated[str, Field(description="ID of the memory to traverse from")],
    direction: Annotated[Literal["up", "down", "both"], Field(description="up (ancestors), down (descendants), both")] = "both",
    depth: Annotated[int, Field(2, description="Max traversal depth", ge=1, le=10)] = 2,
) -> str:
    """Follow the derivation graph from a memory."""
    params: dict[str, Any] = {"direction": direction, "depth": depth}
    data = await client.get(f"/reference/{memory_id}", params)
    return await _with_notifications(fmt.fmt_reference(data))


@mcp.tool(annotations=_ro)
async def roots(
    memory_id: Annotated[str, Field(description="ID of the memory to trace roots for")],
) -> str:
    """Trace a memory back to its root perceptions. Walks the derivation chain to find original sources."""
    data = await client.get(f"/roots/{memory_id}")
    return await _with_notifications(fmt.fmt_roots(data))


@mcp.tool(annotations=_ro)
async def zones(
    query: Annotated[str | None, Field(description="Semantic seed query (optional if memory_id given)")] = None,
    memory_id: Annotated[str | None, Field(description="Direct seed memory ID (optional if query given)")] = None,
    max_depth: Annotated[int, Field(3, description="Graph traversal depth", ge=1, le=5)] = 3,
    max_size: Annotated[int, Field(30, description="Max zone members", ge=1, le=100)] = 30,
    include_semantic: Annotated[bool, Field(description="Supplement with semantic search if zone is small")] = True,
    min_edge_strength: Annotated[float, Field(0.3, description="Minimum edge strength to traverse", ge=0, le=1)] = 0.3,
) -> str:
    """Return a locally consistent reasoning zone around a seed.

    A mutually non-contradictory cluster of memories, plus boundary contradictions
    and external support dependency.
    """
    body = _body(
        query=query, memory_id=memory_id, max_depth=max_depth,
        max_size=max_size, include_semantic=include_semantic,
        min_edge_strength=min_edge_strength,
    )
    data = await client.post("/zones", body)
    return await _with_notifications(fmt.fmt_zones(data))


@mcp.tool(annotations=_ro)
async def between(
    memory_ids: Annotated[list[str], Field(description="IDs of memories to find bridges between (minimum 2)", min_length=2)],
    limit: Annotated[int, Field(5, description="Max bridges to return", ge=1, le=20)] = 5,
) -> str:
    """Find memories that bridge two given memories."""
    data = await client.post("/between", {"memory_ids": memory_ids, "limit": limit})
    return await _with_notifications(fmt.fmt_between(data))


@mcp.tool(annotations=_ro)
async def surprising(
    limit: Annotated[int, Field(10, description="Max results", ge=1, le=50)] = 10,
    min_surprise: Annotated[float, Field(0.3, description="Minimum surprise threshold", ge=0, le=1)] = 0.3,
) -> str:
    """Find the most surprising memories — highest prediction error from the knowledge graph."""
    params: dict[str, Any] = {"limit": limit, "min_surprise": min_surprise}
    data = await client.get("/surprising", params)
    return await _with_notifications(fmt.fmt_surprising(data))


@mcp.tool(annotations=_ro)
async def session_recap(
    minutes: Annotated[int, Field(30, description="Time window in minutes", ge=1, le=1440)] = 30,
    limit: Annotated[int, Field(30, description="Max memories to include", ge=1, le=100)] = 30,
    raw: Annotated[bool, Field(description="Skip LLM summarization, return structured list")] = False,
) -> str:
    """Summarize memories accessed in the current session."""
    body: dict[str, Any] = {"minutes": minutes, "limit": limit}
    if raw:
        body["raw"] = True
    data = await client.post("/session-recap", body)
    return await _with_notifications(fmt.fmt_session_recap(data))


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
