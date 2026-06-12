# budget — monthly cost guardrail with email alerts.
#
# NOTE: with no cost filters, an AWS budget tracks the WHOLE account, so the
# dev and prod stacks each create an account-wide budget (hc-dev-monthly /
# hc-prod-monthly) with the same scope. Idle steady-state is ~$25/mo; the
# default $40 limit gives headroom without hiding runaway spend. Per-stack
# cost filtering (tag Stack=hc-<env>) needs cost-allocation-tag activation —
# a post-Phase-0 refinement.

resource "aws_budgets_budget" "monthly" {
  name        = "${var.name_prefix}monthly"
  budget_type = "COST"
  time_unit   = "MONTHLY"

  limit_amount = tostring(var.monthly_limit_usd)
  limit_unit   = "USD"

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = [var.alert_email]
  }
}
