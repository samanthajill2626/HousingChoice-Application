variable "name_prefix" {
  description = "Stack resource name prefix (hc-dev- / hc-prod-)."
  type        = string
}

variable "vpc_cidr" {
  description = "VPC CIDR block."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "Public subnet CIDR block (one subnet, one AZ — lean by decision)."
  type        = string
  default     = "10.0.0.0/24"
}

variable "availability_zone" {
  description = "AZ for the single public subnet."
  type        = string
  default     = "us-east-1a"
}

variable "app_port" {
  description = "Container/app port published on the instance."
  type        = number
  default     = 8080
}
