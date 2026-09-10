---
id: accepted-send-lost-when-append-fails
title: A provider-accepted send whose append fails is reported as a failed send and leaves no message row
type: bug
severity: med
status: open
area: app/messaging
created: 2026-09-10
refs: app/src/services/sendMessage.ts:394, app/src/services/sendMessage.ts:398, app/src/jobs/missedCallAutoText.ts:254, app/src/repos/messagesRepo.ts
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
