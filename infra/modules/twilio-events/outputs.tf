output "enabled" {
  description = "Whether this stack manages the relay Event Streams sink + subscription (var.enabled). False = the module is inert (no Twilio resource, no creds needed)."
  value       = var.enabled
}

output "description" {
  description = "The Event Streams Sink + Subscription description this stack owns (hc-<env>-relay-events). Find them under this name in the Twilio Console Event Streams UI / via scripts/twilioEventsSink.mjs --check."
  value       = "hc-${var.env}-relay-events"
}

output "destination_url" {
  description = "The public https .../webhooks/twilio/events URL the webhook sink POSTs each CloudEvents batch to (the Basic-auth secret is NOT shown - it is embedded in the sink URL user-info only at exec time and kept out of state)."
  value       = local.destination_url
}

output "event_types" {
  description = "The A2P compliance event types the subscription binds (schema v1) when enabled."
  value       = var.event_types
}
