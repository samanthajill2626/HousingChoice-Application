# s3_media — the stack's single private media bucket (MMS images etc.).
# Versioned, SSE-S3 encrypted, all public access blocked. App access is via
# the EC2 instance role only (see the ec2 module's inline policy).

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "media" {
  # hc-<env>-media-<accountId> — account id suffix for global-name uniqueness.
  bucket = "${var.name_prefix}media-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # SSE-S3 (free; no KMS by lean decision)
    }
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# CORS for direct browser-to-S3 photo uploads (unit-photos revision, spec R3).
# The browser POSTs each file straight to the bucket with a presigned POST grant;
# EC2 never touches the bytes. Only the deployed dashboard origin(s) may do so.
#
# - Method POST only: the sole cross-origin call is the direct upload. GET is
#   deliberately ABSENT - image reads are <img src> (presign-per-read, spec D5),
#   not fetch/XHR, so they are not CORS-gated.
# - ExposeHeaders ["ETag"]: lets the uploading JS read the stored object's ETag.
# - Guarded on dashboard_origins: with the default [] no resource is created
#   (an empty AllowedOrigins would be invalid). The public-access-block above is
#   untouched - a presigned POST is an authenticated request, unaffected by it.
resource "aws_s3_bucket_cors_configuration" "media" {
  count = length(var.dashboard_origins) > 0 ? 1 : 0

  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_methods = ["POST"]
    allowed_origins = var.dashboard_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

# CloudFront OAC read access to the PUBLIC unit-photo namespace ONLY
# (unit-media-cloudfront design 2026-07-21). unit-media/* is public-flyer
# content served on stable same-origin URLs; the PII namespaces (media/,
# recordings/, uploads/) are deliberately NOT granted - no CloudFront
# behavior routes to them, and this policy must never widen past
# unit-media/*. A service-principal grant conditioned on one distribution
# ARN is NOT a public policy, so block_public_policy above does not reject
# it. This is the bucket's FIRST policy document (nothing to merge).
data "aws_iam_policy_document" "media_cloudfront_read" {
  count = var.cloudfront_distribution_arn == null ? 0 : 1

  statement {
    sid       = "AllowCloudFrontOACReadUnitMedia"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/unit-media/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [var.cloudfront_distribution_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  count = var.cloudfront_distribution_arn == null ? 0 : 1

  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_cloudfront_read[0].json
}
