output "bucket_name" {
  description = "Media bucket name."
  value       = aws_s3_bucket.media.bucket
}

output "bucket_arn" {
  description = "Media bucket ARN."
  value       = aws_s3_bucket.media.arn
}
