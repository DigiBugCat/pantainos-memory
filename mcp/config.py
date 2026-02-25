"""Configuration via environment variables."""

from __future__ import annotations

import os

CF_WORKER_URL = os.environ.get("PANTAINOS_CF_WORKER_URL", "https://pantainos-memory.pantainos.workers.dev")
CF_CLIENT_ID = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_CLIENT_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")

# Agent scoping — set per MCP server instance to isolate memory per agent
AGENT_ID = os.environ.get("PANTAINOS_AGENT_ID", "")
MEMORY_SCOPE = os.environ.get("PANTAINOS_MEMORY_SCOPE", "")
