variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "monthly_limit_usd" {
  description = "Monthly budget limit in USD (~25 expected at idle)."
  type        = number
  default     = 40
}

variable "alert_email" {
  description = "Email address that receives budget notifications."
  type        = string
}
