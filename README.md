# Pantainos Memory

Zettelkasten-style knowledge graph for AI agents. Cloudflare Workers with D1, Vectorize, and Workers AI.

## Architecture

Three workers share the same D1 database and Vectorize indexes:

```
┌──────────────────────────────────────────────────────────────────┐
│  pantainos-memory (API Worker)                                    │
│                                                                    │
│  GET  /              - Discovery / info                           │
│  POST /              - MCP Streamable HTTP (OAuth protected)      │
│  POST /mcp           - MCP JSON-RPC endpoint                     │
│  /api/*              - REST API (flow, query, tags, graph, etc.) │
│  /internal/*         - Service binding API (no auth)             │
│  /authorize, /token  - OAuth 2.0 endpoints                       │
│                                                                    │
│  Cron: * * * * *     - Dispatch events for inactive sessions     │
│  Cron: 0 3 * * *     - Compute stats, find overdue predictions   │
│  Queue Consumer      - Exposure check processing                  │
├──────────────────────────────────────────────────────────────────┤
│  pantainos-memory-mcp (MCP Worker)                                │
│                                                                    │
│  Same MCP tools, standalone worker for direct MCP client access  │
│  OAuth + CF Access service token auth                             │
├──────────────────────────────────────────────────────────────────┤
│  pantainos-memory-admin (Admin Worker)                            │
│                                                                    │
│  Admin-only MCP tools for maintenance and diagnostics            │
│  OAuth only (no service token fallback)                           │
└──────────────────────────────────────────────────────────────────┘
         │              │                │                │
         ▼              ▼                ▼                ▼
    ┌────────┐    ┌──────────┐    ┌───────────┐    ┌───────────┐
    │   D1   │    │ Vectorize │    │ Workers AI │    │ External  │
    │(SQLite)│    │ (768-dim) │    │(Embeddings)│    │ LLM (opt) │
    └────────┘    └──────────┘    └───────────┘    └───────────┘
         │
    ┌────────┐
    │   KV   │
    │(OAuth) │
    └────────┘
```

## Concepts

**Two memory primitives (determined by field presence, no type column):**
- **Observations**: Facts from reality. Has `source` field (market, news, earnings, email, human, tool).
- **Thoughts**: Derived beliefs. Has `derived_from` field (array of source memory IDs).
  - A thought with `resolves_by` set becomes a **Prediction** (time-bound, enters pending queue at deadline).

**Exposure checking:** When new memories arrive, the system queues an exposure check. Observations are tested against existing thought conditions; thoughts are tested against existing observations. Semantic similarity + LLM judge determine violations and confirmations.

**Confidence model:** Memories are weighted bets, not facts. `starting_confidence` is set by source type or memory kind. `times_tested` and `confirmations` track survival rate. Daily cron recomputes system-wide stats and per-source track records.

## Authentication

MCP OAuth 2.0 backed by Cloudflare Access (via `@pantainos/mcp-core`).

| Variable | Description |
|----------|-------------|
| `CF_ACCESS_TEAM` | Your Cloudflare Access team name |
| `CF_ACCESS_AUD` | Application Audience (AUD) tag from Access |
| `ISSUER_URL` | (Optional) Override OAuth issuer URL |

OAuth endpoints (on all three workers):
- `/.well-known/oauth-authorization-server` - Authorization server metadata (RFC 8414)
- `/.well-known/oauth-protected-resource` - Protected resource metadata (RFC 9728)
- `/register` - Dynamic client registration (RFC 7591)
- `/authorize` - Authorization endpoint
- `/token` - Token endpoint

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Run locally (connects to remote dev resources)
pnpm build        # Build all three worker bundles to dist/
pnpm test         # Run tests
pnpm typecheck    # TypeScript type checking
```

## Deployment

Production is managed via OpenTofu (Terraform). See `infra/` and `CLAUDE.md` for details.

```bash
pnpm build                                    # Build dist/index.js, dist/mcp-index.js, dist/admin-index.js
cd infra && tofu apply -var="environment=prod" # Deploy all workers
```

For dev deploys via wrangler:

```bash
pnpm deploy:dev   # Deploy API worker to dev
```

## MCP Tools

### Memory Tools (API + MCP workers)

| Tool | Description |
|------|-------------|
| `observe` | Record a memory. Set `source` for observations, `derived_from` for thoughts. Unified creation endpoint. |
| `update` | Update a memory (within 1 hour or same session). Arrays are merged, not replaced. |
| `find` | Semantic search across memories. Ranked by similarity, confidence, and centrality. |
| `recall` | Get a memory by ID with confidence stats, state, and derivation edges. |
| `reference` | Follow the derivation graph (ancestors via up, descendants via down). |
| `roots` | Trace a thought back to its root observations. |
| `between` | Find memories that bridge two given memories (conceptual connections). |
| `pending` | List time-bound predictions awaiting resolution. Supports `overdue` filter. |
| `insights` | Analyze graph health. Views: `hubs`, `orphans`, `untested`, `failing`, `recent`. |
| `stats` | Memory statistics (counts by type, edge count). |
| `refresh_stats` | Manually trigger system stats recomputation (normally runs daily via cron). |
| `resolve` | Resolve a thought/prediction as correct, incorrect, or voided. Triggers cascade propagation. |
| `session_recap` | Summarize memories accessed in the current session via LLM. |

### Admin Tools (Admin worker only)

| Tool | Description |
|------|-------------|
| `queue_status` | View event queue state: pending counts, stuck sessions, type distribution. |
| `queue_purge` | Delete stale or dispatched events. Dry-run by default. |
| `memory_state` | Override a memory's state (active, confirmed, violated, resolved). |
| `condition_vectors_cleanup` | Delete stale condition vectors from Vectorize for non-active memories. |
| `system_diagnostics` | Full system health: state distribution, exposure status, graph metrics, queue health. |
| `force_dispatch` | View pending events for a specific session. |
| `graph_health` | Find graph anomalies: orphan edges, broken derivations, duplicate edges. |
| `bulk_retract` | Retract a memory and optionally cascade to all derived descendants. |

### REST API Write Path (`/api/...`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/observe` | Create a memory (observation or thought) |
| POST | `/api/confirm/:id` | Manually confirm a memory |
| POST | `/api/violate/:id` | Manually violate a memory |
| POST | `/api/retract/:id` | Retract a memory |
| POST | `/api/cascade/events` | View cascade events |
| POST | `/api/cascade/apply` | Apply cascade effects |

