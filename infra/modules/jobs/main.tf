# jobs — async job delivery (M1.2): the SQS queue EventBridge Scheduler
# one-off schedules deliver job envelopes into, its DLQ, and the IAM role
# Scheduler assumes to SendMessage.
#
# The path: app jobs.enqueue() -> EventBridge one-off schedule
# (ActionAfterCompletion: DELETE, Target = this queue, Input = the JSON
# JobEnvelope) -> SQS message body -> worker long-poll -> dispatchJob().
# Failed handlers do NOT delete the message; after maxReceiveCount receives it
# lands in the DLQ, which the observability module alarms on (doc §9 "Job/DLQ
# depth").

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_caller_identity" "current" {}

# Dead-letter queue first (the main queue's redrive policy references it).
# 14-day retention = maximum debugging window before poison messages expire.
resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${var.name_prefix}jobs-dlq"
  message_retention_seconds = 1209600 # 14 days (SQS max)
}

# The jobs queue. Visibility timeout 120s must stay >= the longest job the
# worker runs (a handler that overruns it gets a duplicate delivery — SQS is
# at-least-once regardless). receive_wait_time_seconds makes long polling the
# queue-level default; the worker also asks for WaitTimeSeconds=20 explicitly.
resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name_prefix}jobs"
  visibility_timeout_seconds = 120
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

# Only the jobs queue may use this DLQ as its dead-letter target.
resource "aws_sqs_queue_redrive_allow_policy" "jobs_dlq" {
  queue_url = aws_sqs_queue.jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.jobs.arn]
  })
}

# ---------------------------------------------------------------------------
# IAM: the role EventBridge Scheduler assumes to deliver schedule payloads.
# Least privilege: sqs:SendMessage on exactly the jobs queue; trust pinned to
# scheduler.amazonaws.com in THIS account (confused-deputy guard).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler_send" {
  statement {
    sid       = "SendToJobsQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
}

resource "aws_iam_role_policy" "scheduler_send" {
  name   = "${var.name_prefix}scheduler-send"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_send.json
}
