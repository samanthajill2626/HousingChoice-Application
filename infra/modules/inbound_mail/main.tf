# inbound_mail - the classic-SES DOMAIN family for two-way email on
# var.mail_domain (email-channel-v1). SEPARATE from modules/ses (that module is
# an aws_ses_email_identity - a single verified sender ADDRESS still in the SES
# sandbox); this module authors the DOMAIN identity + DKIM + configuration set +
# the receipt-rule inbound pipeline (S3 + SNS -> one SQS queue the worker reads).
#
# CLASSIC SES throughout, not SESv2 (plan review F21): receipt rules exist only
# in the classic API, so identity/DKIM/config-set stay in the same family for
# consistency.
#
# DNS lives at NAMECHEAP, not Route 53 - like the acm module, Terraform CANNOT
# create the DKIM/MX/SPF records. The apply is staged via var.mail_domain_phase
# (the acm custom_domain_phase analog):
#   phase 0 -> create the identity + DKIM + all DNS-independent plumbing (SNS,
#              SQS, S3, config set) and EMIT the DKIM/verification/MX/SPF records
#              as outputs for manual Namecheap entry. Nothing blocks; unlike ACM
#              classic SES has no verification-wait resource.
#   phase 1 -> create the receipt rule (routes the domain's inbound mail to S3 +
#              the mail-inbound topic) and, on the managing env only, the shared
#              receipt-rule-set + its account-level activation. Flip to 1 ONLY
#              after the DNS records are entered + the domain verifies, so
#              inbound routing turns on against a live MX (RUNBOOK "Email (SES)").
#
# RECEIPT-RULE-SET SINGLETON (plan review F20): SES allows exactly ONE ACTIVE
# receipt rule set per account+region, and dev+prod SHARE the account. So the
# rule SET (name var.rule_set_name = "hc-inbound-mail") and its activation are
# created by ONE managing env only (var.manage_rule_set - dev), while EVERY env
# adds its OWN receipt rule (recipients = its own var.mail_domain) referencing
# the shared set BY NAME. The managing env's set must EXIST (dev applied at
# phase 1) BEFORE a non-managing env (prod) applies its rule - documented
# ordering in the RUNBOOK. Never destroy the managing env without migrating set
# ownership: tearing down dev deactivates the shared set and stops PROD inbound.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # Inbound routing (the receipt rule) turns on at phase 1 - after the operator
  # has entered the DKIM/MX/SPF records emitted by the phase-0 apply.
  inbound_enabled = var.mail_domain_phase >= 1
  # The shared rule set + its account-level activation are created only by the
  # managing env, and only once inbound is enabled.
  manage_set = var.manage_rule_set && local.inbound_enabled
}

# ---------------------------------------------------------------------------
# Domain identity + DKIM. Both emit DNS records the operator enters in Namecheap
# (see outputs.tf); neither blocks the apply (no verification-wait resource).
# ---------------------------------------------------------------------------

resource "aws_ses_domain_identity" "mail" {
  domain = var.mail_domain
}

resource "aws_ses_domain_dkim" "mail" {
  domain = aws_ses_domain_identity.mail.domain
}

# ---------------------------------------------------------------------------
# Configuration set + event destination: outbound send events (bounce /
# complaint / delivery) fan out to the mail-events SNS topic, which the same
# inbound-mail SQS queue subscribes to (B5 applies them to delivery status +
# suppression flags). Outbound sends must set this configuration set name.
# ---------------------------------------------------------------------------

resource "aws_ses_configuration_set" "mail" {
  name = "${var.name_prefix}mail"
}

resource "aws_ses_event_destination" "mail_events" {
  name                   = "${var.name_prefix}mail-events"
  configuration_set_name = aws_ses_configuration_set.mail.name
  enabled                = true
  matching_types         = ["bounce", "complaint", "delivery"]

  sns_destination {
    topic_arn = aws_sns_topic.mail_events.arn
  }

  # SES validates it can publish to the topic when the destination is created.
  depends_on = [aws_sns_topic_policy.mail_events]
}

# ---------------------------------------------------------------------------
# SNS topics. NO in-repo SNS precedent - written fresh from provider knowledge.
#   mail-events  <- SES configuration-set event destination (outbound events)
#   mail-inbound <- SES receipt-rule S3 action notification (inbound received)
# Both fan IN to the single inbound-mail SQS queue below.
#
# Each topic carries a resource policy allowing the SES service to publish
# (SNS denies a service principal by default; without this SES cannot deliver
# and CreateReceiptRule / the event destination fail at apply). Confused-deputy
# guarded by the account condition - mirrors the jobs module's aws:SourceAccount
# pin. The condition KEY differs by SES subsystem: receipt-rule actions populate
# the classic aws:Referer (= account id, same key the S3 bucket policy uses),
# configuration-set event destinations populate aws:SourceAccount.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "mail_events" {
  name = "${var.name_prefix}mail-events"
}

