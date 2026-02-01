# Pantainos Memory - Terraform Variables

variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "allowed_emails" {
  description = "List of email addresses allowed to access the MCP server"
  type        = list(string)
}

variable "create_prod" {
  description = "Whether to create production Access application"
  type        = bool
  default     = false
}
