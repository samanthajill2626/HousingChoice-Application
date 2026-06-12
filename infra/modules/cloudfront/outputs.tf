output "domain_name" {
  description = "Distribution domain name (https entry point)."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_id" {
  description = "Distribution id."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "Distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}
