# observability — log groups, metric filters, alarms, SNS alerts, dashboard.
#
# Both processes log structured pino JSON. Two log-derived metrics per the
# binding guidelines: OrphanLogs (a log line WITHOUT a correlationId — every
# error/log must carry one) and ErrorLogs (pino level >= 50 = error+fatal).
# Filters on BOTH groups emit into the SAME hc/<env> metric, so one alarm
# covers app + worker.

data "aws_region" "current" {}

locals {
  log_groups       = ["app", "worker"]
  metric_namespace = "hc/${var.env}"
}

resource "aws_cloudwatch_log_group" "proc" {
  for_each = toset(local.log_groups)

  name              = "/hc/${var.env}/${each.key}"
  retention_in_days = var.log_retention_days
}

# --- Metric filters -------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "orphan_logs" {
  for_each = aws_cloudwatch_log_group.proc

  name           = "${var.name_prefix}${each.key}-orphan-logs"
  log_group_name = each.value.name
  # JSON line MISSING correlationId — binding guideline #4.
  pattern = "{ $.correlationId NOT EXISTS }"

  metric_transformation {
    name          = "OrphanLogs"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "error_logs" {
  for_each = aws_cloudwatch_log_group.proc

  name           = "${var.name_prefix}${each.key}-error-logs"
  log_group_name = each.value.name
  # pino numeric levels: error = 50, fatal = 60.
  pattern = "{ $.level >= 50 }"

  metric_transformation {
    name          = "ErrorLogs"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

# --- Alerting -------------------------------------------------------------

# NOTE (apply-time side effect): the email subscription sends a confirmation
# email to var.alert_email; alarms notify nobody until it is confirmed.
resource "aws_sns_topic" "alerts" {
  name = "${var.name_prefix}alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "orphan_logs" {
  alarm_name          = "${var.name_prefix}orphan-logs"
  alarm_description   = "Any log line without a correlationId (binding guideline #4) — should be exactly zero."
  namespace           = local.metric_namespace
  metric_name         = "OrphanLogs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "error_logs" {
  alarm_name          = "${var.name_prefix}error-logs"
  alarm_description   = "App+worker error/fatal log volume (pino level >= 50) over 5 minutes."
  namespace           = local.metric_namespace
  metric_name         = "ErrorLogs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.error_logs_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "status_check_failed" {
  alarm_name          = "${var.name_prefix}status-check-failed"
  alarm_description   = "EC2 instance or system status check failing."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching" # instance gone / not reporting is itself a failure
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = var.instance_id
  }
}

# Root-volume disk usage. NOTE: data arrives only once the CloudWatch agent
# is installed/configured on the instance (M0.5/M0.6) — until then the metric
# is missing and treat_missing_data keeps the alarm quietly OK. Dimensions
# must match the agent config when it lands (path "/", xfs on AL2023).
resource "aws_cloudwatch_metric_alarm" "disk_used" {
  alarm_name          = "${var.name_prefix}disk-used"
  alarm_description   = "Root volume above ${var.disk_used_alarm_threshold}% (CloudWatch agent metric; agent arrives M0.5/M0.6)."
  namespace           = "CWAgent"
  metric_name         = "disk_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.disk_used_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = var.instance_id
    path       = "/"
    fstype     = "xfs"
  }
}

# Jobs DLQ depth (doc §9 "Job/DLQ depth"): a job envelope lands in the DLQ
# only after maxReceiveCount (5) failed worker dispatches — reminders and
# follow-ups are revenue-critical, so ANY dead-lettered job pages. Recovery:
# RUNBOOK "Jobs" section (inspect, fix the handler, redrive).
resource "aws_cloudwatch_metric_alarm" "jobs_dlq_depth" {
  alarm_name          = "${var.name_prefix}jobs-dlq-depth"
  alarm_description   = "Jobs dead-letter queue is non-empty — a job failed all 5 delivery attempts (doc §9 Job/DLQ depth). See RUNBOOK 'Jobs'."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching" # SQS stops emitting on idle queues; empty = OK
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    QueueName = var.jobs_dlq_name
  }
}

# --- Dashboard --------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "stack" {
  dashboard_name = "${var.name_prefix}dashboard"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title  = "Log health (app + worker)"
          region = data.aws_region.current.region
          stat   = "Sum"
          period = 300
          metrics = [
            [local.metric_namespace, "OrphanLogs"],
            [local.metric_namespace, "ErrorLogs"],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title  = "CPU"
          region = data.aws_region.current.region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/EC2", "CPUUtilization", "InstanceId", var.instance_id],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "Status checks"
          region = data.aws_region.current.region
          stat   = "Maximum"
          period = 300
          metrics = [
            ["AWS/EC2", "StatusCheckFailed", "InstanceId", var.instance_id],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "Disk used % (root) — populates once CW agent ships (M0.5/M0.6)"
          region = data.aws_region.current.region
          stat   = "Maximum"
          period = 300
          metrics = [
            ["CWAgent", "disk_used_percent", "InstanceId", var.instance_id, "path", "/", "fstype", "xfs"],
          ]
        }
      },
    ]
  })
}
