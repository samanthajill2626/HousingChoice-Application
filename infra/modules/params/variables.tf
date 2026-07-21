variable "env" {
  description = "Stack environment name (dev / prod) — params live under /hc/<env>/."
  type        = string
}

variable "table_prefix" {
  description = "DynamoDB table name prefix the app should use (hc-dev- / hc-prod-)."
  type        = string
}

variable "log_level" {
  description = "pino log level."
  type        = string
  default     = "info"
}

variable "app_port" {
  description = "App listen port."
  type        = number
  default     = 8080
}

variable "public_base_url" {
  description = "Canonical public https base URL — the custom domain post-cutover (Change Order 3) or the CloudFront domain. No trailing slash."
  type        = string
}

variable "media_bucket" {
  description = "S3 media bucket name (s3_media module) — inbound MMS media is mirrored here (M1.1)."
  type        = string
}

variable "jobs_queue_url" {
  description = "SQS jobs queue URL (jobs module) — the worker's long-poll source (M1.2)."
  type        = string
}

variable "scheduler_target_arn" {
  description = "EventBridge Scheduler target ARN — the jobs queue ARN (M1.2)."
  type        = string
}

variable "scheduler_role_arn" {
  description = "IAM role ARN EventBridge Scheduler assumes to deliver to the jobs queue (M1.2)."
  type        = string
}

variable "email_sender_domain" {
  description = "SES sender/receiver domain (inbound_mail module) - EMAIL_SENDER_DOMAIN (email-channel-v1)."
  type        = string
}

variable "email_from_address" {
  description = "Default From address for outbound email - EMAIL_FROM_ADDRESS (email-channel-v1)."
  type        = string
}

variable "inbound_mail_bucket" {
  description = "Inbound-mail S3 bucket name (inbound_mail module) - INBOUND_MAIL_BUCKET (email-channel-v1)."
  type        = string
}

variable "inbound_mail_queue_url" {
  description = "Inbound-mail SQS queue URL (inbound_mail module) - INBOUND_MAIL_QUEUE_URL the worker long-polls (email-channel-v1)."
  type        = string
}
