variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "env" {
  description = "Stack environment name (dev / prod)."
  type        = string
}

variable "instance_type" {
  description = "EC2 instance type (ARM64 — must match the AL2023 arm64 AMI)."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size (gp3, encrypted). 10GB is ample for AL2023 (~3GB) + one app image, PROVIDED deploys prune old images (deploy path does)."
  type        = number
  default     = 10
}

variable "subnet_id" {
  description = "Public subnet id from the network module."
  type        = string
}

variable "security_group_id" {
  description = "App security group id from the network module."
  type        = string
}

variable "table_arns" {
  description = "Map of base table name -> ARN for the 9 DynamoDB tables (from the dynamodb module)."
  type        = map(string)
}

variable "media_bucket_arn" {
  description = "Media bucket ARN (from the s3_media module)."
  type        = string
}

variable "ecr_repository_arn" {
  description = "App ECR repository ARN (from the ecr module)."
  type        = string
}

variable "jobs_queue_arn" {
  description = "SQS jobs queue ARN (from the jobs module) — worker consume + app send (M1.2)."
  type        = string
}

variable "scheduler_role_arn" {
  description = "Scheduler role ARN (from the jobs module) — the only role the instance may pass to EventBridge Scheduler (M1.2)."
  type        = string
}

variable "inbound_mail_queue_arn" {
  description = "Inbound-mail SQS queue ARN (from the inbound_mail module) - the worker's second consumer Receives/Deletes inbound notifications (email-channel-v1)."
  type        = string
}

variable "inbound_mail_bucket_arn" {
  description = "Inbound-mail S3 bucket ARN (from the inbound_mail module) - the worker GetObjects raw inbound MIME (email-channel-v1)."
  type        = string
}

variable "ses_identity_arn" {
  description = "SES domain identity ARN (from the inbound_mail module) - the ses:SendEmail/SendRawEmail resource scope (email-channel-v1)."
  type        = string
}

variable "compose_version" {
  description = "docker compose v2 release tag installed by user-data (pinned for reproducible boots)."
  type        = string
  default     = "v2.32.4"
}
