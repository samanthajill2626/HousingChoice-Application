# Stack composition — BYTE-IDENTICAL between infra/envs/dev and
# infra/envs/prod; all per-env differences live in main.tf locals.

# The 9 DynamoDB table definitions — GENERATED. Terraform auto-loads the value
# from tables.auto.tfvars.json (written by `npm run gen:tables` from
# app/src/lib/tables.ts, the contractual source of truth). Never hand-edit the
# JSON; `npm run plan`/`drift` fail when it is stale. Shape is validated by the
# dynamodb module's `tables` variable (infra/modules/dynamodb/variables.tf).
variable "tables" {
  description = "Generated DynamoDB table definitions (tables.auto.tfvars.json — npm run gen:tables)."
  type        = any
}

module "network" {
  source = "../../modules/network"

  name_prefix = local.name_prefix
}

module "dynamodb" {
  source = "../../modules/dynamodb"

  name_prefix = local.name_prefix
  tables      = var.tables
}

module "s3_media" {
  source = "../../modules/s3_media"

  name_prefix = local.name_prefix
}

module "ecr" {
  source = "../../modules/ecr"

  name_prefix = local.name_prefix
}

module "ses" {
  source = "../../modules/ses"

  sender_email = local.alert_email
}

module "params" {
  source = "../../modules/params"

  env          = local.env
  table_prefix = local.name_prefix
}

module "ec2" {
  source = "../../modules/ec2"

  name_prefix        = local.name_prefix
  env                = local.env
  subnet_id          = module.network.public_subnet_id
  security_group_id  = module.network.app_security_group_id
  table_arns         = module.dynamodb.table_arns
  media_bucket_arn   = module.s3_media.bucket_arn
  ecr_repository_arn = module.ecr.repository_arn
}

module "cloudfront" {
  source = "../../modules/cloudfront"

  name_prefix        = local.name_prefix
  origin_domain_name = module.ec2.eip_public_dns
  origin_secret      = module.params.origin_secret
}

module "observability" {
  source = "../../modules/observability"

  name_prefix        = local.name_prefix
  env                = local.env
  log_retention_days = local.log_retention_days
  alert_email        = local.alert_email
  instance_id        = module.ec2.instance_id
}

module "budget" {
  source = "../../modules/budget"

  name_prefix       = local.name_prefix
  monthly_limit_usd = local.monthly_budget_usd
  alert_email       = local.alert_email
}
