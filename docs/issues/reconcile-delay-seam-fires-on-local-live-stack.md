---
id: reconcile-delay-seam-fires-on-local-live-stack
title: The e2e reconcile-delay seam is gated only on "no JOBS_QUEUE_URL", which is also the local npm run dev stack on real Twilio - a stray E2E_SEND_RECONCILE_DELAYS_MS there can re-send a real text
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-27
refs: app/src/jobs/sendReconcile.ts:148, app/src/jobs/sendReconcile.ts:156, scripts/e2e-session.mjs:296, app/src/jobs/retrySend.ts:92, app/src/jobs/retrySend.ts:110, app/src/lib/config.ts:543, app/src/index.ts:36
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding L-2
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Problem.** `reconcileCheckDelaysMs` replaces the production reconcile check
delays (5 s, 30 s, 240 s) with the value of `E2E_SEND_RECONCILE_DELAYS_MS`
whenever `JOBS_QUEUE_URL` is empty (`app/src/jobs/sendReconcile.ts:148-153`;
applied by `reconcileDelayMs`, `:156-158`). The hermetic lane sets it to
2000,4000,8000 (`scripts/e2e-session.mjs:296`).

"No queue URL" is meant to mean "the hermetic lane", but it also describes
the local `npm run dev` stack: the app runs jobs in-process with no queue URL
(`app/src/index.ts:36`), and in live mode that stack sends through REAL
Twilio. With the variable exported in that shell (left over from a lane
session, or copied from `scripts/e2e-session.mjs`), the reconcile's last
check runs at attemptedAt + 8 s instead of + 240 s.

**Why that can text twice.** `never_sent` is ruled only at the last check,
on a complete walk that found no message. The 2026-09-24 spike saw a
just-created message ABSENT from Twilio's list and present 2 s later
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/spike-twilio-idempotency-output.txt`,
steps B1 and B3; see
[send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md)
item 1). A message still unlisted or still queued at + 8 s is ruled
`never_sent` and re-driven: the recipient gets a second real text.

**Production is safe.** Every deployed worker and app sets `JOBS_QUEUE_URL`
(Terraform's jobs module), so the seam cannot fire there. The same pattern
pre-dates the branch: `E2E_SEND_RETRY_BACKOFF_MS` is guarded the same way
(`app/src/jobs/retrySend.ts:92-116`), and its docblock notes that local dev,
like the lane, leaves the queue URL unset - so the guard lets it through
there too. The relay twin, `E2E_RELAY_RETRY_BACKOFF_MS`
(`app/src/jobs/relayRetryLeg.ts:224`), takes the same guard.

**Suggested fix.** Gate the seam on a HERMETIC signal instead of (or in
addition to) the missing queue URL - for example `TWILIO_API_BASE_URL` being
set (it points the Twilio client at the fake, and config refuses it in
production, `app/src/lib/config.ts:543-558`), or an explicit `E2E_LANE`
variable the lane launcher sets. Apply the same guard to
`E2E_SEND_RETRY_BACKOFF_MS` and `E2E_RELAY_RETRY_BACKOFF_MS` in the same
change, so the three seams share one rule.

**What this is NOT.** Not reachable in any deployed environment. Not a defect
in the reconcile's verdict logic: with the production delays, the same
message would be listed long before + 240 s. It needs a developer to run the
live local stack with a lane-only variable exported.

**Related.** [send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md),
[send-attempt-rearm-residues](./send-attempt-rearm-residues.md).
