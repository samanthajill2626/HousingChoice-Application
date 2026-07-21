# params — Parameter Store layout under /hc/<env>/ (standard tier, free).
# Parameter Store holds ALL config + secrets (lean decision: no Secrets
# Manager). M0.5's deploy hydrates the instance .env by reading everything
# under /hc/<env>/app/ (GetParametersByPath) — add new app config HERE, never
# by hand in the console. Terraform OWNS every value below (no
# ignore_changes): the console stays read-only and drift shows up in
# `npm run drift`.

terraform {
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
}

# Secret CloudFront->EC2 origin header value. special = false keeps it
# strictly alphanumeric — always safe in an HTTP header.
resource "random_password" "cf_origin_secret" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "cf_origin_secret" {
  name        = "/hc/${var.env}/app/CF_ORIGIN_SECRET"
  description = "x-origin-verify header value CloudFront stamps on origin requests; app middleware rejects requests without it (GET /health exempt)."
  type        = "SecureString" # default AWS-managed aws/ssm key (standard tier, free)
  value       = random_password.cf_origin_secret.result
}

# Session-cookie secret (M1.3 auth) — the exact CF_ORIGIN_SECRET pattern:
# Terraform-generated random value, SecureString, hydrated into the instance
# .env by the deploy. The app derives the AES-256-GCM session-cookie key from
# it (app/src/lib/sessionCookie.ts); production refuses to boot without it.
resource "random_password" "session_secret" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "session_secret" {
  name        = "/hc/${var.env}/app/SESSION_SECRET"
  description = "Secret the app derives the sealed session-cookie key from (M1.3 auth). Never logged."
  type        = "SecureString"
  value       = random_password.session_secret.result
}

resource "aws_ssm_parameter" "log_level" {
  name        = "/hc/${var.env}/app/LOG_LEVEL"
  description = "pino log level for app + worker."
  type        = "String"
  value       = var.log_level
}

resource "aws_ssm_parameter" "table_prefix" {
  name        = "/hc/${var.env}/app/TABLE_PREFIX"
  description = "DynamoDB physical-name prefix; tableName() in app/src/lib/config.ts prepends it to base names."
  type        = "String"
  value       = var.table_prefix
}

resource "aws_ssm_parameter" "port" {
  name        = "/hc/${var.env}/app/PORT"
  description = "App listen port inside the container (published 8080:8080)."
  type        = "String"
  value       = tostring(var.app_port)
}

resource "aws_ssm_parameter" "node_env" {
  name        = "/hc/${var.env}/app/NODE_ENV"
  description = "Node environment for both deployed stacks."
  type        = "String"
  value       = "production"
}

resource "aws_ssm_parameter" "public_base_url" {
  name        = "/hc/${var.env}/app/PUBLIC_BASE_URL"
  description = "Canonical public https base URL — the custom domain once cut over (Change Order 3 custom_domain_phase 2), else the CloudFront domain. Every absolute URL derives from it (OAuth callback, Twilio signature reconstruction + webhook self-registration, CSRF origin). Changing the value requires a redeploy to re-hydrate the instance .env."
  type        = "String"
  value       = var.public_base_url
}

resource "aws_ssm_parameter" "media_bucket" {
  name        = "/hc/${var.env}/app/MEDIA_BUCKET"
  description = "S3 media bucket (s3_media module) the app mirrors inbound MMS media into (M1.1)."
  type        = "String"
  value       = var.media_bucket
}

resource "aws_ssm_parameter" "jobs_queue_url" {
  name        = "/hc/${var.env}/app/JOBS_QUEUE_URL"
  description = "SQS jobs queue URL (jobs module) the worker long-polls for job envelopes (M1.2)."
  type        = "String"
  value       = var.jobs_queue_url
}

resource "aws_ssm_parameter" "scheduler_target_arn" {
  name        = "/hc/${var.env}/app/SCHEDULER_TARGET_ARN"
  description = "EventBridge Scheduler target ARN for jobs.enqueue() one-off schedules — the jobs queue ARN (M1.2)."
  type        = "String"
  value       = var.scheduler_target_arn
}

resource "aws_ssm_parameter" "scheduler_role_arn" {
  name        = "/hc/${var.env}/app/SCHEDULER_ROLE_ARN"
  description = "IAM role EventBridge Scheduler assumes to SendMessage to the jobs queue (M1.2)."
  type        = "String"
  value       = var.scheduler_role_arn
}

# Email channel v1 (SES). The sender domain + default From address the outbound
# adapter composes with, and the inbound bucket/queue the app + worker read raw
# inbound MIME from (inbound_mail module).
resource "aws_ssm_parameter" "email_sender_domain" {
  name        = "/hc/${var.env}/app/EMAIL_SENDER_DOMAIN"
  description = "SES sender/receiver domain (inbound_mail module) - the outbound From/Reply-To domain and inbound recipient (email-channel-v1)."
  type        = "String"
  value       = var.email_sender_domain
}

resource "aws_ssm_parameter" "email_from_address" {
  name        = "/hc/${var.env}/app/EMAIL_FROM_ADDRESS"
  description = "Default From address for outbound email (email-channel-v1)."
  type        = "String"
  value       = var.email_from_address
}

resource "aws_ssm_parameter" "email_configuration_set" {
  name        = "/hc/${var.env}/app/EMAIL_CONFIGURATION_SET"
  description = "SES configuration set (inbound_mail module) outbound sends attach so bounce/complaint/delivery events fan out to the mail-events topic (email-channel-v1)."
  type        = "String"
  value       = var.email_configuration_set
}

resource "aws_ssm_parameter" "inbound_mail_bucket" {
  name        = "/hc/${var.env}/app/INBOUND_MAIL_BUCKET"
  description = "S3 bucket the SES receipt rule writes raw inbound MIME to (inbound_mail module); the worker GetObjects it (email-channel-v1)."
  type        = "String"
  value       = var.inbound_mail_bucket
}

resource "aws_ssm_parameter" "inbound_mail_queue_url" {
  name        = "/hc/${var.env}/app/INBOUND_MAIL_QUEUE_URL"
  description = "SQS queue URL the worker's second consumer long-polls for inbound-mail SNS notifications (inbound_mail module, email-channel-v1)."
  type        = "String"
  value       = var.inbound_mail_queue_url
}
