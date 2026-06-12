output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "public_subnet_id" {
  description = "The single public subnet id."
  value       = aws_subnet.public.id
}

output "app_security_group_id" {
  description = "Security group id for the app instance."
  value       = aws_security_group.app.id
}
