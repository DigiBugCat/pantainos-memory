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
#   tofu init -backend-config=dev.s3.tfbackend
#   tofu apply -var="environment=dev"

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
  # Find existing Google identity provider
  existing_google = [for idp in data.cloudflare_zero_trust_access_identity_providers.all.result : idp if idp.type == "google"]
  google_id       = local.existing_google[0].id

  # Environment-based naming
  is_prod    = var.environment == "prod"
  env_suffix = local.is_prod ? "" : "-${var.environment}"

  # Resource names (base: pantainos-memory)
  api_worker_name = local.is_prod ? "pantainos-memory" : "pantainos-memory-${var.environment}"
  mcp_worker_name = local.is_prod ? "pantainos-memory-mcp" : "pantainos-memory-mcp-${var.environment}"
  d1_name         = local.is_prod ? "pantainos-memory" : "pantainos-memory-${var.environment}"
  kv_name         = "${local.api_worker_name}-oauth"
  queue_name      = "${local.api_worker_name}-detection"

  # Vectorize index names
  vectorize_vectors     = "${local.api_worker_name}-vectors"
  vectorize_invalidates = "${local.api_worker_name}-invalidates"
  vectorize_confirms    = "${local.api_worker_name}-confirms"

  # Worker URLs
  api_url = "${local.api_worker_name}.pantainos.workers.dev"
  mcp_url = "${local.mcp_worker_name}.pantainos.workers.dev"

  # Common bindings for workers
  common_bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.memory.id },
    { type = "kv_namespace", name = "OAUTH_KV", namespace_id = cloudflare_workers_kv_namespace.oauth.id },
    { type = "ai", name = "AI" },
    { type = "vectorize", name = "MEMORY_VECTORS", index_name = local.vectorize_vectors },
    { type = "vectorize", name = "INVALIDATES_VECTORS", index_name = local.vectorize_invalidates },
    { type = "vectorize", name = "CONFIRMS_VECTORS", index_name = local.vectorize_confirms },
    { type = "plain_text", name = "REASONING_MODEL", text = "@cf/openai/gpt-oss-120b" },
    { type = "plain_text", name = "DEDUP_MODEL", text = "@cf/openai/gpt-oss-20b" },
    { type = "plain_text", name = "DEDUP_THRESHOLD", text = "0.85" },
    { type = "plain_text", name = "RESOLVER_TYPE", text = "none" },
    { type = "plain_text", name = "CF_ACCESS_TEAM", text = var.cf_access_team },
    { type = "plain_text", name = "CLASSIFICATION_CHALLENGE_ENABLED", text = "true" },
    { type = "plain_text", name = "LLM_JUDGE_URL", text = var.llm_judge_url },
    { type = "secret_text", name = "LLM_JUDGE_CF_CLIENT_ID", text = var.llm_judge_cf_client_id },
    { type = "secret_text", name = "LLM_JUDGE_CF_CLIENT_SECRET", text = var.llm_judge_cf_client_secret },
  ]
}

# Note: Google identity provider is configured at the account level
# and referenced via data source (local.google_id)

# =============================================================================
# D1 Database
# =============================================================================

resource "cloudflare_d1_database" "memory" {
  account_id = var.account_id
  name       = local.d1_name

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [primary_location_hint, read_replication]
  }
}

# =============================================================================
# KV Namespace
# =============================================================================

resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = local.kv_name
}

# =============================================================================
# Queue (via wrangler - TF provider v5 has destroy ordering issues)
# =============================================================================

resource "terraform_data" "queue" {
  input = {
    queue_name = local.queue_name
  }

  provisioner "local-exec" {
    command = "wrangler queues create ${local.queue_name} 2>/dev/null || true"
  }

  # Delete queue on destroy - runs after workers are gone
  provisioner "local-exec" {
    when    = destroy
    command = "wrangler queues delete ${self.input.queue_name} 2>/dev/null || true"
  }
}


# =============================================================================
# Vectorize Indexes (via wrangler - TF provider doesn't support natively)
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
# API Worker (v5 pattern: worker + version + deployment)
# =============================================================================

resource "cloudflare_worker" "api" {
  account_id = var.account_id
  name       = local.api_worker_name

  subdomain = {
    enabled = true
  }
}

resource "cloudflare_worker_version" "api" {
  account_id  = var.account_id
  worker_id   = cloudflare_worker.api.id
  main_module = "index.js"

  modules = [{
    name         = "index.js"
    content_file = "${path.module}/../dist/index.js"
    content_type = "application/javascript+module"
  }]

  bindings = concat(local.common_bindings, [
    { type = "queue", name = "DETECTION_QUEUE", queue_name = local.queue_name },
    { type = "analytics_engine", name = "ANALYTICS", dataset = "pantainos_memory_api_${var.environment}" },
    { type = "plain_text", name = "CF_ACCESS_AUD", text = cloudflare_zero_trust_access_application.api.aud },
  ])

  compatibility_date  = "2024-12-01"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [
    terraform_data.queue,
    terraform_data.vectorize_vectors,
    terraform_data.vectorize_invalidates,
    terraform_data.vectorize_confirms,
  ]
}

resource "cloudflare_workers_deployment" "api" {
  account_id  = var.account_id
  script_name = cloudflare_worker.api.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.api.id
    percentage = 100
  }]
}

