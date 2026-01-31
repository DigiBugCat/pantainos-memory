# Pantainos Memory

Zettelkasten-style knowledge graph for AI agents. Cloudflare Worker with D1, Vectorize, and Workers AI.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                      │
│                                                          │
│  POST /         - MCP Streamable HTTP (OAuth protected) │
│  /mcp           - MCP JSON-RPC endpoint                 │
│  /api/*         - REST API                              │
│  /internal/*    - Service binding API                   │
│  /authorize     - OAuth authorization                   │
│  /token         - OAuth token exchange                  │
│                                                          │
│  Queue Consumer → Exposure Check Workflow               │
│  Cron Triggers  → Inactivity Detection                  │
└─────────────────────────────────────────────────────────┘
         │              │                │
         ▼              ▼                ▼
    ┌────────┐    ┌──────────┐    ┌───────────┐
    │   D1   │    │ Vectorize │    │ Workers AI │
    │(SQLite)│    │ (768-dim) │    │ (Embeddings│
    └────────┘    └──────────┘    │  + Judge)  │
         │                         └───────────┘
         │
    ┌────────┐
    │   KV   │
    │(OAuth) │
    └────────┘
```

## Concepts

**Two memory primitives:**
- **Observations** (`obs`): Facts from reality (market data, news, user input)
- **Assumptions**: Derived beliefs that can be tested against future observations

**Exposure checking:** When new observations arrive, the system checks if they violate or confirm existing assumptions using semantic similarity + LLM judge.

## Authentication

MCP OAuth 2.0 backed by Cloudflare Access. Configure these environment variables:

| Variable | Description |
|----------|-------------|
| `CF_ACCESS_TEAM` | Your Cloudflare Access team name |
| `CF_ACCESS_AUD` | Application Audience (AUD) tag from Access |
| `ISSUER_URL` | (Optional) Override OAuth issuer URL |

OAuth endpoints:
- `/.well-known/oauth-authorization-server` - Authorization server metadata
- `/.well-known/oauth-protected-resource` - Protected resource metadata
- `/register` - Dynamic client registration
- `/authorize` - Authorization endpoint
- `/token` - Token endpoint

## Development

```bash
# Install dependencies
pnpm install

# Create dev environment (D1, Vectorize, Queue, KV)
pnpm dev:up

# Run locally (connects to remote dev resources)
pnpm dev

# Tear down dev environment
pnpm dev:down
```

## Deployment

```bash
# Deploy to dev
pnpm deploy:dev

# Deploy to production
pnpm deploy
```

## API Endpoints

### MCP (Model Context Protocol)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/` | MCP Streamable HTTP transport (OAuth protected) |
| POST | `/mcp` | MCP JSON-RPC endpoint |

**MCP Tools exposed:**
- `note` - Store a new memory
- `recall` - Retrieve memory by ID
- `find` - Semantic search
- `connect` - Link memories
- `reference` - Follow memory graph
- `insights` - Memory statistics
- ... and more

### Internal API (for service bindings)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/internal/observe` | Record an observation |
| POST | `/internal/assume` | Create a testable assumption |
| POST | `/internal/find` | Semantic search across memories |
| POST | `/internal/recall` | Get memory by ID |
| GET | `/internal/stats` | Memory statistics |

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with dependency status |
| GET | `/api/stats` | Memory statistics |
| GET | `/api/config` | Current configuration |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `REASONING_MODEL` | LLM for judge decisions | `@cf/openai/gpt-oss-120b` |
| `MIN_SIMILARITY` | Vector search threshold | `0.35` |
| `VIOLATION_CONFIDENCE_THRESHOLD` | LLM confidence for violations | `0.6` |
| `CONFIRM_CONFIDENCE_THRESHOLD` | LLM confidence for confirmations | `0.7` |
| `CF_ACCESS_TEAM` | Cloudflare Access team name | - |
| `CF_ACCESS_AUD` | Access application AUD tag | - |

## Resources

Each environment creates:
- **D1 Database**: `pantainos-memory-{env}`
- **KV Namespace**: OAuth state storage
- **Vectorize Indexes** (768 dimensions, cosine):
  - `pantainos-memory-{env}-vectors` - Memory embeddings
  - `pantainos-memory-{env}-invalidates` - Invalidation conditions
  - `pantainos-memory-{env}-confirms` - Confirmation conditions
- **Queue**: `pantainos-memory-{env}-detection`
