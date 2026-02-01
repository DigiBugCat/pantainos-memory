# Pantainos Memory - Full Infrastructure via Terraform
#
# Manages everything:
# - D1 database
# - KV namespace
# - Queue + consumer
# - API worker (CF Access enforced)
# - MCP worker (CF Access identity-only)
# - CF Access applications
#
# Prerequisites:
#   pnpm build  (creates dist/index.js and dist/mcp-index.js)
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
  # Uses CLOUDFLARE_API_TOKEN
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

  # Resource names
  api_worker_name = local.is_prod ? "memory" : "memory-${var.environment}"
  mcp_worker_name = local.is_prod ? "memory-mcp" : "memory-mcp-${var.environment}"
  d1_name         = local.is_prod ? "memory" : "memory-${var.environment}"
  kv_name         = "${local.api_worker_name}-oauth"
  queue_name      = "${local.api_worker_name}-detection"

  # Vectorize index names
  vectorize_vectors     = "${local.api_worker_name}-vectors"
  vectorize_invalidates = "${local.api_worker_name}-invalidates"
  vectorize_confirms    = "${local.api_worker_name}-confirms"

  # Worker URLs
  api_url = "${local.api_worker_name}.pantainos.workers.dev"
  mcp_url = "${local.mcp_worker_name}.pantainos.workers.dev"
}

# =============================================================================
# OTP Identity Provider
# =============================================================================

resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  count      = local.otp_exists ? 0 : 1
  account_id = var.account_id
  name       = "One-Time PIN"
  type       = "onetimepin"
  config     = {}
}

# =============================================================================
# D1 Database
# =============================================================================

resource "cloudflare_d1_database" "memory" {
  account_id = var.account_id
  name       = local.d1_name
}

# =============================================================================
# KV Namespace
# =============================================================================

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = local.kv_name
}

# =============================================================================
# Queue
# =============================================================================

resource "cloudflare_queue" "detection" {
  account_id = var.account_id
  name       = local.queue_name
}

# =============================================================================
# Vectorize Indexes (via wrangler - TF provider doesn't support)
# =============================================================================

resource "terraform_data" "vectorize_vectors" {
  provisioner "local-exec" {
    command = "wrangler vectorize create ${local.vectorize_vectors} --dimensions=768 --metric=cosine 2>/dev/null || true"
  }
}

resource "terraform_data" "vectorize_invalidates" {
  provisioner "local-exec" {
    command = "wrangler vectorize create ${local.vectorize_invalidates} --dimensions=768 --metric=cosine 2>/dev/null || true"
  }
}

resource "terraform_data" "vectorize_confirms" {
  provisioner "local-exec" {
    command = "wrangler vectorize create ${local.vectorize_confirms} --dimensions=768 --metric=cosine 2>/dev/null || true"
  }
}

# =============================================================================
# API Worker
# =============================================================================

resource "cloudflare_workers_script" "api" {
  account_id = var.account_id
  script_name = local.api_worker_name
  content    = file("${path.module}/../dist/index.js")

  compatibility_date  = "2024-12-01"
  compatibility_flags = ["nodejs_compat"]

  # D1 binding
  d1_database_binding {
    name        = "DB"
    database_id = cloudflare_d1_database.memory.id
  }

  # KV binding
  kv_namespace_binding {
    name         = "OAUTH_KV"
    namespace_id = cloudflare_workers_kv_namespace.oauth.id
  }

  # Queue producer binding
  queue_binding {
    binding = "DETECTION_QUEUE"
    queue   = cloudflare_queue.detection.name
  }

  # AI binding
  ai_binding {
    name = "AI"
  }

  # Vectorize bindings
  vectorize_binding {
    name       = "MEMORY_VECTORS"
    index_name = local.vectorize_vectors
  }

  vectorize_binding {
    name       = "INVALIDATES_VECTORS"
    index_name = local.vectorize_invalidates
  }

  vectorize_binding {
    name       = "CONFIRMS_VECTORS"
    index_name = local.vectorize_confirms
  }

  # Analytics binding
  analytics_engine_binding {
    name    = "ANALYTICS"
    dataset = "memory_api_${var.environment}"
  }

  # Environment variables
  plain_text_binding {
    name = "REASONING_MODEL"
    text = "@cf/openai/gpt-oss-120b"
  }

  plain_text_binding {
    name = "DEDUP_MODEL"
    text = "@cf/openai/gpt-oss-20b"
  }

  plain_text_binding {
    name = "DEDUP_THRESHOLD"
    text = "0.85"
  }

  plain_text_binding {
    name = "RESOLVER_TYPE"
    text = "none"
  }

  depends_on = [
    terraform_data.vectorize_vectors,
    terraform_data.vectorize_invalidates,
    terraform_data.vectorize_confirms,
  ]
}

