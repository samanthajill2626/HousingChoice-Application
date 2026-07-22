output "bucket_name" {
  description = "Media bucket name."
  value       = aws_s3_bucket.media.bucket
}

output "bucket_arn" {
  description = "Media bucket ARN."
  value       = aws_s3_bucket.media.arn
}

output "bucket_regional_domain_name" {
  description = "Regional S3 domain (<bucket>.s3.<region>.amazonaws.com) - the CloudFront media-origin domain."
  value       = aws_s3_bucket.media.bucket_regional_domain_name
}
