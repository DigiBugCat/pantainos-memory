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

variable "llm_judge_url" {
  description = "External LLM endpoint URL for judge calls (OpenAI-compatible, e.g., claude-proxy)"
  type        = string
  default     = "https://claude-proxy.pantainos.workers.dev/v1/chat/completions"
}

variable "llm_judge_cf_client_id" {
  description = "CF Access service token client ID for authenticating to external LLM endpoint"
  type        = string
  sensitive   = true
  default     = ""
}

variable "llm_judge_cf_client_secret" {
  description = "CF Access service token client secret for authenticating to external LLM endpoint"
  type        = string
  sensitive   = true
  default     = ""
}
