---
id: twilio-config-into-terraform
title: Move all Twilio configuration into infrastructure-as-code
type: debt
severity: low
status: open
area: infra
created: 2026-07-20
refs: scripts/twilioVi.mjs, scripts/twilioEventsSink.mjs, infra/modules/twilio-events, RUNBOOK.md
---

**Problem.** Twilio config is entirely console-managed and hand-documented in
the RUNBOOK: number voice/SMS webhooks, the Messaging Service + its integration
webhooks, A2P campaign membership, the inbound-voice-line, and now the Voice
Intelligence service. None of it is in Terraform (infra/ is AWS-only:
hashicorp/aws + hashicorp/random). Every setup is a manual, order-sensitive
console click-through that is easy to get wrong (wrong webhook host -> silent
403s; a stray auto-transcribe/capture toggle -> duplicate transcription cost)
and has no drift detection. This bit us during VI setup (2026-07-20): the
console onboarding pushed the Conversation Orchestrator (capture/rules/operators)
that we do not use, and the actual resource we needed was one API call.

Interim mitigation shipped: `scripts/twilioVi.mjs` (`npm run twilio:vi -- <env>`)
is an idempotent create-or-reconcile for the VI service - the repo's existing
operator-script pattern (cf. vapidKeys.mjs), chosen over Terraform because
Twilio's first-party TF provider is deprecated/archived and this was the only
Twilio resource we would have managed as code (partial IaC = split-brain).

A second script joined this set with the relay number buying strategy (T10):
`scripts/twilioEventsSink.mjs` (`npm run twilio:events -- <env>`) create-or-
reconciles the Event Streams webhook Sink + Subscription that promote a warming
pool number to active. It is additionally wrapped by `infra/modules/twilio-events`
(a `terraform_data` `local-exec`, gated OFF by default) so it can ride the
per-env stack when an operator opts in. Data point for the provider decision
below: the community `RJPearson94/twilio` provider (v0.18.x, PILOT) has **no**
Event Streams Sink/Subscription resources (verified 2026-07-21), so it could not
have expressed this surface either - reinforcing "check coverage before
committing to a provider".

**Suggested fix.** Decide whether to adopt IaC for Twilio as a deliberate
initiative (not one resource at a time). Options to evaluate:
- A community Terraform provider (e.g. RJPearson94/twilio) - CHECK its coverage
  of the Intelligence v2 Services resource before committing; a provider that
  cannot express the resources we use is a non-starter.
- A cohesive set of idempotent scripts under `scripts/` (extend the twilioVi.mjs
  pattern to numbers/messaging-service/webhooks) if no provider covers our
  surface - still declarative-desired-state + re-runnable, without a provider.
Whichever path: migrate the RUNBOOK's manual Twilio console steps into it, and
retire the interim scripts it subsumes (twilioVi.mjs). Until then, the RUNBOOK
remains the source of truth for the manual steps.
