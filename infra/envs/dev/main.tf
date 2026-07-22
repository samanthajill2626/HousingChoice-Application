# hc-dev stack root. ONLY this file differs from infra/envs/prod/main.tf
# (backend bucket + the locals below); the module composition in stack.tf and
# outputs.tf are byte-identical between envs. Never run terraform here by
# hand — use `npm run plan|apply|drift -- dev` (account-guarded).

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
    bucket       = "hc-dev-tfstate-938565869261" # created by npm run bootstrap
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
      Stack     = "hc-dev"
      ManagedBy = "terraform"
    }
  }
}

locals {
  env         = "dev"
  name_prefix = "hc-${local.env}-"

  # Per-env knobs — everything else is identical between stacks.
  log_retention_days = 30
  monthly_budget_usd = 40
  alert_email        = "cameron@abt-industries.com"

  # Custom domain + TLS (Change Order 3). DNS lives in Namecheap (manual); the
  # ACM cert + CloudFront alias are Terraform. custom_domain_phase staircases the
  # cutover so no apply deadlocks and there is no TLS/outage window:
  #   0  request the ACM cert only -> apply emits the acm_validation_records
  #      output; enter that CNAME in Namecheap and wait for ISSUED.
  #   1  attach the validated cert + alias to the distribution (SNI, TLS 1.2),
  #      then cut the app CNAME in Namecheap and verify the new host serves.
  #   2  flip PUBLIC_BASE_URL to the custom domain (canonical-origin cutover) and
  #      redeploy so the app re-hydrates it; re-point OAuth + Twilio in the same step.
  custom_domain       = "dev.app.housingchoice.org"
  custom_domain_phase = 2

  # Origins allowed to direct-POST photo uploads to the media bucket (unit-photos
  # R3). The dashboard is served from the canonical app origin, so this is the
  # custom domain once cut over (phase 2). Add any additional deployed origins
  # here. Applying this (via the s3_media CORS rule) is what unblocks the upload
  # path in the deployed env - see RUNBOOK "Unit photos: direct-upload CORS".
  # + localhost:5174 (unit-media-cloudfront design 2026-07-21, D4): live-mode
  # local dev uploads direct to the real dev bucket from the local dashboard.
  dashboard_origins = ["https://${local.custom_domain}", "http://localhost:5174"]

  # Email channel v1 (SES, inbound_mail module). mail_domain = the SES
  # sender/receiver domain (dev uses the mail.dev.<zone> subdomain); DNS is
  # manual in Namecheap, so mail_domain_phase staircases the cutover exactly like
  # custom_domain_phase: 0 = create the identity/DKIM/plumbing + emit the DNS
  # records; flip to 1 after the records are entered + the domain verifies to
  # turn on the inbound receipt rule. manage_mail_rule_set = true: DEV owns the
  # ACCOUNT-SINGLETON receipt rule set + its activation (prod is false; exactly
  # one env may be true - see the inbound_mail module header + RUNBOOK).
  mail_domain          = "mail.dev.housingchoice.org"
  mail_domain_phase    = 1
  manage_mail_rule_set = true
}
