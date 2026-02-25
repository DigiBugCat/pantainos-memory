# Pantainos Memory

An epistemological memory system for AI agents — a knowledge graph where every belief has a derivation chain back to reality and every claim can be tested, violated, or confirmed over time.

## Why This Exists

LLMs are stateless. Between conversations, everything is lost. Most memory solutions solve this with simple key-value stores or vector databases — dump text in, retrieve text out. That works for recall, but it doesn't capture *how you know what you know* or *how much you should trust it*.

Pantainos Memory treats knowledge like a scientific process:

- **Everything traces back to reality.** Observations come from sources (market data, news, tools, humans). Thoughts are derived from other memories, forming a derivation DAG. You can always trace a belief back to the ground-truth observations it's built on — and if those observations get retracted, the system knows which downstream beliefs are affected.

- **Beliefs are weighted bets, not facts.** Every memory has a confidence score that starts based on its origin (a market data point starts higher than a human rumor) and evolves as the system tests it. Confidence isn't static — it's a survival rate under exposure.

- **The system actively tests itself.** When a new memory arrives, it's checked against existing beliefs. If a new observation contradicts a thought's `invalidates_if` conditions, the system flags a violation. If it matches `confirms_if` conditions, confidence goes up. This happens automatically via a queue-based exposure checker — you don't have to manually cross-reference.

- **Predictions have deadlines.** Any thought can be given a `resolves_by` date and `outcome_condition`, turning it into a prediction. When the deadline passes, the system queues it for resolution. Over time, this builds a track record — which sources are reliable, which reasoning patterns hold up, which don't.

- **Knowledge degrades gracefully.** Violated memories aren't deleted — they're marked, and the violation cascades through the derivation graph so downstream beliefs know their foundation is shaky. Retracted observations propagate damage to everything built on them. The graph self-heals.

The result is a memory system where an agent can ask not just "what do I know about X?" but "how confident should I be?" and "what is this belief based on?" — and get real answers backed by the graph structure, not just vector similarity.

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

There is one unified `memories` table. Type is determined by field presence, not a type column:

- **Observations**: Ground truth from reality. Identified by having a `source` field (market, news, earnings, email, human, tool). These are the leaves of the derivation DAG — everything ultimately traces back to observations.
- **Thoughts**: Derived beliefs. Identified by having a `derived_from` field (array of source memory IDs). Each thought creates edges in the derivation graph back to what it's based on.
  - A thought with `resolves_by` set becomes a **Prediction** — a time-bound claim that enters a pending resolution queue when its deadline passes.

**Exposure checking:** Every new memory is queued for bi-directional exposure checking. New observations are tested against existing thought conditions (`invalidates_if`, `confirms_if`). New thoughts are tested against existing observations. Semantic similarity finds candidates; an LLM judge evaluates whether the match constitutes a real violation or confirmation. Significant findings generate events that get dispatched for resolution.

**Confidence model:** Starting confidence is set by origin — observations inherit from their source's track record (market data starts at ~0.75, human input at ~0.50), thoughts start at 0.40, predictions at 0.35. As the system tests memories through exposure checks, `times_tested` and `confirmations` accumulate. The effective confidence becomes a survival rate. A daily cron job recomputes system-wide stats and per-source track records, so learned confidence feeds back into future starting scores.

**Cascade propagation:** When a memory is resolved, violated, or retracted, the effects propagate through the derivation graph. If an observation is retracted, every thought built on it gets flagged. If a prediction is resolved as incorrect, downstream beliefs that assumed it are weakened. The graph structure makes these cascades precise — only actually-dependent memories are affected.

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
| `EXPOSURE_LLM_MAX_CONCURRENCY` | Max concurrent exposure LLM checks per request | `6` |
| `CLASSIFICATION_CHALLENGE_ENABLED` | Enable memory completeness checks | `true` |
| `CF_ACCESS_TEAM` | Cloudflare Access team name | - |
| `CF_ACCESS_AUD` | Access application AUD tag | - |

### LLM Judge Endpoint

LLM judge calls (exposure checking, dedup, classification) use an OpenAI-compatible endpoint. Falls back to Workers AI if not configured.

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_JUDGE_URL` | OpenAI-compatible chat completions endpoint | - |
| `LLM_JUDGE_API_KEY` | Bearer token for authentication | - |
| `LLM_JUDGE_MODEL` | Model name to use | `gpt-5-mini` |

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
