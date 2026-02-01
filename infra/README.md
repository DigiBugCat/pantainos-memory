# Pantainos Memory Infrastructure

Full infrastructure managed via Terraform/OpenTofu with shared R2 backend.

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

1. **R2 Backend Setup** (one-time, from terraform-bootstrap):
   ```bash
   export AWS_ACCESS_KEY_ID="<R2_ACCESS_KEY_ID>"
   export AWS_SECRET_ACCESS_KEY="<R2_SECRET_ACCESS_KEY>"
   export AWS_REGION="auto"
   ```

2. **Cloudflare API Token** with permissions:
   - Workers Scripts: Edit
   - D1: Edit
   - Workers KV Storage: Edit
   - Queues: Edit
   - Zero Trust: Edit
   - Analytics Engine: Edit

3. **Build the workers:**
   ```bash
   pnpm build
   ```

4. **Create terraform.tfvars:**
   ```bash
   cp terraform.tfvars.example terraform.tfvars
   # Edit with your values
   ```

## Deployment

```bash
cd infra

# Initialize with backend (first time)
tofu init -backend-config=dev.s3.tfbackend

# Build workers
cd .. && pnpm build && cd infra

# Deploy dev
tofu apply -var="environment=dev"
```

## Switching Environments

```bash
# Switch to production (use -reconfigure when changing backends)
tofu init -backend-config=production.s3.tfbackend -reconfigure
tofu apply -var="environment=prod"

# Switch back to dev
tofu init -backend-config=dev.s3.tfbackend -reconfigure
tofu apply -var="environment=dev"
```

## State Storage

State is stored in the shared R2 bucket from `terraform-bootstrap`:

```
terraform-state/
├── dev/
│   └── memory/terraform.tfstate
└── production/
    └── memory/terraform.tfstate
```

## Destroying

```bash
tofu init -backend-config=dev.s3.tfbackend -reconfigure
tofu destroy -var="environment=dev"
```

## Outputs

After apply:
- `api_url` - API endpoint (protected by CF Access)
- `mcp_url` - MCP endpoint (for Claude Code)
- `d1_database_id` - Database ID
- `kv_namespace_id` - KV ID
- `queue_id` - Queue ID
- `cf_access_aud_api` - AUD for API
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

## Files

| File | Purpose |
|------|---------|
| `main.tf` | All resources |
| `variables.tf` | Input variables |
| `outputs.tf` | Output values |
| `backend.tf` | R2 backend config |
| `dev.s3.tfbackend` | Dev state key |
| `production.s3.tfbackend` | Prod state key |
| `terraform.tfvars` | Your config (gitignored) |

## Notes

- **Vectorize**: Created via `wrangler` CLI (TF provider doesn't support natively)
- **D1 Migrations**: Automatically run when `schema.sql` changes
- **Workers**: Must rebuild (`pnpm build`) before `tofu apply` if code changed
- **Locking**: Uses OpenTofu 1.10+ native S3 locking via R2
