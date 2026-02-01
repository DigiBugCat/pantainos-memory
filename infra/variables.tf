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
