---
id: relay-redrive-late-unbounded-and-out-of-order
title: A never_sent re-drive has no freshness bound - a relay leg lands about 4 minutes late and out of order, a delayed chain re-drives whenever it runs, and a broadcast re-drive can text a listing already leased
type: bug
severity: med
status: open
area: app/messaging
created: 2026-09-27
refs: app/src/lib/sendOutcome.ts:30, app/src/jobs/sendReconcile.ts:897, app/src/jobs/sendReconcile.ts:1078, app/src/jobs/sendReconcile.ts:1123, app/src/jobs/relayFanOut.ts:843, app/src/jobs/relayFanOut.ts:1110, app/src/jobs/relayRetryLeg.ts:798, app/src/lib/retrySendWindow.ts:15, app/src/routes/broadcasts.ts:605
---

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), adversarial finding M-3
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/planner-review/adversarial.md`).
Anchors at HEAD `91a66577` (the code is identical to the code-final commit
`52220729`).

**Problem.** When the reconcile rules an ambiguous send `never_sent`, it
re-drives it once. Nothing bounds how late that re-drive may go out, or what
has happened in the conversation since.

1. **About 4 minutes late on the normal path.** `never_sent` is ruled only at
   the LAST check, attemptedAt + 240 s (`RECONCILE_CHECK_DELAYS_MS`,
   `app/src/lib/sendOutcome.ts:30`; the verdict at
   `app/src/jobs/sendReconcile.ts:897-906`), and the re-drive is enqueued then
   (`enqueueRedrive`, `sendReconcile.ts:1078-1115`). A relay member receives
   "Alice: Meet at 3" about four minutes after Alice sent it - after anything
   she or anyone else said in between - with no marker that it is late (the
   leg body is re-composed from the current roster,
   `app/src/jobs/relayFanOut.ts:1106-1116`).
2. **Unbounded when the chain is delayed.** The re-drive pre-check tests only
   group open, member on the roster, row present and continuation present
   (`redriveRefusal`, `sendReconcile.ts:1123-1130`), and the fan-out handler
   has no age gate (`relayFanOut.ts:843-903`). A reconcile chain delayed by an
   SQS backlog, a worker outage or an operator's DLQ redrive re-drives
   whenever it finally runs - minutes or hours after the original.
3. **The 30003 rung is bounded; the leg re-drive is not.** A relay retry RUNG
   re-driven through its own job IS checked against the retry send window
   (`app/src/jobs/relayRetryLeg.ts:798`; `RETRY_SEND_WINDOW_MS`, 15 minutes,
   `app/src/lib/retrySendWindow.ts:15`) - Cameron's ruling that nothing
   automatic re-sends a text more than 15 minutes after the original. The
   leg re-drive skips that rule.
4. **A broadcast re-drive does not re-check the unit.** The send route
   refuses a share whose unit is no longer shareable
   (`app/src/routes/broadcasts.ts:605-616`), but the fan-out pass does not
   re-check, so a late broadcast re-drive can text a tenant a listing that
   has since been leased or taken down. (The ordinary continuations share
   this gap, but they run seconds apart; a re-drive runs minutes later, or
   unbounded.)

**User-visible.** A group member gets a message minutes (or, after a
backlog, hours) late and out of order, reading as if just said; a tenant gets
a property that is no longer available.

**Suggested fix.** An age cap on the re-drive: in `redriveRefusal`
(`sendReconcile.ts:1123-1130`) - and for broadcast, which it currently waves
through (`:1124`) - close the record `redrive_refused` instead of re-driving
when the attempt is older than N minutes, measured from the origin of the
source row (the send the user made) the way the retry send window measures
from its origin. The reviewer's direction is to reuse the retry send window
(15 minutes) as N. For broadcast, also re-check the unit's shareable status
before a re-drive pass sends. **The value of N, and whether a relay re-drive
should go out late at all (or carry a "delayed" marker), is a product call
for Cameron.** Note the interaction: with N at 15 minutes the normal-path
re-drive (about 4 minutes) still goes out, late and out of order; only the
delayed chains are cut.

**What this is NOT.** Not a double text: the reconcile re-drives only after
a complete walk found no message, and at most once (`markRedriven`). Not the
30003 retry rung, which the window already bounds. Not the prose of the
`redrive_refused` reason (filed in
[send-outcome-dashboard-residues](./send-outcome-dashboard-residues.md),
item 4).

**Related.** [send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md)
(item 1: if a queued message is unlisted, the re-drive is a double text),
[send-reconcile-job-residues](./send-reconcile-job-residues.md),
[retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md).
