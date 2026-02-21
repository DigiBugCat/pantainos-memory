"""Configuration via environment variables."""

from __future__ import annotations

import os

CF_WORKER_URL = os.environ.get("PANTAINOS_CF_WORKER_URL", "https://memory.pantainos.net")
CF_CLIENT_ID = os.environ.get("CF_ACCESS_CLIENT_ID", "")
CF_CLIENT_SECRET = os.environ.get("CF_ACCESS_CLIENT_SECRET", "")
