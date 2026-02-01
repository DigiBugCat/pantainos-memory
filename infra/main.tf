# Pantainos Memory - Cloudflare Access Configuration
# Creates Zero Trust Access application for MCP OAuth authentication

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

# Look up existing OTP identity provider (one per account)
data "cloudflare_zero_trust_access_identity_providers" "all" {
  account_id = var.account_id
}

locals {
  # Find existing OTP provider
  existing_otp = [for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : idp if idp.type == "onetimepin"]
  otp_exists   = length(local.existing_otp) > 0
  otp_id       = local.otp_exists ? local.existing_otp[0].id : cloudflare_zero_trust_access_identity_provider.otp[0].id

  # Worker URLs
  dev_url  = "memory-dev.pantainos.workers.dev"
  prod_url = "memory.pantainos.workers.dev"
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
  name       = "memory-allowed-users"

  include = [
    for email in var.allowed_emails : {
      email = {
        email = email
      }
    }
  ]
}

# =============================================================================
# Access Application - Dev Environment
# =============================================================================

resource "cloudflare_zero_trust_access_application" "memory_dev" {
  account_id = var.account_id
  name       = "Memory MCP (Dev)"
  type       = "self_hosted"

  # Primary domain for login redirect
  domain = local.dev_url

  # Only protect specific paths - leave public endpoints unprotected
  destinations = [
    {
      type = "public"
      uri  = "${local.dev_url}/mcp"
    },
    {
      type = "public"
      uri  = "${local.dev_url}/mcp/*"
    },
    {
      type = "public"
      uri  = "${local.dev_url}/api/*"
    },
  ]

  allowed_idps              = [local.otp_id]
  auto_redirect_to_identity = true
  session_duration          = "24h"
  app_launcher_visible      = true

  # Security settings
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  # Allow authorized users
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
# Access Application - Production Environment
# =============================================================================

resource "cloudflare_zero_trust_access_application" "memory_prod" {
  count = var.create_prod ? 1 : 0

  account_id = var.account_id
  name       = "Memory MCP (Prod)"
  type       = "self_hosted"

  # Primary domain for login redirect
  domain = local.prod_url

  # Only protect specific paths - leave public endpoints unprotected
  destinations = [
    {
      type = "public"
      uri  = "${local.prod_url}/mcp"
    },
    {
      type = "public"
      uri  = "${local.prod_url}/mcp/*"
    },
    {
      type = "public"
      uri  = "${local.prod_url}/api/*"
    },
  ]

  allowed_idps              = [local.otp_id]
  auto_redirect_to_identity = true
  session_duration          = "24h"
  app_launcher_visible      = true

  # Security settings
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  # Allow authorized users
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
