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
