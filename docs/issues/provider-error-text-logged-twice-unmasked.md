---
id: provider-error-text-logged-twice-unmasked
title: Provider error text reaches the logs twice and unmasked - ProviderSendFailedError copies its cause's message, and the reconcile logs list and fetch errors whole; a Twilio 4xx message may name the phone number
type: security
severity: low
status: open
area: app/observability
created: 2026-09-27
refs: app/src/services/sendMessage.ts:247, app/src/lib/logSerializers.ts:56, app/src/lib/logSerializers.ts:76, app/src/jobs/tourReminders.ts:1471, app/src/jobs/placementNudges.ts:707, app/src/jobs/missedCallAutoText.ts:260, app/src/routes/public.ts:314, app/src/lib/errors.ts:196, app/src/jobs/sendReconcile.ts:449, app/src/jobs/sendReconcile.ts:894, app/src/jobs/sendReconcile.ts:1018, app/src/lib/phone.ts:92
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27): adversarial finding L-5
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`)
and conformance finding P-8
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/conformance.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Problem - the send path logs the provider's text twice (L-5).** The
branch wraps every provider throw in `ProviderSendFailedError`, whose own
message copies the cause's message
(`app/src/services/sendMessage.ts:246-247`). The safe log serializer emits the
error's `message` (`app/src/lib/logSerializers.ts:56`) and then the cause's,
recursively (`:76-78`). So every caller that logs `err` on a non-refusal send
failure now carries the provider's text twice:

- tour reminders (`app/src/jobs/tourReminders.ts:1471-1474`, and the
  force-send line at `:2029`);
- placement nudges (`app/src/jobs/placementNudges.ts:707-710`, and the
  force-send line at `:886`);
- the missed-call auto-text (`app/src/jobs/missedCallAutoText.ts:260-263`);
- the housing-fair welcome (`app/src/routes/public.ts:314`);
- the Express error handler behind the staff send route
  (`app/src/lib/errors.ts:196-199`).

Twilio's 4xx messages for a bad destination may name the number (the exact
wording is UNVERIFIED). Nothing masks phone numbers inside an error MESSAGE:
the serializer allowlists fields, it does not rewrite them. The exposure
pre-dates the branch (the cause's message was already logged); the branch
doubles it.

**Problem - the reconcile logs list and fetch errors whole (P-8).** The
branch deliberately keeps `err` OFF its send-time rejection lines because "a
Twilio 4xx message can carry the phone number" (build S2a, deviation 4,
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/build/S2a-report.md:181-188`).
But the `send.reconcile` lookup logs a failed Messages list or fetch under
`err`: the WARN "the provider lookup failed at this check"
(`app/src/jobs/sendReconcile.ts:449`), and at the last check the
`provider_unreachable` verdict carries `err` (`:894`) into the unresolved
ERROR (`:1018-1021`). A list or fetch 4xx (other than a 404) would be logged
with its message. The list filters by the `To` number, so a 4xx that echoes
its parameters would carry it. Unlikely - the platform already sent to that
number - and UNVERIFIED: whether Twilio's list 4xx messages embed the `To`
number was not checked.

**Suggested fix.** Either or both:

- mask phone-shaped runs in `message` inside the safe serializer, with the
  existing masker (`maskPhonesInText`, `app/src/lib/phone.ts:92`, already
  used for request paths at `app/src/lib/errors.ts:178-197`). The serializer
  is a declared LEAF module with no imports (its header,
  `app/src/lib/logSerializers.ts:25-26`); `phone.ts` imports nothing, so the
  import does not close the logger cycle, but the rule must be revisited
  deliberately (or the regex inlined);
- give `ProviderSendFailedError` a fixed message (its classification and
  code only) and leave the provider's text under `cause`, so it is logged
  once.

For the reconcile lines, the same masking covers them; alternatively log the
list/fetch failure's code and status only, as the send-time rejection arms do.

**What this is NOT.** Not a credential leak: the allowlist still drops the
SDK error's config, headers and request body
([twilio-sdk-error-logs-leak-credentials](./twilio-sdk-error-logs-leak-credentials.md),
resolved). Not a new exposure class - the provider's message was logged
before the branch - and not verified to contain a phone number at all.

**Related.** [err-string-log-sites-remain](./err-string-log-sites-remain.md),
[phone-in-url-paths-structural](./phone-in-url-paths-structural.md),
[twilio-sdk-error-logs-leak-credentials](./twilio-sdk-error-logs-leak-credentials.md).
