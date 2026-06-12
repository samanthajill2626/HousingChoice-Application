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
  description = "Public https base URL of the stack (https://<cloudfront domain>)."
  type        = string
}

variable "media_bucket" {
  description = "S3 media bucket name (s3_media module) — inbound MMS media is mirrored here (M1.1)."
  type        = string
}
