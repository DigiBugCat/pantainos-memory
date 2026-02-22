# Pantainos Memory - Full Infrastructure via Terraform
#
# Manages everything:
# - D1 database
# - Queue + consumer
# - API worker (CF Access enforced)
# - CF Access applications + service token
#
# MCP access is via external FastMCP proxy on fastmcp.cloud.
#
# Prerequisites:
#   pnpm build  (creates dist/index.js)
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
  d1_name         = local.is_prod ? "pantainos-memory" : "pantainos-memory-${var.environment}"
  queue_name      = "${local.api_worker_name}-detection"
  dlq_queue_name  = "${local.api_worker_name}-detection-dlq"

  # Vectorize index names
  vectorize_vectors     = "${local.api_worker_name}-vectors"
  vectorize_invalidates = "${local.api_worker_name}-invalidates"
  vectorize_confirms    = "${local.api_worker_name}-confirms"

  # Worker URLs
  api_url = "${local.api_worker_name}.pantainos.workers.dev"

  # Common bindings for workers
  common_bindings = [
    { type = "d1", name = "DB", id = cloudflare_d1_database.memory.id },
    { type = "ai", name = "AI" },
    { type = "vectorize", name = "MEMORY_VECTORS", index_name = local.vectorize_vectors },
    { type = "vectorize", name = "INVALIDATES_VECTORS", index_name = local.vectorize_invalidates },
    { type = "vectorize", name = "CONFIRMS_VECTORS", index_name = local.vectorize_confirms },
    { type = "plain_text", name = "REASONING_MODEL", text = "@cf/openai/gpt-oss-120b" },
    { type = "plain_text", name = "DEDUP_MODEL", text = "@cf/openai/gpt-oss-20b" },
    { type = "plain_text", name = "DEDUP_THRESHOLD", text = "0.85" },
    { type = "plain_text", name = "RESOLVER_TYPE", text = "github" },
    { type = "plain_text", name = "RESOLVER_GITHUB_REPO", text = var.resolver_github_repo },
    { type = "secret_text", name = "RESOLVER_GITHUB_TOKEN", text = var.resolver_github_token },
    { type = "plain_text", name = "CF_ACCESS_TEAM", text = var.cf_access_team },
    { type = "plain_text", name = "CLASSIFICATION_CHALLENGE_ENABLED", text = "true" },
    { type = "plain_text", name = "LLM_JUDGE_URL", text = var.llm_judge_url },
    { type = "plain_text", name = "LLM_JUDGE_MODEL", text = var.llm_judge_model },
    { type = "secret_text", name = "LLM_JUDGE_API_KEY", text = var.llm_judge_api_key },
    { type = "secret_text", name = "PUSHOVER_USER_KEY", text = var.pushover_user_key },
    { type = "secret_text", name = "PUSHOVER_APP_TOKEN", text = var.pushover_app_token },
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

resource "terraform_data" "dlq_queue" {
  input = {
    queue_name = local.dlq_queue_name
  }

  provisioner "local-exec" {
    command = "wrangler queues create ${local.dlq_queue_name} 2>/dev/null || true"
  }

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
    { type = "queue", name = "DETECTION_DLQ", queue_name = local.dlq_queue_name },
    { type = "analytics_engine", name = "ANALYTICS", dataset = "pantainos_memory_api_${var.environment}" },
    { type = "plain_text", name = "CF_ACCESS_AUD", text = cloudflare_zero_trust_access_application.api.aud },
  ])

  compatibility_date  = "2024-12-01"
  compatibility_flags = ["nodejs_compat"]

  depends_on = [
    terraform_data.queue,
    terraform_data.dlq_queue,
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

# DLQ consumer — same worker handles dead letter messages with logging
resource "terraform_data" "dlq_queue_consumer" {
  triggers_replace = [
    cloudflare_worker.api.name,
    local.dlq_queue_name,
  ]

  input = {
    queue_name  = local.dlq_queue_name
    worker_name = cloudflare_worker.api.name
  }

  provisioner "local-exec" {
    command = "wrangler queues consumer add ${local.dlq_queue_name} ${cloudflare_worker.api.name} 2>/dev/null || true"
  }

  provisioner "local-exec" {
    when    = destroy
    command = "wrangler queues consumer remove ${self.input.queue_name} ${self.input.worker_name} 2>/dev/null || true"
  }

  depends_on = [cloudflare_workers_deployment.api, terraform_data.dlq_queue]
}

# =============================================================================
# Cron Triggers (scheduled event handlers on API worker)
# =============================================================================

resource "cloudflare_workers_cron_trigger" "api" {
  account_id  = var.account_id
  script_name = cloudflare_worker.api.name

  schedules = [
    { cron = "* * * * *" },     # Every minute: dispatch inactive session events
    { cron = "0 3 * * *" },     # Daily 3AM UTC: compute stats + queue overdue predictions
  ]

  depends_on = [cloudflare_workers_deployment.api]
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
      name       = "Allow authorized users"
      decision   = "allow"
      precedence = 2
      include = [{
        group = {
          id = cloudflare_zero_trust_access_group.memory_users.id
        }
      }]
    },
  ]

  # No depends_on - Access app can be created before worker exists
  # This allows worker to reference the AUD in its bindings
}

# =============================================================================
# CF Access - Service Token (used by FastMCP proxy on fastmcp.cloud)
# =============================================================================

resource "cloudflare_zero_trust_access_service_token" "mcp" {
  account_id = var.account_id
  name       = "pantainos-memory-mcp${local.env_suffix}"
  duration   = "8760h" # 1 year
}
