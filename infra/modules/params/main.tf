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
