# Pantainos Memory

Zettelkasten-style knowledge graph for AI agents. Cloudflare Worker with D1, Vectorize, and Workers AI.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Worker                      │
│                                                          │
│  /api/*        - Public API (observations, queries)     │
│  /internal/*   - Service binding API (for n8n)          │
│  /health       - Health check                           │
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
                                   └───────────┘
```

## Concepts

**Two memory primitives:**
- **Observations** (`obs`): Facts from reality (market data, news, user input)
- **Assumptions**: Derived beliefs that can be tested against future observations

**Exposure checking:** When new observations arrive, the system checks if they violate or confirm existing assumptions using semantic similarity + LLM judge.

## Security

**This worker has no built-in authentication.** Protect with Cloudflare Access before exposing to the internet.

1. Create Access Application for the worker domain
2. Create Service Token for machine-to-machine access
3. Clients send `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers

See: https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/

## Development

```bash
# Install dependencies
pnpm install

# Create dev environment (D1, Vectorize, Queue)
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

### Internal API (for n8n via service binding)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/internal/observe` | Record an observation |
| POST | `/internal/assume` | Create a testable assumption |
| POST | `/internal/find` | Semantic search across memories |
| POST | `/internal/recall` | Get memory by ID |
| GET | `/internal/stats` | Memory statistics |

### Public API

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

## Resources

Each environment creates:
- **D1 Database**: `pantainos-memory-{env}`
- **Vectorize Indexes** (768 dimensions, cosine):
  - `pantainos-memory-{env}-vectors` - Memory embeddings
  - `pantainos-memory-{env}-invalidates` - Invalidation conditions
  - `pantainos-memory-{env}-confirms` - Confirmation conditions
- **Queue**: `pantainos-memory-{env}-detection`
