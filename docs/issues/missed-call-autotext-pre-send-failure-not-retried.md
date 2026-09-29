---
id: missed-call-autotext-pre-send-failure-not-retried
title: A missed-call auto-text is dropped for good when a read fails before anything was sent, because the CallSid marker is already claimed
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-25
refs: app/src/jobs/missedCallAutoText.ts:175, app/src/jobs/missedCallAutoText.ts:184, app/src/jobs/missedCallAutoText.ts:232, app/src/jobs/missedCallAutoText.ts:240, app/src/jobs/missedCallAutoText.ts:254, app/src/jobs/missedCallAutoText.ts:264, app/src/services/sendMessage.ts:278, app/src/services/sendMessage.ts:307, app/src/services/sendMessage.ts:350, app/src/services/sendMessage.ts:394
---

**Problem.** `call.missedAutoText` texts a caller whose call we missed, once per
call ever. Its marker is keyed on the CallSid, not the job id
(`app/src/jobs/missedCallAutoText.ts:175`), deliberately: a redelivered status
callback can enqueue a second job, and the first to run must win (header
comment, `:7-14`). So any fresh enqueue for the same call is suppressed too.

After the claim, several failures are possible BEFORE anything is sent:

- the settings read (`:184`), unguarded;
- the token acquire (`:232`), outside the send try;
- the catalog resolve for the body (`:240`), inside the try;
- `sendMessage`'s own reads before the provider call (the conversation read at
  `app/src/services/sendMessage.ts:278`, the contact read at `:307`, the breaker
  increment at `:350`);
- a Twilio create that answers 4xx or 429 (`sendMessage.ts:394`), a definite
  non-send.

The handler rethrows every non-refusal error (`:264`), the job fails, and the
redelivery is suppressed by the CallSid marker. The caller never gets the text.

The comment at `:254-259` documents this as a deliberate tradeoff ("a transient
provider error on a best-effort courtesy text is not worth risking a
duplicate"). That reasoning holds for failures AFTER the provider call - the
[accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md)
production incident of 2026-09-09 was exactly this job - but it does not cover
the pre-send cases above, which carry no duplicate risk at all and are dropped
anyway.

Low severity: the founder still gets the missed-call push, the courtesy text is
best-effort, and the ERROR at `:260-263` is logged (for the send-try cases;
the settings read and the token acquire leave only the `job failed` line).

**Suggested fix.** Group: send-shaped - adopt the send-outcome core + the
send-attempt record from `feat/send-outcome-reconcile` (merged at `79b9479e`; see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9). With D3's typed errors the handler can tell `SendNotAttemptedError` and
a `rejected` / `retryable` provider failure (nothing sent: safe to re-enqueue
under a fresh id, bounded, or to record honestly) from an `unknown` outcome
(hand to the reconcile job) and from `SendAcceptedNotRecordedError` (sent: keep
suppressing, but record it - piece 2 of accepted-send-lost for this caller).
The settings read at `:184` needs local handling either way.

**Related.**
[accepted-send-lost-when-append-fails](./accepted-send-lost-when-append-fails.md),
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md).
Sweep finding F5 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
