"""Shared httpx client for proxying requests to Pantainos Memory CF Worker."""

from __future__ import annotations

from typing import Any

import httpx

from config import CF_WORKER_URL, CF_CLIENT_ID, CF_CLIENT_SECRET


def _base_headers() -> dict[str, str]:
    import logging
    logger = logging.getLogger(__name__)
    headers: dict[str, str] = {}
    if CF_CLIENT_ID and CF_CLIENT_SECRET:
        headers["CF-Access-Client-Id"] = CF_CLIENT_ID
        headers["CF-Access-Client-Secret"] = CF_CLIENT_SECRET
        logger.info("CF Access headers configured (ID: %s...)", CF_CLIENT_ID[:12])
    else:
        logger.warning("CF Access headers NOT configured — CF_CLIENT_ID=%r, CF_CLIENT_SECRET=%s",
                       CF_CLIENT_ID, "set" if CF_CLIENT_SECRET else "empty")
    return headers


_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=CF_WORKER_URL,
            headers=_base_headers(),
            timeout=30.0,
        )
    return _client


def _extra_headers(session_id: str | None = None) -> dict[str, str]:
    """Build per-request headers (merged with client-level headers by httpx)."""
    headers: dict[str, str] = {}
    if session_id:
        headers["X-Session-Id"] = session_id
    return headers


async def post(
    path: str,
    body: dict[str, Any],
    *,
    session_id: str | None = None,
) -> dict[str, Any]:
    """POST JSON to CF Worker and return parsed response."""
    resp = await _get_client().post(
        f"/api{path}", json=body, headers=_extra_headers(session_id)
    )
    resp.raise_for_status()
    return resp.json()  # type: ignore[no-any-return]


async def get(
    path: str,
    params: dict[str, Any] | None = None,
    *,
    session_id: str | None = None,
) -> dict[str, Any]:
    """GET from CF Worker and return parsed response."""
    resp = await _get_client().get(
        f"/api{path}", params=params, headers=_extra_headers(session_id)
    )
    resp.raise_for_status()
    return resp.json()  # type: ignore[no-any-return]
