variable "env" {
  description = "Stack environment name (dev / prod). Namespaces the Event Streams Sink + Subscription (description hc-<env>-relay-events) so dev + prod get DISTINCT, identifiable resources in the shared Twilio account, and picks the .env.<env> the local-exec reads Twilio creds from."
  type        = string
}

variable "enabled" {
  description = "Phase gate (the acm custom_domain_phase / inbound_mail manage_rule_set analog). FALSE (default) leaves this module INERT - a normal `npm run apply` provisions no Twilio sink and needs NO Twilio creds. Flip true ONLY after (a) the app is deployed with TWILIO_EVENTS_WEBHOOK_SECRET (secrets:push), and (b) .env.<env> carries the Twilio account creds the local-exec reads. See the module header + RUNBOOK 'Relay Event Streams sink'."
  type        = bool
  default     = false
}

variable "app_host" {
  description = "The env's canonical app host - no scheme, no trailing slash (e.g. dev.app.housingchoice.org). The webhook sink destination is https://<app_host>/webhooks/twilio/events. Use the PUBLIC CloudFront-fronted host (same as PUBLIC_BASE_URL), NOT the direct EC2 host: CloudFront stamps the x-origin-verify origin secret transparently, so external Twilio needs only the app-level Basic-auth secret. dev + prod differ, so the two sinks are distinct."
  type        = string
}

variable "webhook_secret" {
  description = "Shared Basic-auth secret embedded in the sink URL user-info; Twilio forwards it as Authorization: Basic base64(<webhook_user>:<secret>) and the app (config.twilioEventsWebhookSecret) constant-time compares the password. MUST equal the app's TWILIO_EVENTS_WEBHOOK_SECRET (secrets:push-managed). Leave EMPTY (default) so the provisioning script reads TWILIO_EVENTS_WEBHOOK_SECRET from .env.<env> at exec time - the recommended path, which keeps the secret OUT of Terraform state. Set it (e.g. via TF_VAR_twilio_events_webhook_secret) only to deliberately have Terraform supply it. NEVER hardcode a real secret in the env locals."
  type        = string
  default     = ""
  sensitive   = true
}

variable "webhook_user" {
  description = "Basic-auth username portion of the sink URL user-info. The app only checks the PASSWORD (the shared secret, constant-time compared - decision D4), so this is a stable, non-secret label for the Twilio-side credential. Default 'twilio-events'."
  type        = string
  default     = "twilio-events"
}

variable "event_types" {
  description = "The A2P compliance event types the Subscription binds at schema version 1 (decision D3). The number-registration.* types drive warming -> active promotion (T3); the number-deregistration.* counterparts are subscribed now for future retirement signalling (log-only today). Defaults to the six confirmed types."
  type        = list(string)
  default = [
    "com.twilio.messaging.compliance.number-registration.successful",
    "com.twilio.messaging.compliance.number-registration.pending",
    "com.twilio.messaging.compliance.number-registration.failed",
    "com.twilio.messaging.compliance.number-deregistration.successful",
    "com.twilio.messaging.compliance.number-deregistration.pending",
    "com.twilio.messaging.compliance.number-deregistration.failed",
  ]
}

variable "schema_version" {
  description = "Event Streams schema version subscribed for every type (decision D3: v1). The onNumberRegistered handler (T3) is written against the v1 payload, whose data fields are concatenated-lowercase (phonenumbersid / phonenumber / messagingservicesid - decision D1)."
  type        = number
  default     = 1
}
