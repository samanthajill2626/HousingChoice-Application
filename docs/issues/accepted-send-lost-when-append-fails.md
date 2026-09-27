---
id: accepted-send-lost-when-append-fails
title: A provider-accepted send whose append fails is reported as a failed send and leaves no message row
type: bug
severity: med
status: open
area: app/messaging
created: 2026-09-10
updated: 2026-09-27
refs: app/src/services/sendMessage.ts:266, app/src/services/sendMessage.ts:608, app/src/services/sendMessage.ts:661, app/src/jobs/broadcastFanOut.ts:967, app/src/jobs/relayFanOut.ts:2114, app/src/jobs/sendReconcile.ts:706, app/src/jobs/missedCallAutoText.ts:254, app/src/routes/api.ts:1462, app/src/repos/messagesRepo.ts
---

**Problem.** `sendMessage` posts to the provider (step 3,
`sendMessage.ts:394`) and only then persists the row (step 4,
`sendMessage.ts:398`). The two are not atomic and nothing distinguishes them
to a caller: a persist failure throws the same way a send failure does. So a
message the recipient has already received can end up with no row in our
system, reported to staff and to the logs as a send that failed.

Everything downstream then compounds it. The status callbacks for that SID
resolve to no message row and drop their delivery outcomes at ERROR. A job
that guards against double-texting will not re-attempt, because its
idempotency marker was claimed before the send. The result is a delivered
message that the conversation has no record of and that no repair path will
ever reconcile.

**Confirmed in production, 2026-09-09.** A `call.missedAutoText` job posted
its courtesy text, Twilio accepted it and the leg reached `delivered`. The
append then died on DynamoDB `TransactionInProgressException`. The job logged
`missed-call auto-text send failed (non-refusal) - not retried (marker
claimed)` and failed, and three status callbacks for
`SMe6e6a6741eeae015f7ae17002c990ede` logged `status callback for unknown
provider SID after retry - delivery outcome dropped`. Five ERROR lines in two
seconds, which tripped `hc-prod-error-logs`. The `sid#` pointer for that SID
is absent from `hc-prod-messages`, so the transaction never landed and the
row is permanently gone.

**Already narrowed, not closed.** `5dee9fb6` makes the append retry
`TransactionInProgressException` (three attempts, short backoff, one WARN per
retry), which removes the observed trigger: the append is conditioned on
`attribute_not_exists(tsMsgId)` with a key derived from the provider result,
so re-sending it is safe. What remains is the general shape. Any persist
failure that outlives its retries still presents as a failed send, and the
transient class is only the most likely way to get there.

**Suggested fix.** Two separable pieces, and only the first is mechanical.

1. Make the failure legible. Have `sendMessage` distinguish a throw from
   after the provider accepted, carrying the provider SID, so callers and
   logs can say "sent but not recorded" instead of "send failed". Additive
   and contained; changes no send behavior.
2. Decide what a caller should then DO. Reconcile the orphan, mark it for the
   status handler, or keep suppressing retry to avoid a double text. That is
   a product call and it applies to every send path, not to the one job that
   surfaced it. `missedCallAutoText.ts:254` documents the reasoning the
   current suppression rests on, which assumed an unknown error meant the
   send had not happened.

**Related.** [`exactly-once-send-intent`](./exactly-once-send-intent.md) is
the mirror image of this: there, an ambiguous outcome DUPLICATES a message;
here it LOSES one. Both trace to the same gap, that no send path persists a
durable intent before calling the provider. That issue's sketch, a
client-generated idempotency key written before the send, would close this
one as a side effect, so the two are worth scoping together rather than
patching separately.

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

**Piece 1 is built.** `sendMessage` throws `SendAcceptedNotRecordedError`
(`app/src/services/sendMessage.ts:266-287`) when the append (`:661`) fails
after the provider accepted the message (`:608`). It carries the provider SID,
the provider timestamp and status, and the attempt's reconcile facts
(`:663-669`), and its message names the SID. Failures AFTER the row is written
(the inbox touch, the audit row) no longer fail the send at all (`:672-698`).
Anchors at HEAD for the body: the provider call is `:608` and the append
`:661`.

**Piece 2 is built for the adopting callers** - both fan-outs and the relay
retry rung. The broadcast pass logs ERROR `sent_unrecorded` and hands the
recipient to `send.reconcile` WITH the SID
(`app/src/jobs/broadcastFanOut.ts:967-974`), as it does when its own
record-phase write fails after a send (`:924-934`); the relay leg does the same
for its record phase (`app/src/jobs/relayFanOut.ts:2114-2127`), and the rung
hands it off and leaves its inbox touch to the adoption
(`app/src/jobs/relayRetryLeg.ts:905-937`). The reconcile's known-SID path
(`app/src/jobs/sendReconcile.ts:706-718`) fetches that message and adopts it
the way the owner's success path would have: for a broadcast recipient the
1:1 row is appended with the share's stamp, deduped on the SID and read back
consistently when it already exists, then the slot moves from `queued` only
(`adoptBroadcastRecipient`, `broadcastFanOut.ts:1279-1417`); for a relay owner
the `relaysid#` pointer is claimed, then the slot moves forward only
(`sendReconcile.ts:620-660`). The delivered text gets its row, its receipts
roll up, and nothing re-sends it.

**Still lost for every caller that does not adopt it.** `missedCallAutoText` -
the production trigger above - still rethrows under its claimed marker
(`app/src/jobs/missedCallAutoText.ts:254-264`); `retrySend` rethrows it too
([retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md),
Stage 1b); the other Stage 2 sites are in the sweep table of
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md);
and the staff send routes rethrow it to the error handler, which answers 500
(`app/src/routes/api.ts:1458-1462`, the manual Retry at `:1688-1693`;
`app/src/lib/errors.ts:200`), for a text that went out and has no row - a
re-click can send it again
([exactly-once-send-intent](./exactly-once-send-intent.md)).
