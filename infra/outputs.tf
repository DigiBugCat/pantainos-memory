# Pantainos Memory - Terraform Outputs

output "environment" {
  description = "Current environment"
  value       = var.environment
}

# URLs
output "api_url" {
  description = "API worker URL (CF Access enforced)"
  value       = "https://${local.api_url}"
}

output "mcp_url" {
  description = "MCP worker URL (MCP OAuth + CF Access identity)"
  value       = "https://${local.mcp_url}"
}

# Resource IDs
output "d1_database_id" {
  description = "D1 database ID"
  value       = cloudflare_d1_database.memory.id
}

output "kv_namespace_id" {
  description = "KV namespace ID"
  value       = cloudflare_workers_kv_namespace.oauth.id
}

output "queue_id" {
  description = "Queue ID"
  value       = cloudflare_queue.detection.id
}

# CF Access
output "cf_access_aud_api" {
  description = "CF Access AUD for API worker"
  value       = cloudflare_zero_trust_access_application.api.aud
}

output "cf_access_aud_mcp" {
  description = "CF Access AUD for MCP worker"
  value       = cloudflare_zero_trust_access_application.mcp.aud
}

# Vectorize names (for reference)
output "vectorize_indexes" {
  description = "Vectorize index names"
  value = {
    vectors     = local.vectorize_vectors
    invalidates = local.vectorize_invalidates
    confirms    = local.vectorize_confirms
  }
}
