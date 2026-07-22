variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

# Dashboard origin(s) allowed to direct-POST uploads to the media bucket
# (unit-photos direct browser-to-S3 upload, spec R3). Set by the consuming env
# to the real deployed dashboard origin(s), e.g. ["https://app.example.org"].
# Empty (the default) creates NO cors_configuration resource - an env that
# hasn't set an origin gets no rule (an empty AllowedOrigins is invalid anyway).
variable "dashboard_origins" {
  description = "Dashboard origins allowed to POST direct uploads (S3 CORS). Empty disables the CORS rule."
  type        = list(string)
  default     = []
}

variable "cloudfront_distribution_arn" {
  description = "ARN of the CloudFront distribution allowed to read unit-media/* via OAC (unit-media-cloudfront design 2026-07-21). null = no bucket policy created."
  type        = string
  default     = null
}
