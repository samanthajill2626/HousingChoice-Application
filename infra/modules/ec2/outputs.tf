output "instance_id" {
  description = "App instance id."
  value       = aws_instance.app.id
}

output "eip_public_dns" {
  description = "Stable public DNS of the EIP — CloudFront's origin domain."
  value       = aws_eip.app.public_dns
}

output "eip_public_ip" {
  description = "Stable public IP of the EIP."
  value       = aws_eip.app.public_ip
}

output "instance_role_name" {
  description = "Instance IAM role name (hc-<env>-instance)."
  value       = aws_iam_role.instance.name
}
