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

# Resource IDs
output "d1_database_id" {
  description = "D1 database ID"
  value       = cloudflare_d1_database.memory.id
}

output "queue_name" {
  description = "Queue name"
  value       = local.queue_name
}

# CF Access
output "cf_access_aud_api" {
  description = "CF Access AUD for API worker"
  value       = cloudflare_zero_trust_access_application.api.aud
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

# Service Token for FastMCP proxy access
output "mcp_service_token_id" {
  description = "CF Access service token ID for FastMCP"
  value       = cloudflare_zero_trust_access_service_token.mcp.client_id
}

output "mcp_service_token_secret" {
  description = "CF Access service token secret for FastMCP"
  value       = cloudflare_zero_trust_access_service_token.mcp.client_secret
  sensitive   = true
}
