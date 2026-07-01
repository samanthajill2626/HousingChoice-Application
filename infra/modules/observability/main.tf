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

# Host/system log (rsyslog /var/log/messages, shipped by the CloudWatch agent):
# kernel OOM-killer lines etc. STANDALONE — deliberately NOT in local.log_groups,
# so the pino OrphanLogs/ErrorLogs metric filters do NOT run on it (non-JSON
# kernel lines would otherwise trip OrphanLogs). System Status reads it for OOM.
resource "aws_cloudwatch_log_group" "system" {
  name              = "/hc/${var.env}/system"
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

# Messaging delivery markers (doc §9 "Webhook failures" / "Send failures"). The
# app emits stable `event` fields (twilioSignature.ts, routes/webhooks/twilio.ts,
# adapters/messaging.ts) so these filters key on a field, not fragile free text.
# Filters on BOTH groups emit into the SAME hc/<env> metric, so one alarm each
# covers app + worker (the worker runs the fan-out sends; the app runs the
# webhooks — the throttle marker can come from either).

resource "aws_cloudwatch_log_metric_filter" "webhook_signature_rejections" {
  for_each = aws_cloudwatch_log_group.proc

  name           = "${var.name_prefix}${each.key}-webhook-signature-rejections"
  log_group_name = each.value.name
  # Inbound webhook whose X-Twilio-Signature failed validation (403 + WARN).
  pattern = "{ $.event = \"webhook_signature_rejected\" }"

  metric_transformation {
    name          = "WebhookSignatureRejections"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "delivery_failures" {
  for_each = aws_cloudwatch_log_group.proc

  name           = "${var.name_prefix}${each.key}-delivery-failures"
  log_group_name = each.value.name
  # A delivery-status callback that resolved to undelivered/failed.
  pattern = "{ $.event = \"delivery_failed\" }"

  metric_transformation {
    name          = "DeliveryFailures"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "send_throttled" {
  for_each = aws_cloudwatch_log_group.proc

  name           = "${var.name_prefix}${each.key}-send-throttled"
  log_group_name = each.value.name
  # A send hit a Twilio 429 / 30022 transient throttle at the adapter boundary.
  pattern = "{ $.event = \"send_throttled\" }"

  metric_transformation {
    name          = "SendThrottled"
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

# Messaging delivery alarms (doc §9). Each → the same alerts SNS topic, with
# both ok + alarm actions, period 300, treat_missing_data notBreaching (these
# metrics stop emitting when nothing is wrong — missing = OK, not breaching).

resource "aws_cloudwatch_metric_alarm" "webhook_signature_rejections" {
  alarm_name          = "${var.name_prefix}webhook-signature-rejections"
  alarm_description   = "doc §9 'Webhook failures': inbound Twilio webhooks failing signature validation (event=webhook_signature_rejected). Inbound texts are the product's heartbeat — behind CloudFront+origin-secret a sustained rejection means an auth-token misconfig (e.g. after rotation) and every inbound conversation is silently lost. Low threshold on purpose."
  namespace           = local.metric_namespace
  metric_name         = "WebhookSignatureRejections"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.webhook_signature_rejections_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "send_throttled" {
  alarm_name          = "${var.name_prefix}send-throttled"
  alarm_description   = "doc §9 'Send failures': outbound sends hitting Twilio throttling (429/30022, event=send_throttled). With the conservative ~1/s token bucket these should be ~0 — any sustained throttling means a token-bucket/A2P-tier problem (TPS budget breach) throttling the core loop. Low threshold on purpose."
  namespace           = local.metric_namespace
  metric_name         = "SendThrottled"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.send_throttled_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "delivery_failures" {
  alarm_name        = "${var.name_prefix}delivery-failures"
  alarm_description = "doc §9 'Send failures / delivery errors': undelivered/failed delivery-status callbacks (event=delivery_failed). Carrier filtering, A2P issues, or bad numbers. Higher threshold than the others because some undelivered to bad numbers is normal at low volume."
  # NOTE: this is a COUNT-based alarm (raw undelivered/failed count per 5 min).
  # The better high-volume design is a RATE alarm (undelivered / attempts) via a
  # CloudWatch metric-math expression so a busy period doesn't false-page — that
  # needs an attempts/sent metric to divide against and is DEFERRED until send
  # volume warrants it. Until then this count bar is the honest, simple signal.
  namespace           = local.metric_namespace
  metric_name         = "DeliveryFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.delivery_failures_threshold
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

# Root-volume disk usage. The CloudWatch agent is installed via EC2 user_data
# (Task 1); treat_missing_data keeps the alarm quietly OK if the agent dies.
# Dimensions match the agent config (path "/", xfs on AL2023, drop_device:true).
resource "aws_cloudwatch_metric_alarm" "disk_used" {
  alarm_name          = "${var.name_prefix}disk-used"
  alarm_description   = "Root volume above ${var.disk_used_alarm_threshold}% (CWAgent disk_used_percent; agent installed via EC2 user_data)."
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

# Host memory. Two-tier, both → the alerts SNS topic:
#   warn:     mem_used_percent > 80% sustained 15 min (3 x 5-min) — slow leak/creep.
#   critical: mem_used_percent > 90% for 5 min (1 x 5-min)        — acute near-OOM spike.
# Data arrives once the CloudWatch agent is installed (Task 1); notBreaching keeps
# them quiet before that / if the agent dies. On a 2 GB t4g.small the app+worker
# Node containers make memory the real pressure point (OOM survived by
# restart:unless-stopped; these alarms are the leading-indicator warning).
resource "aws_cloudwatch_metric_alarm" "mem_used" {
  alarm_name          = "${var.name_prefix}mem-used"
  alarm_description   = "Memory above ${var.mem_used_warn_threshold}% sustained 15 min (CWAgent mem_used_percent)."
  namespace           = "CWAgent"
  metric_name         = "mem_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.mem_used_warn_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = var.instance_id
  }
}

resource "aws_cloudwatch_metric_alarm" "mem_used_critical" {
  alarm_name          = "${var.name_prefix}mem-used-critical"
  alarm_description   = "Memory above ${var.mem_used_critical_threshold}% for 5 min (CWAgent mem_used_percent) — acute near-OOM."
  namespace           = "CWAgent"
  metric_name         = "mem_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.mem_used_critical_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  dimensions = {
    InstanceId = var.instance_id
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
          title  = "Disk used % (root)"
          region = data.aws_region.current.region
          stat   = "Maximum"
          period = 300
          metrics = [
            ["CWAgent", "disk_used_percent", "InstanceId", var.instance_id, "path", "/", "fstype", "xfs"],
          ]
        }
      },
      {
        type = "metric", x = 0, y = 12, width = 12, height = 6
        properties = {
          title  = "Messaging delivery (doc §9: webhook + send failures)"
          region = data.aws_region.current.region
          stat   = "Sum"
          period = 300
          metrics = [
            [local.metric_namespace, "WebhookSignatureRejections"],
            [local.metric_namespace, "SendThrottled"],
            [local.metric_namespace, "DeliveryFailures"],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 12, width = 12, height = 6
        properties = {
          title  = "Memory used %"
          region = data.aws_region.current.region
          stat   = "Maximum"
          period = 300
          metrics = [
            ["CWAgent", "mem_used_percent", "InstanceId", var.instance_id],
          ]
        }
      },
    ]
  })
}