### REST API Read Path (`/api/...`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/find` | Semantic search |
| GET | `/api/recall/:id` | Get memory by ID |
| GET | `/api/reference/:id` | Graph traversal |
| GET | `/api/between` | Find bridging memories |
| GET | `/api/pending` | Overdue predictions |
| GET | `/api/insights/:view` | Analytical views |
| GET | `/api/knowledge` | Topic depth assessment |
| GET | `/api/brittle` | Low-exposure thoughts |
| GET | `/api/graveyard` | Retracted/violated memories |
| GET | `/api/collisions` | Duplicate detection |
| GET | `/api/roots/:id` | Root observations |
| GET | `/api/stats` | Memory statistics |
| GET | `/api/history/:id` | Version history |
| GET | `/api/access-log/:id` | Access audit trail |
| GET | `/api/tags` | Tag management |
| GET | `/api/graph` | Graph operations |
| GET | `/api/config` | Current configuration |
| GET | `/api/events/pending` | Pending event queue status |

### REST API System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Discovery/info endpoint |
| GET | `/health` | Health check with D1 + Vectorize status |

### Internal API (service bindings, no auth)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/internal/observe` | Create a memory (observation or thought) |
| POST | `/internal/find` | Semantic search |
| POST | `/internal/recall` | Get memory by ID |
| GET | `/internal/stats` | Memory statistics |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REASONING_MODEL` | LLM for judge decisions | `@cf/openai/gpt-oss-120b` |
| `DEDUP_MODEL` | LLM for duplicate detection | `@cf/openai/gpt-oss-20b` |
| `DEDUP_THRESHOLD` | Vector similarity threshold for auto-dedup | `0.85` |
| `DEDUP_LOWER_THRESHOLD` | Threshold to trigger LLM dedup check | `0.55` |
| `DEDUP_CONFIDENCE_THRESHOLD` | LLM confidence to reject as duplicate | `0.8` |
| `MIN_SIMILARITY` | Vector search threshold | `0.35` |
| `VIOLATION_CONFIDENCE_THRESHOLD` | LLM confidence for violations | `0.6` |
| `CONFIRM_CONFIDENCE_THRESHOLD` | LLM confidence for confirmations | `0.7` |
| `CLASSIFICATION_CHALLENGE_ENABLED` | Enable memory completeness checks | `true` |
| `CF_ACCESS_TEAM` | Cloudflare Access team name | - |
| `CF_ACCESS_AUD` | Access application AUD tag | - |

### External LLM Endpoint

LLM judge calls use a `CLAUDE_PROXY` service binding by default (worker-to-worker). Alternatively, configure an external endpoint:

| Variable | Description |
|----------|-------------|
| `LLM_JUDGE_URL` | OpenAI-compatible chat completions endpoint |
| `LLM_JUDGE_API_KEY` | Bearer token for authentication (optional) |

### Event Dispatch

| Variable | Description |
|----------|-------------|
| `RESOLVER_TYPE` | `'none'` (default), `'github'`, or `'webhook'` |
| `RESOLVER_GITHUB_REPO` | GitHub repo for issue-based dispatch (e.g., `org/repo`) |
| `RESOLVER_GITHUB_TOKEN` | GitHub token with issue creation permissions |
| `RESOLVER_WEBHOOK_URL` | Where to POST event batches (if webhook type) |
| `RESOLVER_WEBHOOK_TOKEN` | Bearer token for webhook auth (optional) |

## Event Dispatch & Resolution

Events (violations, confirmations, cascades, overdue predictions) accumulate in the `memory_events` table, grouped by session.

**Built-in cron triggers handle dispatch automatically:**

- **Every minute** (`* * * * *`): Finds sessions inactive for 30s, claims their pending events, and dispatches them.
- **Daily at 3 AM UTC** (`0 3 * * *`): Recomputes system stats, finds overdue predictions, and queues `thought:pending_resolution` events.

**Dispatch strategy (GitHub Issues resolver):**
- Violations, confirmations, and cascades are batched together into a single GitHub issue per session.
- Each overdue prediction gets its own GitHub issue for parallel resolution.
- A `memory-resolver` label is applied; GitHub Actions (`memory-resolver.yml`) picks up labeled issues and runs Claude Code to resolve them.

## Resources

Each environment creates:
- **D1 Database**: `pantainos-memory-{env}`
- **KV Namespace**: OAuth state storage
- **Vectorize Indexes** (768 dimensions, cosine):
  - `pantainos-memory-{env}-vectors` - Memory embeddings
  - `pantainos-memory-{env}-invalidates` - Invalidation conditions
  - `pantainos-memory-{env}-confirms` - Confirmation conditions
- **Queue**: `pantainos-memory-{env}-detection` (exposure check jobs)
- **Analytics Engine**: `memory_{worker}_{env}` (per-worker analytics)
