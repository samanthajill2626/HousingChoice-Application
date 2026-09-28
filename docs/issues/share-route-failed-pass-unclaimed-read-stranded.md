---
id: share-route-failed-pass-unclaimed-read-stranded
title: A share the send route marked failed while its pass still runs leaves the recipients the pass has not claimed yet unflagged in the composer for the length of the pass - a double-text window
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-28
refs: app/src/routes/broadcasts.ts:848, app/src/services/shareRecipientState.ts:71, app/src/routes/broadcasts.ts:602, app/src/jobs/broadcastFanOut.ts:876
---

**Found by.** `feat/share-sent-outcome` spec D1 and section 8 ("the double-text
window ... The same class"), accepted there; filed at the branch's fix wave 1
(plan T15) so the residual is tracked. Anchors at that fix wave.

**Problem.** The send route marks a share `failed` on ANY throw of its fan-out
enqueue (`app/src/routes/broadcasts.ts:848`), and an ambiguous enqueue (an SDK
timeout after SQS accepted) still runs the pass - see
[broadcast-route-markfailed-blocks-finalize](./broadcast-route-markfailed-blocks-finalize.md).
The composer's "Already sent" flag (`app/src/routes/broadcasts.ts:602`) reads
D1's SAFE state, which tells a `queued` slot of a share no longer `sending`
by the recipient's send-attempt record (`app/src/services/shareRecipientState.ts:71-77`):
no record reads STRANDED (never texted) and does not flag. A running pass
writes a recipient's record only when it claims that recipient
(`app/src/jobs/broadcastFanOut.ts:876`), so every recipient it has not reached
yet reads stranded: a second share of the same property in that window starts
them pre-checked, and the pass then texts them the first share too - a double
text. The window is the rest of the pass (about one text a second: a
1000-recipient share runs about 17 minutes).

**Why accepted.** Spec D1 weighed it against the alternative - without the
record rule a route send that truly failed would keep its whole audience
flagged for good - and section 8 accepts the window: the flag is a hint, not a
block, and a double text is at most HIGH on the standing scale (LOW here: it
needs an ambiguous enqueue failure and a second share inside the pass).

**Directions (not taken).** Fix the route's unconditional `markFailed` over a
pass that runs anyway (the related issue's directions), so the share reads
`sending` and D1 reads its queued slots in flight; or have the flag read a
`queued` slot of a share marked failed less than one pass-length ago as in
flight.

**Related.** [broadcast-route-markfailed-blocks-finalize](./broadcast-route-markfailed-blocks-finalize.md),
[unconfirmed-share-invites-resend](./unconfirmed-share-invites-resend.md)
(resolved by the branch), [send-attempt-sweeper](./send-attempt-sweeper.md).
