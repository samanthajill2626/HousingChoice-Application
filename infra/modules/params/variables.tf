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
