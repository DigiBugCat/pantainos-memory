# Pantainos Memory - Terraform Outputs

output "environment" {
  description = "Current environment"
  value       = var.environment
}

output "api_url" {
  description = "API worker URL (CF Access enforced)"
  value       = "https://${local.api_url}"
}

output "mcp_url" {
  description = "MCP worker URL (CF Access identity-only, MCP OAuth)"
  value       = "https://${local.mcp_url}"
}

output "cf_access_aud_api" {
  description = "CF Access AUD for API worker"
  value       = cloudflare_zero_trust_access_application.api.aud
}

output "cf_access_aud_mcp" {
  description = "CF Access AUD for MCP worker"
  value       = cloudflare_zero_trust_access_application.mcp.aud
}
