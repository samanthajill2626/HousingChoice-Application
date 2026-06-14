variable "domain_name" {
  description = "Custom hostname the cert is issued for (e.g. dev.app.housingchoice.org / app.housingchoice.org). Single subdomain — no SANs, no apex/www."
  type        = string
}

variable "enable_validation" {
  description = "false: request the cert only (PENDING_VALIDATION) and emit the validation CNAME. true: block until ACM marks it ISSUED (operator must have entered the CNAME in Namecheap first). Driven by the stack's custom_domain_phase."
  type        = bool
  default     = false
}
