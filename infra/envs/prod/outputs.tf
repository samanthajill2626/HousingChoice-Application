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

output "alerts_topic_arn" {
  description = "SNS alerts topic (email subscription needs one-time confirmation)."
  value       = module.observability.sns_topic_arn
}

output "ses_verification_note" {
  description = "SES apply-time side effect reminder."
  value       = module.ses.verification_note
}
