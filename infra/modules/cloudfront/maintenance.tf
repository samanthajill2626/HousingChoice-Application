terraform {
  required_version = ">= 1.15"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_caller_identity" "maintenance" {}

locals {
  maintenance_origin_id = "${var.name_prefix}maintenance-origin"
  maintenance_path      = "/${aws_s3_object.maintenance.key}"
  maintenance_copy      = jsondecode(file("${path.module}/../../../app/src/messages/edgeMaintenance.json"))
  maintenance_html      = templatefile("${path.module}/templates/maintenance.html.tftpl", { copy = local.maintenance_copy })
  maintenance_copy_valid = try(
    toset(keys(local.maintenance_copy)) == toset(["action", "body", "brand", "heading", "title"]) &&
    alltrue([for value in local.maintenance_copy :
      value == tostring(value) && trimspace(value) != "" && length(regexall("[^ -~]", value)) == 0
    ]),
    false
  )
}

resource "aws_s3_bucket" "maintenance" {
  bucket        = "${var.name_prefix}maintenance-${data.aws_caller_identity.maintenance.account_id}"
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "maintenance" {
  bucket                  = aws_s3_bucket.maintenance.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_object" "maintenance" {
  bucket        = aws_s3_bucket.maintenance.id
  key           = "maintenance/index.html"
  content       = local.maintenance_html
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-store, max-age=0"
  source_hash   = sha256(local.maintenance_html)

  depends_on = [
    aws_s3_bucket_ownership_controls.maintenance,
    aws_s3_bucket_public_access_block.maintenance,
    aws_s3_bucket_server_side_encryption_configuration.maintenance,
  ]

  lifecycle {
    precondition {
      condition     = local.maintenance_copy_valid
      error_message = "Maintenance copy must have exactly action, body, brand, heading and title as non-empty printable ASCII strings."
    }
  }
}

resource "aws_cloudfront_origin_access_control" "maintenance" {
  name                              = "${var.name_prefix}maintenance-oac"
  description                       = "Read the independent maintenance page"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "maintenance" {
  bucket = aws_s3_bucket.maintenance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadMaintenancePage"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = ["s3:GetObject"]
      Resource  = ["${aws_s3_bucket.maintenance.arn}/${aws_s3_object.maintenance.key}"]
      Condition = {
        StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.this.arn }
      }
    }]
  })
}
