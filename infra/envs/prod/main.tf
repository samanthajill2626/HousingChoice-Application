# hc-prod stack root. ONLY this file differs from infra/envs/dev/main.tf
# (backend bucket + the locals below); the module composition in stack.tf and
# outputs.tf are byte-identical between envs. Never run terraform here by
# hand — use `npm run plan|apply|drift -- prod` (account-guarded).

terraform {
  required_version = ">= 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    bucket       = "hc-prod-tfstate-938565869261" # created by npm run bootstrap
    key          = "terraform.tfstate"
    region       = "us-east-1"
    profile      = "housingchoice"
    use_lockfile = true # S3-native lockfile locking (no DynamoDB lock table)
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "housingchoice" # NEVER the default chain (unrelated account)

  default_tags {
    tags = {
      Project   = "housingchoice"
      Stack     = "hc-prod"
      ManagedBy = "terraform"
    }
  }
}

locals {
  env         = "prod"
  name_prefix = "hc-${local.env}-"

  # Per-env knobs — everything else is identical between stacks.
  log_retention_days = 90
  monthly_budget_usd = 40
  alert_email        = "cameron@abt-industries.com"
}
