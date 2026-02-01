# CLAUDE.md

Instructions for Claude Code when working in this repository.

## Project Overview

Pantainos Memory - Zettelkasten-style knowledge graph for AI agents. Cloudflare Worker with D1, Vectorize, and Workers AI.

## Development Commands

```bash
pnpm install      # Install dependencies
pnpm dev          # Run locally (connects to remote dev resources)
pnpm build        # Build worker bundles to dist/
pnpm test         # Run tests
```

## Deployment

Infrastructure is managed via OpenTofu (Terraform) with Cloudflare provider v5.

```bash
cd infra
tofu init -backend-config=dev.s3.tfbackend
tofu plan -var="environment=dev"
tofu apply -var="environment=dev"
```

## Known Issues

### Cloudflare Terraform Provider v5 Bugs

**`cloudflare_queue_consumer` resource is broken** (as of Feb 2026)
- Error: `400 Bad Request - Could not parse request body`
- The v5 provider sends malformed API requests for queue consumers
- **Workaround**: Use `terraform_data` with wrangler CLI (see `main.tf`)
- Track: https://github.com/cloudflare/terraform-provider-cloudflare/issues/5573

**`cloudflare_queue` destroy ordering is broken**
- Queue can't be deleted while workers have producer bindings to it
- Terraform tries to delete queue and worker in parallel, causing failures
- **Workaround**: Manage queue via `terraform_data` + wrangler with destroy provisioner

**Worker subdomain disabled by default**
- When importing existing workers, `subdomain.enabled` defaults to `false`
- Must explicitly set `subdomain = { enabled = true }` in `cloudflare_worker` resource

**D1 `read_replication` state drift**
- Provider tries to manage `read_replication` but API rejects null values
- **Workaround**: Add lifecycle rule:
  ```hcl
  lifecycle {
    ignore_changes = [primary_location_hint, read_replication]
  }
  ```


## Architecture Notes

- Uses v5 worker pattern: `cloudflare_worker` + `cloudflare_worker_version` + `cloudflare_workers_deployment`
- Two workers: API (CF Access protected) and MCP (bypass for tool access)
- Event dispatch requires external scheduler (n8n) - no cron triggers in Terraform
