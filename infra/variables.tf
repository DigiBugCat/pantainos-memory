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
  description = "OpenAI-compatible chat completions endpoint for LLM judge"
  type        = string
  default     = "https://api.openai.com/v1/chat/completions"
}

variable "llm_judge_model" {
  description = "Model name for LLM judge calls"
  type        = string
  default     = "gpt-5-mini"
}

variable "llm_judge_api_key" {
  description = "API key for LLM judge endpoint"
  type        = string
  sensitive   = true
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

variable "pushover_user_key" {
  description = "Pushover user key for push notifications on core violations"
  type        = string
  sensitive   = true
}

variable "pushover_app_token" {
  description = "Pushover application token for push notifications"
  type        = string
  sensitive   = true
}
