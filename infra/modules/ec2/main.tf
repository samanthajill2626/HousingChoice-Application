# ec2 — the single t4g.small app host (app + worker containers via compose).
#
# Access model: NO SSH anywhere (no key pair, no port 22) — operator access is
# SSM Session Manager via AmazonSSMManagedInstanceCore. User-data only
# prepares the box (docker + compose v2 + /opt/hc); everything app-specific
# (image pull, .env hydration, compose up) is M0.5's deploy via SSM Run
# Command, so instance replacement never bakes in app state.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Latest AL2023 ARM64 AMI via the public SSM alias. insecure_value: the AMI id
# is public data, not a secret — keeps it readable in plans.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ---------------------------------------------------------------------------
# IAM: hc-<env>-instance role — SSM core + least-privilege app permissions.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name_prefix}instance"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app" {
  # DynamoDB CRUD on exactly the 9 stack tables + their GSIs.
  statement {
    sid = "DynamoTables"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:ConditionCheckItem",
      "dynamodb:DescribeTable",
    ]
    resources = concat(
      values(var.table_arns),
      [for arn in values(var.table_arns) : "${arn}/index/*"],
    )
  }

  # Media bucket objects + property.
  statement {
    sid = "MediaObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${var.media_bucket_arn}/*"]
  }
  statement {
    sid       = "MediaList"
    actions   = ["s3:ListBucket"]
    resources = [var.media_bucket_arn]
  }

  # Jobs queue (M1.2 + delay refactor): the worker consumes (Receive/Delete/
  # GetQueueAttributes) AND the app SendMessages job envelopes directly to the
  # queue. After the delay refactor every job whose delay is <=12min — the
  # immediate path (relay/broadcast fan-out, M1.7) and ALL short backoff
  # (retry 60/120/240s, relay/broadcast continuations 5/10/20s) — is an SQS
  # SendMessage with DelaySeconds straight to this queue (no EventBridge hop).
  # sqs:SendMessage is therefore required here; it also fixes the latent M1.7
  # gap where the immediate path already SendMessaged but the role didn't allow
  # it (AccessDenied in AWS). EventBridge Scheduler + its role (below) are used
  # ONLY for >12min long-horizon delays (future jobs; no Phase-1 callers).
  # Least-privilege: SendMessage on this one queue ARN only.
  statement {
    sid = "JobsQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage",
    ]
    resources = [var.jobs_queue_arn]
  }

  # jobs.enqueue() creates one-off EventBridge schedules ONLY for >12min
  # long-horizon delays (dormant in Phase 1; <=12min jobs go direct-to-queue
  # above). ActionAfterCompletion DELETE — the service deletes fired schedules
  # itself, the instance never needs scheduler:DeleteSchedule. Adapter names are
  # `hc-<job>-<uuid>` in the default group; both stacks share the account, so the
  # real isolation is PassRole below — this instance can only hand Scheduler ITS
  # stack's role, which can only SendMessage to ITS stack's queue.
  statement {
    sid     = "SchedulerCreate"
    actions = ["scheduler:CreateSchedule"]
    resources = [
      "arn:aws:scheduler:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:schedule/default/hc-*",
    ]
  }
  statement {
    sid       = "SchedulerPassRole"
    actions   = ["iam:PassRole"]
    resources = [var.scheduler_role_arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }

  # Config/secret hydration from Parameter Store (/hc/<env>/...). SecureString
  # decryption uses the AWS-managed aws/ssm key, which needs no extra grant.
  statement {
    sid = "Params"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = [
      "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/hc/${var.env}/*",
    ]
  }

  # ECR pulls. GetAuthorizationToken is account-wide by design (not resource-
  # scopable); the pull actions are pinned to the stack repo.
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchCheckLayerAvailability",
    ]
    resources = [var.ecr_repository_arn]
  }

  # CloudWatch Logs under the stack namespace only.
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*",
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*:*",
    ]
  }

  # Custom metrics. PutMetricData is not resource-scopable; constrain by
  # namespace instead (app metrics + the CloudWatch agent's CWAgent).
  statement {
    sid       = "Metrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["hc/${var.env}", "CWAgent"]
    }
  }

  # System Status read model (M1.4): backs the admin-only Settings → System
  # Status panel — DescribeAlarms (alarm metadata, filtered AlarmNamePrefix
  # hc-<env>- in the app) + FilterLogEvents (recent app errors, pino level ≥ 50).
  # Read-only; the panel degrades gracefully until this is applied.
  statement {
    sid = "SystemStatusObservability"
    actions = [
      # NOTE: cloudwatch:DescribeAlarms does NOT support resource-level
      # permissions, so resources = ["*"] is REQUIRED here (there is nothing
      # narrower to constrain by; this is read-only alarm metadata).
      "cloudwatch:DescribeAlarms",
    ]
    resources = ["*"]
  }
  statement {
    sid = "SystemStatusLogs"
    # FilterLogEvents is missing from the "Logs" statement above (which grants
    # only Create/Put for the agent). Scope it to THIS env's log groups.
    actions = ["logs:FilterLogEvents"]
    resources = [
      "arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/hc/${var.env}/*:*",
    ]
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "${var.name_prefix}instance-app"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.app.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name_prefix}instance"
  role = aws_iam_role.instance.name
}

# ---------------------------------------------------------------------------
# Instance + stable EIP.
# ---------------------------------------------------------------------------

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [var.security_group_id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  # IMDSv2 required; hop limit 2 so processes INSIDE containers (one NAT hop
  # away) can still reach IMDS for role credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  # Box prep ONLY — nothing app-specific here. Deploy (M0.5) ships images,
  # .env, and compose files via SSM Run Command.
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf install -y docker
    systemctl enable --now docker
    # docker compose v2 CLI plugin (ARM64) — not packaged in AL2023 repos.
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL --retry 5 -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/${var.compose_version}/docker-compose-linux-aarch64"
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    mkdir -p /opt/hc
  EOT

  # The AMI is resolved from the rolling "latest AL2023" SSM alias at first
  # apply, then pinned: without this, every AL2023 release would plan an
  # instance replacement. OS patching is dnf via SSM; instance replacement is
  # a deliberate act (taint / -replace).
  lifecycle {
    ignore_changes = [ami]
  }

  tags = {
    Name = "${var.name_prefix}app"
  }
}

# EIP = stable public IP AND stable public DNS (ec2-<ip>.compute-1.amazonaws.com),
# which is what CloudFront uses as its origin. The doc says "origin = EC2
# public DNS"; the EIP's public DNS IS that, just stable across stop/start —
# without it the origin domain would change on every instance stop.
resource "aws_eip" "app" {
  domain = "vpc"

  tags = {
    Name = "${var.name_prefix}app"
  }
}

resource "aws_eip_association" "app" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app.id
}
