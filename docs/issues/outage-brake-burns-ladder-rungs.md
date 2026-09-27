---
id: outage-brake-burns-ladder-rungs
title: A half-minute provider blip or throttle now fails a whole share for good - every braked pass spends a ladder rung, 429s never brake and are sent unpaced, and never-tried recipients close as "gave up after repeated temporary errors"
type: bug
severity: med
status: open
area: app/jobs
created: 2026-09-27
refs: app/src/jobs/broadcastFanOut.ts:1062, app/src/jobs/broadcastFanOut.ts:136, app/src/jobs/broadcastFanOut.ts:148, app/src/jobs/broadcastFanOut.ts:1146, app/src/jobs/broadcastFanOut.ts:817, app/src/jobs/broadcastFanOut.ts:1044, app/src/lib/sendOutcome.ts:104, app/src/lib/sendOutcome.ts:50, app/src/jobs/relayFanOut.ts:152, app/src/jobs/relayFanOut.ts:1440, app/src/jobs/relayFanOut.ts:1508, dashboard/src/routes/contact/deliveryStatus.ts:1052
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding M-2
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Problem.** The branch's outage brake (spec D9) stops a pass from spraying
an unhealthy provider, but it is wired to the same three-rung ladder as an
ordinary transient failure, so a short provider incident exhausts the ladder
and closes the share permanently - most of it never attempted.

1. **Every braked pass spends a rung.** After 3 consecutive unknown outcomes
   (`OUTAGE_BRAKE_UNKNOWN_STREAK`, `app/src/lib/sendOutcome.ts:50`) the pass
   defers its untried remainder (`app/src/jobs/broadcastFanOut.ts:1062-1097`).
   That remainder rides the ordinary continuation: 3 passes
   (`MAX_BROADCAST_ATTEMPTS`, `:136`), spaced 10 s then 20 s
   (`broadcastBackoffMs`, `:148-150`, scheduled at `:1146-1166`). At the cap
   the still-deferred recipients are closed `failed`/`transient_cap` (close A,
   `:1147-1151`). So a braked outage has about 30 s to clear before the share
   is closed.
2. **Retryable errors never brake, and are not paced.** A 429 or a Twilio
   20429 is `retryable` (`classifySendFailure`,
   `app/src/lib/sendOutcome.ts:104-111`), which defers the recipient
   (`broadcastFanOut.ts:1044-1055`) and resets the streak - it never counts
   toward the brake. And a failed send acquires no A2P token (the token is
   drawn only after a RECORDED send, `afterSend`,
   `broadcastFanOut.ts:817-826`), so under a throttle storm every recipient of
   every pass is sent to the provider back to back, unpaced.
3. **The reason text is untrue for the never-tried.** A `transient_cap` slot
   renders "Sending gave up after repeated temporary errors"
   (`INTERNAL_CODE_REASONS`,
   `dashboard/src/routes/contact/deliveryStatus.ts:1052`), including for
   recipients the platform never tried at all.

**Evidence.** The reviewer's throwaway FakeWorld tests (pure unit, no
DynamoDB, deleted afterwards; method in the review file's header), 20
recipients, passes 2 and 3 run from the recorded continuations:

- every send answers 503 / 20503: 9 provider calls in total (3 per pass,
  each pass braking after its third unknown), and the other 11 recipients
  are closed `failed`/`transient_cap` without ever being attempted;
- every send answers 429 / 20429: 60 provider calls (all 20 recipients on
  each of the 3 passes), all 20 closed `failed`/`transient_cap`, share
  `failed`.

**Relay has the same shape**, with a shorter ladder - 5 s then 10 s
(`fanOutBackoffMs`, `app/src/jobs/relayFanOut.ts:152-154`; the brake at
`:1440-1460`, the cap-close at `:1508-1511`) - though a group roster rarely
reaches 3 consecutive unknowns.

**Better than before, still wrong for the product.** Before the branch a 5xx
or 20429 threw and stranded the pass silently
([throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md));
now it closes loudly (the ERROR "broadcastFanOut: fan-out closed - remaining
recipients marked failed", `broadcastFanOut.ts:467-476`). But nobody would expect a
half-minute Twilio incident to fail a 500-tenant share permanently, and a
share closed `failed` also drops out of the "Already sent" set
([unconfirmed-share-invites-resend](./unconfirmed-share-invites-resend.md)).

**Suggested fix.** The reviewer's direction, not designed:

- do not charge a ladder rung to a braked remainder, or give the brake its
  own, longer backoff (minutes, not seconds) and its own cap;
- pace retryable failures - draw a token for a failed attempt too, or back
  off the pass on a 429 - and consider letting a run of retryables brake;
- close never-attempted recipients with a code whose prose is true (they
  were not sent because the provider was unavailable), or keep
  `transient_cap` only for recipients that were actually attempted.

**What this is NOT.** Not a double text: a braked or capped recipient was
never sent (or its unknown outcome went to reconcile, which never re-sends
blindly). Not a stuck share - the close is terminal and loud. The cost is
tenants who never get the property and a share that reads Failed.

**Related.** [unconfirmed-share-invites-resend](./unconfirmed-share-invites-resend.md),
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md),
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[send-outcome-dashboard-residues](./send-outcome-dashboard-residues.md).
