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
  description = "Public https entry point (the CloudFront domain) — Twilio webhook signature reconstruction needs the exact public URL (M1.1)."
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
