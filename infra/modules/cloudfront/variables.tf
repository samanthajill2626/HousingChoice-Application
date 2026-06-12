variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "origin_domain_name" {
  description = "Origin domain — the EC2 EIP's stable public DNS."
  type        = string
}

variable "origin_http_port" {
  description = "Origin HTTP port (the published app port on the instance)."
  type        = number
  default     = 8080
}

variable "origin_secret" {
  description = "Value of the x-origin-verify custom header (from the params module); app middleware validates it."
  type        = string
  sensitive   = true
}
