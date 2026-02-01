# Pantainos Memory Infrastructure

Full infrastructure managed via Terraform/OpenTofu.

## What Gets Created

| Resource | Name Pattern | Purpose |
|----------|--------------|---------|
| D1 Database | `memory-{env}` | SQLite storage |
| KV Namespace | `memory-{env}-oauth` | OAuth state |
| Queue | `memory-{env}-detection` | Async processing |
| Vectorize | `memory-{env}-{vectors,invalidates,confirms}` | Embeddings |
| API Worker | `memory-{env}` | REST API |
| MCP Worker | `memory-mcp-{env}` | MCP protocol |
| CF Access (API) | Enforced | Blocks unauthorized |
| CF Access (MCP) | Bypass | Passes identity only |

## Prerequisites

1. **Cloudflare API Token** with permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers KV Storage: Edit
   - Queues: Edit
   - Zero Trust: Edit
   - Analytics Engine: Edit

2. **Build the workers first:**
   ```bash
   pnpm build
   ```
   This creates `dist/index.js` and `dist/mcp-index.js`.

3. **Create terraform.tfvars:**
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Edit with your values
   ```

## Deployment

```bash
cd infra

# Initialize (first time only)
tofu init

# Build workers
cd .. && pnpm build && cd infra

# Deploy dev
tofu apply -var="environment=dev"

# Deploy production
tofu apply -var="environment=prod"
```

## Using Workspaces (Recommended)

Workspaces keep state separate per environment:

```bash
# Create workspaces
tofu workspace new dev
tofu workspace new prod

# Deploy to dev
tofu workspace select dev
tofu apply -var="environment=dev"

# Deploy to prod
tofu workspace select prod
tofu apply -var="environment=prod"
```

## Destroying

```bash
# Destroy specific environment
tofu workspace select dev
tofu destroy -var="environment=dev"
```

## Outputs

After apply, you'll get:
- `api_url` - API endpoint (protected by CF Access)
- `mcp_url` - MCP endpoint (for Claude Code)
- `d1_database_id` - Database ID
- `kv_namespace_id` - KV ID
- `queue_id` - Queue ID
- `cf_access_aud_api` - AUD for API (if needed for secrets)
- `cf_access_aud_mcp` - AUD for MCP
- `vectorize_indexes` - Index names

## MCP Configuration

Add to Claude Code's MCP settings:
```json
{
  "mcpServers": {
    "memory": {
      "url": "https://memory-mcp-dev.pantainos.workers.dev/mcp"
    }
  }
}
```

## Notes

- **Vectorize**: Created via `wrangler` CLI (TF provider doesn't support natively)
- **D1 Migrations**: Automatically run when `schema.sql` changes
- **Workers**: Must rebuild (`pnpm build`) before each `tofu apply` if code changed