# =============================================================================
# API Worker - Cron Triggers
# =============================================================================

resource "cloudflare_workers_cron_trigger" "api_every_minute" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.api.script_name
  schedules   = ["* * * * *"]
}

resource "cloudflare_workers_cron_trigger" "api_daily" {
  account_id  = var.account_id
  script_name = cloudflare_workers_script.api.script_name
  schedules   = ["0 3 * * *"]
}

# =============================================================================
# Queue Consumer (attach to API worker)
# =============================================================================

resource "cloudflare_queue_consumer" "api" {
  account_id = var.account_id
  queue_id   = cloudflare_queue.detection.id
  script_name = cloudflare_workers_script.api.script_name

  settings {
    batch_size       = 10
    max_retries      = 3
    max_wait_time_ms = 5000
  }
}

# =============================================================================
# MCP Worker
# =============================================================================

resource "cloudflare_workers_script" "mcp" {
  account_id  = var.account_id
  script_name = local.mcp_worker_name
  content     = file("${path.module}/../dist/mcp-index.js")

  compatibility_date  = "2024-12-01"
  compatibility_flags = ["nodejs_compat"]

  # D1 binding (shared)
  d1_database_binding {
    name        = "DB"
    database_id = cloudflare_d1_database.memory.id
  }

  # KV binding (shared)
  kv_namespace_binding {
    name         = "OAUTH_KV"
    namespace_id = cloudflare_workers_kv_namespace.oauth.id
  }

  # AI binding
  ai_binding {
    name = "AI"
  }

  # Vectorize bindings (shared)
  vectorize_binding {
    name       = "MEMORY_VECTORS"
    index_name = local.vectorize_vectors
  }

  vectorize_binding {
    name       = "INVALIDATES_VECTORS"
    index_name = local.vectorize_invalidates
  }

  vectorize_binding {
    name       = "CONFIRMS_VECTORS"
    index_name = local.vectorize_confirms
  }

  # Analytics binding
  analytics_engine_binding {
    name    = "ANALYTICS"
    dataset = "memory_mcp_${var.environment}"
  }

  # Environment variables
  plain_text_binding {
    name = "REASONING_MODEL"
    text = "@cf/openai/gpt-oss-120b"
  }

  plain_text_binding {
    name = "DEDUP_MODEL"
    text = "@cf/openai/gpt-oss-20b"
  }

  plain_text_binding {
    name = "DEDUP_THRESHOLD"
    text = "0.85"
  }

  plain_text_binding {
    name = "RESOLVER_TYPE"
    text = "none"
  }

  depends_on = [
    terraform_data.vectorize_vectors,
    terraform_data.vectorize_invalidates,
    terraform_data.vectorize_confirms,
  ]
}

# =============================================================================
# D1 Migration (run schema.sql)
# =============================================================================

resource "terraform_data" "d1_migration" {
  triggers_replace = [
    filemd5("${path.module}/../migrations/schema.sql")
  ]

  provisioner "local-exec" {
    command     = "wrangler d1 execute ${local.d1_name} --remote --file=migrations/schema.sql"
    working_dir = "${path.module}/.."
  }

  depends_on = [cloudflare_d1_database.memory]
}

# =============================================================================
# CF Access - Allowed Users Group
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

  depends_on = [cloudflare_workers_script.api]
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
  auto_redirect_to_identity = false
  session_duration          = "24h"
  app_launcher_visible      = false

  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  # Bypass - passes identity but doesn't block
  policies = [{
    name       = "Pass identity to MCP"
    decision   = "bypass"
    precedence = 1
    include = [{
      everyone = {}
    }]
  }]

  depends_on = [cloudflare_workers_script.mcp]
}
