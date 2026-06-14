# Stack outputs — identical between envs.

output "cloudfront_domain_name" {
  description = "Public https entry point."
  value       = module.cloudfront.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id."
  value       = module.cloudfront.distribution_id
}

output "instance_id" {
  description = "App EC2 instance id (SSM target for deploys/sessions)."
  value       = module.ec2.instance_id
}

output "eip_public_dns" {
  description = "Stable origin DNS (the EIP's public DNS)."
  value       = module.ec2.eip_public_dns
}

output "ecr_repository_url" {
  description = "Push/pull target for the app image."
  value       = module.ecr.repository_url
}

output "media_bucket_name" {
  description = "Media bucket name."
  value       = module.s3_media.bucket_name
}

output "table_names" {
  description = "Base name -> physical DynamoDB table name."
  value       = module.dynamodb.table_names
}

output "param_path_prefix" {
  description = "Parameter Store path M0.5's deploy hydrates .env from."
  value       = module.params.param_path_prefix
}

output "jobs_queue_url" {
  description = "SQS jobs queue URL (worker long-polls; JOBS_QUEUE_URL param)."
  value       = module.jobs.queue_url
}

output "jobs_dlq_url" {
  description = "Jobs dead-letter queue URL (inspect/redrive — RUNBOOK 'Jobs')."
  value       = module.jobs.dlq_url
}

output "alerts_topic_arn" {
  description = "SNS alerts topic (email subscription needs one-time confirmation)."
  value       = module.observability.sns_topic_arn
}

output "ses_verification_note" {
  description = "SES apply-time side effect reminder."
  value       = module.ses.verification_note
}

# --- Custom domain + TLS (Change Order 3) ---

output "custom_domain" {
  description = "Custom hostname fronting this stack's CloudFront distribution."
  value       = local.custom_domain
}

output "acm_certificate_arn" {
  description = "ACM certificate ARN for the custom domain (us-east-1)."
  value       = module.acm.certificate_arn
}

output "acm_validation_records" {
  description = "DNS validation CNAME(s) to add in Namecheap and LEAVE in place (strip the trailing .<zone>. from each name — see RUNBOOK 'Custom domain & TLS')."
  value       = module.acm.validation_records
}

output "app_cname_target" {
  description = "Value for the app CNAME in Namecheap (host=<sub> CNAME -> this). Cut ONLY after the cert is issued and attached as an alias (custom_domain_phase 1)."
  value       = module.cloudfront.domain_name
}
