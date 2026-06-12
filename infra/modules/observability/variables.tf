variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "env" {
  description = "Stack environment name (dev / prod)."
  type        = string
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention (30 dev / 90 prod)."
  type        = number
}

variable "error_logs_alarm_threshold" {
  description = "ErrorLogs (level >= 50) per 5 minutes that trips the alarm."
  type        = number
  default     = 5
}

variable "disk_used_alarm_threshold" {
  description = "Root-volume disk_used_percent that trips the alarm."
  type        = number
  default     = 80
}

variable "alert_email" {
  description = "Email address subscribed to the alerts SNS topic (confirmation email sent on apply)."
  type        = string
}

variable "instance_id" {
  description = "App EC2 instance id (StatusCheckFailed / CPU / disk widgets and alarms)."
  type        = string
}

variable "jobs_dlq_name" {
  description = "Jobs dead-letter queue name (jobs module) — the DLQ-depth alarm dimension (M1.2)."
  type        = string
}
