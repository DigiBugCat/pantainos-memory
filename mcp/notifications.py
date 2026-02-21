"""Notification polling — fetch and prepend unread notifications to tool responses."""

from __future__ import annotations

import client


async def fetch_and_format(session_id: str | None = None) -> str | None:
    """Poll for unread notifications and return formatted header, or None."""
    try:
        data = await client.get("/notifications/pending", session_id=session_id)
    except Exception:
        return None

    notifications = data.get("notifications", [])
    if not notifications:
        return None

    lines = ["=== NOTIFICATIONS ==="]
    for n in notifications:
        lines.append(f"- {n['content']}")
    lines.append("")
    return "\n".join(lines)
