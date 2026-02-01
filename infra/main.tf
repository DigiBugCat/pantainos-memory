# Pantainos Memory - Cloudflare Access Configuration
#
# Manages CF Access for the two-worker architecture:
# - memory-api: REST API worker, CF Access enforced
# - memory-mcp: MCP protocol worker, CF Access identity-only (bypass)
#
# Workers and infrastructure (D1, KV, Queue, Vectorize) are deployed via wrangler.
#
# Usage:
#   tofu init
#   tofu apply -var="environment=dev"
#   tofu apply -var="environment=prod"

terraform {
  required_version = ">= 1.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  # Uses CLOUDFLARE_API_TOKEN or CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY
}

# =============================================================================
# Data Sources
# =============================================================================

data "cloudflare_zero_trust_access_identity_providers" "all" {
  account_id = var.account_id
}

locals {
  # Find existing OTP provider
  existing_otp = [for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : idp if idp.type == "onetimepin"]
  otp_exists   = length(local.existing_otp) > 0
  otp_id       = local.otp_exists ? local.existing_otp[0].id : cloudflare_zero_trust_access_identity_provider.otp[0].id

  # Environment-based naming
  is_prod    = var.environment == "prod"
  env_suffix = local.is_prod ? "" : "-${var.environment}"

  # Worker names (must match wrangler.toml)
  api_worker_name = local.is_prod ? "memory" : "memory-${var.environment}"
  mcp_worker_name = local.is_prod ? "memory-mcp" : "memory-mcp-${var.environment}"

  # Worker URLs
  api_url = "${local.api_worker_name}.pantainos.workers.dev"
  mcp_url = "${local.mcp_worker_name}.pantainos.workers.dev"
}

# =============================================================================
# OTP Identity Provider (create if doesn't exist)
# =============================================================================

resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  count      = local.otp_exists ? 0 : 1
  account_id = var.account_id
  name       = "One-Time PIN"
  type       = "onetimepin"
  config     = {}
}

# =============================================================================
# Access Group - Allowed Users
# =============================================================================

resource "cloudflare_zero_trust_access_group" "memory_users" {
  account_id = var.account_id
  name       = "memory-allowed-users${local.env_suffix}"

  include = [
    for email in var.allowed_emails : {
      email = {
        email = email
      }
    }
  ]
}

# =============================================================================
# CF Access - API Worker (Enforced)
# =============================================================================

resource "cloudflare_zero_trust_access_application" "api" {
  account_id = var.account_id
  name       = "Memory API${local.is_prod ? "" : " (${title(var.environment)})"}"
  type       = "self_hosted"
  domain     = local.api_url

  allowed_idps              = [local.otp_id]
  auto_redirect_to_identity = true
  session_duration          = "24h"
  app_launcher_visible      = true

  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  policies = [{
    name       = "Allow authorized users"
    decision   = "allow"
    precedence = 1
    include = [{
      group = {
        id = cloudflare_zero_trust_access_group.memory_users.id
      }
    }]
  }]
}

# =============================================================================
# CF Access - MCP Worker (Identity-Only / Bypass)
# =============================================================================

resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id = var.account_id
  name       = "Memory MCP${local.is_prod ? "" : " (${title(var.environment)})"}"
  type       = "self_hosted"
  domain     = local.mcp_url

  allowed_idps              = [local.otp_id]
  auto_redirect_to_identity = false  # Don't force login - MCP OAuth handles auth
  session_duration          = "24h"
  app_launcher_visible      = false  # Not user-facing

  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  # Bypass policy - passes identity headers but doesn't block
  # MCP OAuth handles actual authentication
  policies = [{
    name       = "Pass identity to MCP"
    decision   = "bypass"
    precedence = 1
    include = [{
      everyone = {}
    }]
  }]
}
