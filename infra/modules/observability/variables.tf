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

variable "mem_used_warn_threshold" {
  description = "mem_used_percent (CloudWatch agent) that trips the WARNING memory alarm (sustained 15 min). 2 GB t4g.small runs the app+worker Node containers."
  type        = number
  default     = 80
}

variable "mem_used_critical_threshold" {
  description = "mem_used_percent (CloudWatch agent) that trips the CRITICAL memory alarm (5 min) — near-OOM acute spike."
  type        = number
  default     = 90
}

# --- Messaging delivery alarms (doc §9 "Webhook failures" / "Send failures") ---
# Defaults carry the operating thresholds so the env stack does NOT pass them.

variable "webhook_signature_rejections_threshold" {
  description = "WebhookSignatureRejections (event=webhook_signature_rejected) Sum per 5 min that trips the alarm. Low bar: behind CloudFront+origin-secret a sustained signature failure means an auth-token misconfig after rotation = every inbound silently lost (doc §9 'Webhook failures')."
  type        = number
  default     = 3
}

variable "send_throttled_threshold" {
  description = "SendThrottled (event=send_throttled; Twilio 429/30022) Sum per 5 min that trips the alarm. With the conservative ~1/s token bucket these should be ~0, so any sustained throttling = bucket/tier problem (doc §9 'Send failures')."
  type        = number
  default     = 3
}

variable "delivery_failures_threshold" {
  description = "DeliveryFailures (event=delivery_failed; undelivered/failed deliveries) Sum per 5 min that trips the alarm. Count-based with a higher bar — undelivered to bad numbers is normal at low volume (doc §9 'Send failures / delivery errors')."
  type        = number
  default     = 15
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
