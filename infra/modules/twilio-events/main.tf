# twilio-events - the relay Event Streams Sink (webhook) + Subscription that
# promote a warming pool number to active on the A2P number-registration event
# (relay number buying strategy, T10). Per env: a webhook Sink POSTing each
# CloudEvents batch to https://<app-host>/webhooks/twilio/events (Basic-auth in
# the URL user-info - decision D4) and a Subscription binding it to the
# compliance number-registration + number-deregistration event types at schema
# version 1 (decision D3). dev + prod get DISTINCT sinks (Event Streams config
# is account-scoped, keyed here by the hc-<env>-relay-events description).
#
# WHY A terraform_data + local-exec CALLING A SCRIPT, NOT A TWILIO TF PROVIDER
# (the T10 approach decision, documented per the task):
#   - No Twilio provider is configured in this repo. infra/ is AWS-only
#     (hashicorp/aws + hashicorp/random); adding one coples Twilio API creds into
#     AWS-account-guarded Terraform state.
#   - Twilio's community TF provider (RJPearson94/twilio, v0.18.x) is in PILOT /
#     unmaintained, pre-1.0, and has NO Event Streams Sink/Subscription
#     resources (verified 2026-07-21). Guessing a resource name that may not
#     exist is exactly what the task forbids.
#   - This mirrors the repo's established pattern for account-scoped Twilio
#     config: scripts/twilioVi.mjs (idempotent create-or-reconcile). The REST
#     work lives in scripts/twilioEventsSink.mjs; this module makes it a per-env,
#     wired-into-the-stack apply surface. Eventual full Twilio IaC is tracked in
#     docs/issues/twilio-config-into-terraform.md.
#   terraform_data (built in since TF 1.4; the stacks require >= 1.15) is used
#   instead of a null_resource so NO extra provider is added to the stack.
#
# INERT BY DEFAULT: var.enabled = false (count 0) means a normal
# `npm run apply -- <env>` provisions NOTHING here and needs NO Twilio creds -
# the same phase-gate posture as acm's custom_domain_phase / inbound_mail's
# manage_rule_set. Flip local.twilio_events_enabled true (per env) ONLY after the
# app is deployed with TWILIO_EVENTS_WEBHOOK_SECRET and .env.<env> carries the
# Twilio account creds the local-exec reads. See RUNBOOK "Relay Event Streams
# sink". NEVER run terraform by hand - `npm run plan|apply -- <env>`.

terraform {
  # terraform_data is a built-in resource type (>= 1.4); no provider required.
  required_version = ">= 1.15"
}

locals {
  # The PUBLIC destination Twilio POSTs each event batch to. Hits the env's
  # CloudFront-fronted canonical host, which transparently stamps the
  # x-origin-verify origin secret before the origin - so external Twilio needs
  # only the app-level Basic-auth secret (in the sink URL user-info at exec
  # time), never CF_ORIGIN_SECRET. The secret is NOT in this URL (kept out of
  # state); the script embeds it.
  destination_url = "https://${var.app_host}/webhooks/twilio/events"

  # Any change here REPLACES the resource, re-running the provisioner against the
  # idempotent script. The SECRET is deliberately excluded (it would land in
  # state); it flows through the provisioner environment only.
  desired = {
    env            = var.env
    destination    = local.destination_url
    webhook_user   = var.webhook_user
    event_types    = join(",", var.event_types)
    schema_version = tostring(var.schema_version)
  }

  # Absolute path to the provisioning script, so locating it never depends on the
  # provisioner working directory. The script itself resolves the repo root (and
  # thus .env.<env>) from its own location.
  script_path = abspath("${path.module}/../../../scripts/twilioEventsSink.mjs")
}

resource "terraform_data" "sink" {
  count = var.enabled ? 1 : 0

  # A config change forces replace -> destroy (delete old sink+subscription) then
  # create (make them fresh). input carries env + the script path to the
  # destroy-time provisioner, which may reference ONLY self (not var/local/path).
  input            = { env = var.env, script = local.script_path }
  triggers_replace = local.desired

  # Create / re-create: idempotent create-or-reconcile of the Sink + Subscription.
  provisioner "local-exec" {
    when = create
    # Run node AS THE INTERPRETER so the script path is passed as a single argv
    # element - NOT through a shell. A plain `command = "node <path>"` is executed
    # via `cmd /C "..."` on Windows, whose nested-quote handling mangles a spaced,
    # quoted path (an operator checkout can sit under "...\HC Application\..."). The
    # interpreter form bypasses cmd entirely and is correct cross-platform.
    interpreter = ["node"]
    command     = local.script_path
    environment = {
      TWILIO_EVENTS_ENV            = var.env
      TWILIO_EVENTS_APP_HOST       = var.app_host
      TWILIO_EVENTS_WEBHOOK_USER   = var.webhook_user
      TWILIO_EVENTS_TYPES          = join(",", var.event_types)
      TWILIO_EVENTS_SCHEMA_VERSION = tostring(var.schema_version)
      # Empty -> the script reads TWILIO_EVENTS_WEBHOOK_SECRET from .env.<env>
      # (recommended; keeps the secret OUT of Terraform state). A non-empty var
      # OVERRIDES that (the Terraform-supplied path).
      TWILIO_EVENTS_WEBHOOK_SECRET_OVERRIDE = var.webhook_secret
      TWILIO_EVENTS_FROM_TERRAFORM          = "1"
    }
  }

  # Teardown (resource destroyed, module removed, or replaced): best-effort
  # delete of the Subscription + Sink. on_failure = continue so a Twilio hiccup
  # (or a missing .env at destroy time) never blocks `terraform destroy` of the
  # AWS stack - the operator can also delete in the Twilio console.
  provisioner "local-exec" {
    when       = destroy
    on_failure = continue
    # node as interpreter (see the create provisioner) - path passed intact, no shell.
    interpreter = ["node"]
    command     = self.input.script
    environment = {
      TWILIO_EVENTS_ENV            = self.input.env
      TWILIO_EVENTS_DESTROY        = "1"
      TWILIO_EVENTS_FROM_TERRAFORM = "1"
    }
  }
}
