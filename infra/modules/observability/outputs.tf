output "sns_topic_arn" {
  description = "Alerts SNS topic ARN."
  value       = aws_sns_topic.alerts.arn
}

output "log_group_names" {
  description = "Map of process name -> log group name."
  value       = { for k, lg in aws_cloudwatch_log_group.proc : k => lg.name }
}

output "dashboard_name" {
  description = "CloudWatch dashboard name."
  value       = aws_cloudwatch_dashboard.stack.dashboard_name
}
