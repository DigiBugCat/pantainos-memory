# Pantainos Memory - Terraform Outputs
# These values are needed for wrangler secrets

output "cf_access_team" {
  description = "Cloudflare Access team name (for CF_ACCESS_TEAM secret)"
  value       = "pantainos"  # Your Zero Trust organization name
}

output "cf_access_aud_dev" {
  description = "Application AUD tag for dev (for CF_ACCESS_AUD secret)"
  value       = cloudflare_zero_trust_access_application.memory_dev.aud
}

output "cf_access_aud_prod" {
  description = "Application AUD tag for production (for CF_ACCESS_AUD secret)"
  value       = var.create_prod ? cloudflare_zero_trust_access_application.memory_prod[0].aud : null
}

output "dev_url" {
  description = "Dev environment URL"
  value       = "https://memory-dev.pantainos.workers.dev"
}

output "prod_url" {
  description = "Production environment URL"
  value       = "https://memory.pantainos.workers.dev"
}

# Helper: Commands to set secrets
output "set_secrets_commands" {
  description = "Commands to configure wrangler secrets"
  value       = <<-EOT
    # Dev environment
    echo "${cloudflare_zero_trust_access_application.memory_dev.aud}" | wrangler secret put CF_ACCESS_AUD --env dev
    echo "pantainos" | wrangler secret put CF_ACCESS_TEAM --env dev

    # Production environment (if created)
    ${var.create_prod ? "echo \"${cloudflare_zero_trust_access_application.memory_prod[0].aud}\" | wrangler secret put CF_ACCESS_AUD" : "# Production not created yet"}
    ${var.create_prod ? "echo \"pantainos\" | wrangler secret put CF_ACCESS_TEAM" : ""}
  EOT
}
