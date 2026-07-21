variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "mail_domain" {
  description = "The email domain this stack sends from and receives at (e.g. mail.dev.housingchoice.org / mail.housingchoice.org) - the SES domain identity, DKIM subject, and receipt-rule recipient."
  type        = string
}

variable "mail_domain_phase" {
  description = "DNS-staircase phase (the acm custom_domain_phase analog). 0: create the identity + DKIM + all DNS-independent plumbing (SNS/SQS/S3/config set) and EMIT the DKIM/verification/MX/SPF record outputs for manual Namecheap entry. >=1: create the inbound receipt rule (+ the shared rule-set activation on the managing env). Flip to 1 only AFTER the DNS records are entered and the domain verifies."
  type        = number
  default     = 0
}

variable "manage_rule_set" {
  description = "Whether THIS env owns the account-level SES receipt rule set (var.rule_set_name) and its activation. SES allows exactly one active receipt rule set per account+region and dev+prod share the account, so exactly ONE env sets this true (dev). Every env still creates its OWN receipt rule referencing the shared set by name."
  type        = bool
  default     = false
}

variable "rule_set_name" {
  description = "The FIXED, shared SES receipt-rule-set name both envs' rules live in (account singleton). Never per-env - a per-env set would let whichever env activated last silently drop the other env's inbound mail."
  type        = string
  default     = "hc-inbound-mail"
}
