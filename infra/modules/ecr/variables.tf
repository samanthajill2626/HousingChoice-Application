variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "keep_image_count" {
  description = "Number of most-recent images the lifecycle policy retains."
  type        = number
  default     = 10
}
