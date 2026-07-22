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
  # Origins allowed to direct-POST photo uploads (unit-photos R3). Empty until
  # the operator sets local.dashboard_origins - the upload path is CORS-blocked
  # in a deployed env until this CORS rule is applied.
  dashboard_origins = local.dashboard_origins
  # CloudFront OAC read grant (unit-media-cloudfront design 2026-07-21). NOT a
  # cycle: only the bucket POLICY resource depends on the distribution ARN while
  # cloudfront's media origin depends on the bucket domain - Terraform graphs at
  # resource granularity, same pattern as params<->cloudfront below.
  cloudfront_distribution_arn = module.cloudfront.distribution_arn
}

module "ecr" {
  source = "../../modules/ecr"

  name_prefix = local.name_prefix
}

module "ses" {
  source = "../../modules/ses"

  sender_email = local.alert_email
}

module "jobs" {
  source = "../../modules/jobs"

  name_prefix = local.name_prefix
}

# Email channel v1 (SES): the classic-SES DOMAIN family + inbound pipeline on
# local.mail_domain (S3 + SNS -> one SQS queue). SEPARATE from module "ses"
# above (that is the single sandboxed sender ADDRESS). local.mail_domain_phase
# staircases the manual-Namecheap DNS the same way custom_domain_phase does;
# local.manage_mail_rule_set owns the account-singleton receipt rule set (dev).
module "inbound_mail" {
  source = "../../modules/inbound_mail"

  name_prefix       = local.name_prefix
  mail_domain       = local.mail_domain
  mail_domain_phase = local.mail_domain_phase
  manage_rule_set   = local.manage_mail_rule_set
}

module "params" {
  source = "../../modules/params"

  env          = local.env
  table_prefix = local.name_prefix
  # NOT a cycle: only the PUBLIC_BASE_URL param resource depends on the
  # distribution; cloudfront's origin_secret input depends on random_password.
  # Terraform graphs at resource granularity, so this resolves cleanly.
  # Custom-domain phase 2 flips PUBLIC_BASE_URL to the custom hostname (the
  # canonical-origin cutover — pair with the app CNAME + a redeploy). Phases 0-1
  # keep it on the CloudFront host so the old origin stays fully working while
  # the alias/cert are wired and verified (Change Order 3).
  public_base_url = local.custom_domain_phase >= 2 ? "https://${local.custom_domain}" : "https://${module.cloudfront.domain_name}"
  media_bucket    = module.s3_media.bucket_name
  # M1.2 job delivery: the queue the worker long-polls + the Scheduler
  # target/role jobs.enqueue() creates one-off schedules with.
  jobs_queue_url       = module.jobs.queue_url
  scheduler_target_arn = module.jobs.queue_arn
  scheduler_role_arn   = module.jobs.scheduler_role_arn

  # Email channel v1: the sender domain + default From address the outbound
  # adapter composes with, and the inbound bucket/queue the app + worker read.
  email_sender_domain     = local.mail_domain
  email_from_address      = "team@${local.mail_domain}"
  email_configuration_set = module.inbound_mail.config_set_name
  inbound_mail_bucket     = module.inbound_mail.bucket_name
  inbound_mail_queue_url  = module.inbound_mail.queue_url
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
  jobs_queue_arn     = module.jobs.queue_arn
  scheduler_role_arn = module.jobs.scheduler_role_arn

  # Email channel v1: SES send identity + the inbound queue/bucket the worker reads.
  inbound_mail_queue_arn  = module.inbound_mail.queue_arn
  inbound_mail_bucket_arn = module.inbound_mail.bucket_arn
  ses_identity_arn        = module.inbound_mail.identity_arn
}

# ACM cert for the custom domain (Change Order 3). DNS-validated in Namecheap
# (manual, outside Terraform), so the apply is staged via custom_domain_phase —
# see the acm module header for the no-deadlock flow.
module "acm" {
  source = "../../modules/acm"

  domain_name       = local.custom_domain
  enable_validation = local.custom_domain_phase >= 1
}

module "cloudfront" {
  source = "../../modules/cloudfront"

  name_prefix        = local.name_prefix
  origin_domain_name = module.ec2.eip_public_dns
  origin_secret      = module.params.origin_secret
  # Media bucket regional domain -> the /unit-media/* S3 origin via OAC
  # (unit-media-cloudfront design 2026-07-21).
  media_origin_domain_name = module.s3_media.bucket_regional_domain_name

  # Custom domain attaches at phase >= 1: the alias and the validated cert move
  # together (acm.certificate_arn reads through the validation resource, so this
  # implicitly waits for ISSUED). Phase 0 leaves the default *.cloudfront.net cert.
  aliases             = local.custom_domain_phase >= 1 ? [local.custom_domain] : []
  acm_certificate_arn = local.custom_domain_phase >= 1 ? module.acm.certificate_arn : null
}

module "observability" {
  source = "../../modules/observability"

  name_prefix        = local.name_prefix
  env                = local.env
  log_retention_days = local.log_retention_days
  alert_email        = local.alert_email
  instance_id        = module.ec2.instance_id
  jobs_dlq_name      = module.jobs.dlq_name
}

module "budget" {
  source = "../../modules/budget"

  name_prefix       = local.name_prefix
  monthly_limit_usd = local.monthly_budget_usd
  alert_email       = local.alert_email
}