data "aws_iam_policy_document" "mail_events_publish" {
  statement {
    sid       = "AllowSESConfigSetPublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.mail_events.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "mail_events" {
  arn    = aws_sns_topic.mail_events.arn
  policy = data.aws_iam_policy_document.mail_events_publish.json
}

resource "aws_sns_topic" "mail_inbound" {
  name = "${var.name_prefix}mail-inbound"
}

data "aws_iam_policy_document" "mail_inbound_publish" {
  statement {
    sid       = "AllowSESReceiptRulePublish"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.mail_inbound.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:Referer"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "mail_inbound" {
  arn    = aws_sns_topic.mail_inbound.arn
  policy = data.aws_iam_policy_document.mail_inbound_publish.json
}

# ---------------------------------------------------------------------------
# The inbound-mail SQS queue (+ DLQ) - mirrors the jobs module's queue/DLQ/
# redrive shapes. BOTH SNS topics deliver here; the worker's second
# SqsJobConsumer long-polls it (prod only - the harness has no local SQS, so
# local inbound is the fake POSTing to /webhooks/ses/inbound instead).
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "inbound_mail_dlq" {
  name                      = "${var.name_prefix}inbound-mail-dlq"
  message_retention_seconds = 1209600 # 14 days (SQS max)
}

resource "aws_sqs_queue" "inbound_mail" {
  name                       = "${var.name_prefix}inbound-mail"
  visibility_timeout_seconds = 120
  receive_wait_time_seconds  = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.inbound_mail_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "inbound_mail_dlq" {
  queue_url = aws_sqs_queue.inbound_mail_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.inbound_mail.arn]
  })
}

# SNS->SQS requires an explicit queue policy (the subscription alone is not
# enough); allow ONLY the two mail topics to SendMessage to the queue.
data "aws_iam_policy_document" "inbound_mail_queue" {
  statement {
    sid       = "AllowMailTopicsSend"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.inbound_mail.arn]

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = [
        aws_sns_topic.mail_events.arn,
        aws_sns_topic.mail_inbound.arn,
      ]
    }
  }
}

resource "aws_sqs_queue_policy" "inbound_mail" {
  queue_url = aws_sqs_queue.inbound_mail.id
  policy    = data.aws_iam_policy_document.inbound_mail_queue.json
}

# raw_message_delivery = false: the queue receives the full SNS envelope
# ({Type:'Notification', Message:'<json>'}) that the worker's sesNotifications
# parser (B4) expects - NOT the bare inner payload.
resource "aws_sns_topic_subscription" "events_to_queue" {
  topic_arn            = aws_sns_topic.mail_events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.inbound_mail.arn
  raw_message_delivery = false
}

resource "aws_sns_topic_subscription" "inbound_to_queue" {
  topic_arn            = aws_sns_topic.mail_inbound.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.inbound_mail.arn
  raw_message_delivery = false
}

# ---------------------------------------------------------------------------
# Inbound-mail S3 bucket: the SES receipt rule writes raw MIME here. Same
# private posture as s3_media (SSE-S3, versioned, all public access blocked) +
# a bucket policy granting the SES service PutObject (the classic receipt-rule
# S3 action). account-id suffix keeps the global bucket name unique.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "inbound" {
  bucket = "${var.name_prefix}inbound-mail-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # SSE-S3 (free; no KMS by lean decision)
    }
  }
}

resource "aws_s3_bucket_public_access_block" "inbound" {
  bucket                  = aws_s3_bucket.inbound.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SES receipt-rule S3 action write grant. The classic pattern: principal =
# ses.amazonaws.com, action = s3:PutObject, with aws:Referer pinned to THIS
# account (the documented SES receipt-rule condition key). A service-principal
# grant, NOT a public one, so it coexists with block_public_policy above (that
# check only rejects public / `*`-principal policies).
data "aws_iam_policy_document" "inbound_bucket" {
  statement {
    sid       = "AllowSESReceiptRulePuts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbound.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:Referer"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "inbound" {
  bucket = aws_s3_bucket.inbound.id
  policy = data.aws_iam_policy_document.inbound_bucket.json
}

# ---------------------------------------------------------------------------
# Receipt rules (phase 1). The shared rule SET + its account-level ACTIVATION
# are the account singleton - created by the managing env only. EVERY env adds
# its OWN rule (recipients = its own mail_domain) into the shared set.
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "shared" {
  count         = local.manage_set ? 1 : 0
  rule_set_name = var.rule_set_name
}

resource "aws_ses_active_receipt_rule_set" "shared" {
  count         = local.manage_set ? 1 : 0
  rule_set_name = var.rule_set_name

  depends_on = [aws_ses_receipt_rule_set.shared]
}

# This env's inbound rule: deliver mail addressed to var.mail_domain to the
# inbound bucket AND notify the mail-inbound topic (a single s3_action with a
# topic_arn is the classic "store then notify" action - SES writes the object,
# then publishes a Received notification carrying bucketName/objectKey +
# spam/virus verdicts, exactly the B4 parser shape). References the shared set
# BY NAME so a non-managing env composes into the managing env's set (which must
# already exist - see the module header + RUNBOOK ordering). scan_enabled = true
# turns on SES spam/virus verdicts (consumed by the B2 ingestion tiers).
resource "aws_ses_receipt_rule" "inbound" {
  count = local.inbound_enabled ? 1 : 0

  name          = "${var.name_prefix}inbound"
  rule_set_name = var.rule_set_name
  recipients    = [var.mail_domain]
  enabled       = true
  scan_enabled  = true

  s3_action {
    bucket_name = aws_s3_bucket.inbound.id
    topic_arn   = aws_sns_topic.mail_inbound.arn
    position    = 1
  }

  # The shared set must exist first (managing env orders set-then-rule; a
  # non-managing env's count-0 reference is empty and the set is expected to
  # pre-exist). The bucket + topic policies must be in place before SES
  # validates the s3_action at CreateReceiptRule.
  depends_on = [
    aws_ses_receipt_rule_set.shared,
    aws_s3_bucket_policy.inbound,
    aws_sns_topic_policy.mail_inbound,
  ]
}
