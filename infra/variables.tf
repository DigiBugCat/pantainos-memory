# Pantainos Memory - Terraform Variables

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod"
  }
}

variable "allowed_emails" {
  description = "List of email addresses allowed to access the API"
  type        = list(string)
  default     = []
}

variable "cf_access_team" {
  description = "Cloudflare Zero Trust team name (subdomain of .cloudflareaccess.com)"
  type        = string
}

variable "claude_proxy_worker_name" {
  description = "Name of the claude-proxy worker for service binding"
  type        = string
  default     = "claude-proxy"
}

variable "resolver_github_repo" {
  description = "GitHub repo for resolver issue creation (e.g. DigiBugCat/Cassandra-Finance)"
  type        = string
  default     = "DigiBugCat/Cassandra-Finance"
}

variable "resolver_github_token" {
  description = "GitHub PAT for resolver issue creation (requires issues:write scope)"
  type        = string
  sensitive   = true
}
