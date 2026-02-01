# =============================================================================
# Backend Configuration (Partial)
# =============================================================================
# State stored in shared R2 bucket from terraform-bootstrap.
#
# Usage:
#   tofu init -backend-config=dev.s3.tfbackend
#   tofu init -backend-config=production.s3.tfbackend
#
# When switching environments:
#   tofu init -backend-config=production.s3.tfbackend -reconfigure

terraform {
  backend "s3" {
    # bucket, key, and endpoints come from -backend-config file
    region = "auto"

    # R2 compatibility settings
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true

    # S3 native locking (OpenTofu 1.10+)
    # Creates .tflock file in R2 - no DynamoDB required
    use_lockfile = true
  }
}
