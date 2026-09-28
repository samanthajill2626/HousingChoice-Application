---
id: share-list-sse-patch-rebucket-and-refresh
title: The Not-confirmed re-bucketing lives only in the share routes, so an SSE patch can move a recipient from Not confirmed to Not sent on the property-sends list with no refetch
type: bug
severity: low
status: open
area: dashboard/broadcasts
created: 2026-09-28
refs: app/src/services/shareRecipientState.ts:223, app/src/routes/broadcasts.ts:251, app/src/routes/broadcasts.ts:885, app/src/routes/broadcasts.ts:941, app/src/services/shareAttemptOutcome.ts:206, app/src/routes/webhooks/twilio.ts:4113, dashboard/src/routes/broadcasts/useBroadcastsList.ts
---

**Found by.** The plan-blind adversarial code review of `feat/share-sent-outcome`
(round 1, ADV-9; `docs/superpowers/reviews/2026-09-27-share-sent-outcome/code-review/adversarial-r1.md`),
ACCEPTED in `r1-adjudications.md`. Anchors at the branch's fix wave 1.

**Problem.** A recipient whose newest attempt's ROW says its chain ended
unresolved (`retry_outcome: 'unconfirmed'`) while the slot never learned it
reads "Not confirmed": the results and list routes move it from `failed` to
`unconfirmed` (`unconfirmedByRow`, `app/src/services/shareRecipientState.ts:223`,
fed to `deriveBroadcastStats` by `statsWithStates`,
`app/src/routes/broadcasts.ts:251`, used at `:885` and `:941`). Every
`broadcast.updated` emit derives its stats WITHOUT that re-bucketing - the
attempt transition's side effects (`app/src/services/shareAttemptOutcome.ts:206`),
the webhook's rollup (`app/src/routes/webhooks/twilio.ts:4113`), the fan-out,
finalize and the reconcile. So the next event for that share patches the list
row with the recipient back in `failed`: the pill can turn from "Not confirmed"
to "Not sent", and the list does not refetch (its kept `retry_pending` is 0,
`dashboard/src/routes/broadcasts/useBroadcastsList.ts`). A reload or the
results page reads right.

**Reach - residue cases only.** The slot learns an unresolved end at every
site that writes one (spec D2: the reconcile's close and the job's two arms),
so only a DROPPED slot write after 1b's WITHDRAW leaves the row and the slot
disagreeing, and only inside D1's 24-minute row bound (past it the slot is
authoritative and the routes read no row either). The repair (D8) moves such
a slot to `send_unconfirmed` for good.

**Why accepted.** Re-bucketing at every emit site would put the attempt-row
read into the webhook's hot path for a residue case.

**Directions (not taken).** Carry the route's unconfirmed keys in the list's
refetch trigger (refetch a finished row whose stored stats hold a failure on
any event that omits the count); or have the emitters that already read the
share include the re-bucketing for rows inside the bound.

**Related.** [share-results-promise-refresh-not-emitted](./share-results-promise-refresh-not-emitted.md)
(the results page's twin class), [unconfirmed-share-invites-resend](./unconfirmed-share-invites-resend.md)
(resolved by the branch).