# =============================================================================
# Queue Consumer (via wrangler - TF provider v5 has bugs with this resource)
# =============================================================================

resource "terraform_data" "queue_consumer" {
  triggers_replace = [
    cloudflare_worker.api.name,
    local.queue_name,
  ]

  # Store values for destroy-time provisioner
  input = {
    queue_name  = local.queue_name
    worker_name = cloudflare_worker.api.name
  }

  provisioner "local-exec" {
    command = "wrangler queues consumer add ${local.queue_name} ${cloudflare_worker.api.name} 2>/dev/null || true"
  }

  # Remove consumer on destroy (must happen before worker/queue deletion)
  provisioner "local-exec" {
    when    = destroy
    command = "wrangler queues consumer remove ${self.input.queue_name} ${self.input.worker_name} 2>/dev/null || true"
  }

  depends_on = [cloudflare_workers_deployment.api]
}

# =============================================================================
# MCP Worker (v5 pattern: worker + version + deployment)
# =============================================================================

resource "cloudflare_worker" "mcp" {
  account_id = var.account_id
  name       = local.mcp_worker_name

  subdomain = {
    enabled = true
  }
}

resource "cloudflare_worker_version" "mcp" {
  account_id  = var.account_id
  worker_id   = cloudflare_worker.mcp.id
  main_module = "mcp-index.js"

  modules = [{
    name         = "mcp-index.js"
    content_file = "${path.module}/../dist/mcp-index.js"
    content_type = "application/javascript+module"
  }]

  bindings = concat(local.common_bindings, [
    { type = "queue", name = "DETECTION_QUEUE", queue_name = local.queue_name },
    { type = "analytics_engine", name = "ANALYTICS", dataset = "pantainos_memory_mcp_${var.environment}" },
    { type = "plain_text", name = "CF_ACCESS_AUD", text = cloudflare_zero_trust_access_application.mcp.aud },
  ])

  compatibility_date  = "2024-12-01"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [
    terraform_data.queue,
    terraform_data.vectorize_vectors,
    terraform_data.vectorize_invalidates,
    terraform_data.vectorize_confirms,
  ]
}

resource "cloudflare_workers_deployment" "mcp" {
  account_id  = var.account_id
  script_name = cloudflare_worker.mcp.name
  strategy    = "percentage"

  versions = [{
    version_id = cloudflare_worker_version.mcp.id
    percentage = 100
  }]
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
  name       = "pantainos-memory-allowed-users${local.env_suffix}"

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
  name       = "Pantainos Memory API${local.is_prod ? "" : " (${title(var.environment)})"}"
  type       = "self_hosted"
  domain     = local.api_url

  allowed_idps              = [local.google_id]
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

  # No depends_on - Access app can be created before worker exists
  # This allows worker to reference the AUD in its bindings
}

# =============================================================================
# CF Access - MCP Worker (Path-based protection for /authorize only)
# =============================================================================
#
# MCP OAuth flow requires:
# - GET /           → Worker returns MCP info (no CF Access)
# - POST /register  → Client registration (no CF Access)
# - GET /authorize  → CF Access OTP login → Worker issues auth code
# - POST /token     → Token exchange (no CF Access)
# - POST /mcp       → Worker validates OAuth Bearer token (no CF Access)
#
# Path-based CF Access protects only /authorize, allowing OAuth endpoints
# to remain accessible while using CF Access for user authentication.

resource "cloudflare_zero_trust_access_application" "mcp" {
  account_id = var.account_id
  name       = "Pantainos Memory MCP${local.is_prod ? "" : " (${title(var.environment)})"}"
  type       = "self_hosted"

  # PATH-BASED: Only protect /authorize endpoint
  domain = "${local.mcp_url}/authorize"

  allowed_idps              = [local.google_id]
  auto_redirect_to_identity = true # Redirect to OTP login
  session_duration          = "24h"
  app_launcher_visible      = false

  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  # Allow policy - shows login page for authorized users
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

  # No depends_on - Access app can be created before worker exists
}

# =============================================================================
# CF Access - Service Token for MCP
# =============================================================================

resource "cloudflare_zero_trust_access_service_token" "mcp" {
  account_id = var.account_id
  name       = "pantainos-memory-mcp${local.env_suffix}"
  duration   = "8760h" # 1 year
}

# CF Access app for /mcp endpoint - allows service tokens
resource "cloudflare_zero_trust_access_application" "mcp_endpoint" {
  account_id = var.account_id
  name       = "Pantainos Memory MCP Endpoint${local.is_prod ? "" : " (${title(var.environment)})"}"
  type       = "self_hosted"

  domain = "${local.mcp_url}/mcp"

  allowed_idps              = [local.google_id]
  auto_redirect_to_identity = false
  session_duration          = "24h"
  app_launcher_visible      = false

  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"

  # Service token policy first, then bypass for OAuth Bearer tokens
  policies = [
    {
      name       = "Allow service token"
      decision   = "non_identity"
      precedence = 1
      include = [{
        service_token = {
          token_id = cloudflare_zero_trust_access_service_token.mcp.id
        }
      }]
    },
    {
      name       = "Bypass for OAuth"
      decision   = "bypass"
      precedence = 2
      include = [{
        everyone = {}
      }]
    }
  ]
}
