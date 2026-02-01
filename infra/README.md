# Pantainos Memory Infrastructure

Terraform/OpenTofu configuration for Cloudflare Access.

## Architecture

Two workers with separated concerns:

| Worker | URL | CF Access | Purpose |
|--------|-----|-----------|---------|
| `memory-{env}` | `memory-{env}.pantainos.workers.dev` | **Enforced** | REST API |
| `memory-mcp-{env}` | `memory-mcp-{env}.pantainos.workers.dev` | Identity-only | MCP protocol |

The MCP worker uses CF Access for user identification but relies on MCP OAuth for actual authentication, avoiding cookie issues with MCP clients.

## Deployment Flow

1. **Deploy workers via wrangler** (handles D1, KV, Queue, Vectorize):
   ```bash
   # Build
   pnpm build

   # Deploy API worker
   wrangler deploy --env dev

   # Deploy MCP worker
   wrangler deploy --config wrangler-mcp.toml --env dev
   ```

2. **Apply CF Access via Terraform**:
   ```bash
   cd infra
   tofu init
   tofu apply -var="environment=dev"
   ```

## Prerequisites

**Cloudflare API Token** with permissions:
- Zero Trust: Edit (for CF Access apps)
- Account Settings: Read (for identity providers)

## Usage

```bash
cd infra

# Initialize
tofu init

# Dev environment
tofu apply -var="environment=dev"

# Production
tofu apply -var="environment=prod"

# Destroy
tofu destroy -var="environment=dev"
```

## Using Workspaces

For managing separate state per environment:

```bash
# Create workspaces
tofu workspace new dev
tofu workspace new prod

# Switch and apply
tofu workspace select dev
tofu apply -var="environment=dev"
```

## Files

| File | Purpose |
|------|---------|
| `main.tf` | CF Access apps and groups |
| `variables.tf` | Input variables |
| `outputs.tf` | AUD values for workers |
| `terraform.tfvars` | Your config (gitignored) |

## Outputs

After applying, you'll get:
- `api_url` - API worker URL
- `mcp_url` - MCP worker URL
- `cf_access_aud_api` - AUD for API worker (set as secret)
- `cf_access_aud_mcp` - AUD for MCP worker (set as secret)
