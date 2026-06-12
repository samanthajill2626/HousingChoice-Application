output "queue_url" {
  description = "Jobs queue URL — hydrates into the containers as JOBS_QUEUE_URL (the worker long-polls it)."
  value       = aws_sqs_queue.jobs.url
}

output "queue_arn" {
  description = "Jobs queue ARN — the EventBridge Scheduler target (SCHEDULER_TARGET_ARN)."
  value       = aws_sqs_queue.jobs.arn
}

output "dlq_url" {
  description = "Dead-letter queue URL (inspect/redrive — see RUNBOOK Jobs section)."
  value       = aws_sqs_queue.jobs_dlq.url
}

output "dlq_name" {
  description = "Dead-letter queue name — the observability module's DLQ-depth alarm dimension."
  value       = aws_sqs_queue.jobs_dlq.name
}

output "scheduler_role_arn" {
  description = "Role EventBridge Scheduler assumes to SendMessage to the jobs queue (SCHEDULER_ROLE_ARN)."
  value       = aws_iam_role.scheduler.arn
}
