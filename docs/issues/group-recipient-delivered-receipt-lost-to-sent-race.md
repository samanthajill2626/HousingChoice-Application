---
id: group-recipient-delivered-receipt-lost-to-sent-race
title: A member's delivered receipt that races its sent receipt is dropped for good - updateRecipientDeliveryStatus logs "lost a race" and returns false instead of re-reading, so the row reads Sent forever
type: bug
severity: med
status: resolved
area: app/messaging
created: 2026-09-27
resolved: 2026-09-27
refs: app/src/repos/messagesRepo.ts:3877, app/src/repos/messagesRepo.ts:3946, app/src/services/groupReceipts.ts:448, app/src/routes/webhooks/twilio.ts:3139, e2e/tests/dashboard-next/group-text-per-recipient-delivery.spec.ts:63, e2e/tests/dashboard-next/group-text-reply-all.spec.ts:45
---

**RESOLVED (2026-09-27) - a DUPLICATE, fixed at `abc793ef`
(`fix/recipient-delivery-race`, merged before `79b9479e`).** Filed in parallel
with the same diagnosis under
[group-reply-live-rollup-full-suite-flake](./group-reply-live-rollup-full-suite-flake.md),
which is the CANONICAL record (root cause, the load evidence, and the other
specs it failed). The fix differs from the suggestion below: instead of a
re-read-and-retry, the write's condition is now
`delivery_recipients.#mk.#st IN (allowed priors)` (the same guard
`updateDeliveryStatus` uses), so a `delivered` that read `queued` and finds
`sent` commits in the SAME write, and a late lower status is still refused.
That also makes the stale first read below harmless for this race: a stale
read can only show an EARLIER status, which the forward-only check admits,
and the write's condition then judges the real current one. Pinned by a
gated DynamoDB Local test (`app/test/groupSendRepo.integration.test.ts`)
that forces this exact interleave for group and relay (including a 30003
`undelivered` after `sent`) plus the reverse refusal; red on the old
condition, green on the new. Full five gates green on the branch (e2e 293
passed, zero "lost a race" lines). The refs above are re-anchored to main
after both merges; the body below keeps its original `91a66577` anchors.

**Found by.** The planner's post-build review of `feat/send-outcome-reconcile`
(2026-09-27), from its own hermetic e2e gate run (not a numbered review
finding). Anchors at HEAD `91a66577`. **Pre-existing: not introduced by that
branch**, which does not touch this function; its gate run is only where it
surfaced.

**Problem.** `updateRecipientDeliveryStatus`
(`app/src/repos/messagesRepo.ts:3873-3947`) applies a per-member delivery
receipt as a read-modify-write whose loser is DROPPED, not retried:

1. it reads the message with a plain `GetCommand` (`:3877-3879`) and takes
   the member's slot status;
2. it checks the transition against the forward-only table
   (`allowedPriorStatuses`, `:3889`; the table at `:133-142`);
3. it writes the new status with the condition that the slot still holds
   the status it READ (`ConditionExpression`
   `delivery_recipients.#mk.#st = :prev`, `:3923-3934`, the condition at `:3930`);
4. on `ConditionalCheckFailedException` it logs "recipient delivery status
   transition lost a race (regressed)" at INFO and returns `false`
   (`:3936-3942`) - whether or not the new status would still be a forward
   move from the status that beat it.

When a member's `sent` and `delivered` receipts arrive close together, the
`delivered` handler reads `queued`, the `sent` write commits in between, and
the `delivered` write's condition (`= queued`) fails. `delivered` is a
forward move from `sent` too (`delivered: ['queued', 'sent']`, `:139`), but
the function never looks again: the `delivered` receipt is lost for good. The
slot stays `sent`, and because the group caller rolls up only an APPLIED
transition (`app/src/services/groupReceipts.ts:448-466`), the group's
aggregate never reaches delivered either. Twilio does not resend a status
callback that answered 2xx, so nothing repairs it.

**User-visible.** The group message's rows read "Sent" forever for members
whose texts were delivered, and the bubble's rollup stays at "delivered 0 of
N". Delivery-based decisions or displays downstream see an undelivered
member.

**Evidence (a hermetic e2e run, 2026-09-27).** The planner's gate log
`.superpowers/planner-gates/e2e-iso1.log` (gitignored, in the worktree
`W:\tmp\send-outcome-reconcile`; lines 253-260): for message
`2026-09-27T22:50:20.498Z#IMfake43658783`, three "group recipient delivery
updated" lines with status `sent`, followed within about 1 ms of the third by
two "group recipient delivery status transition lost a race (regressed)"
lines with status `delivered`. The failing specs:
`e2e/tests/dashboard-next/group-text-per-recipient-delivery.spec.ts:63`
(the rollup stuck at "delivered 0 of 3", every row "Sent") and
`e2e/tests/dashboard-next/group-text-reply-all.spec.ts:45`.

**Why it tripped now and not before.** The race trips reliably when DynamoDB
Local is degraded: the container was at its 2 GiB heap ceiling and 51% CPU
after about 21 hours and several hundred per-file test databases, which
stretches the window between the read and the write. The build's three quiet
full runs passed; the planner's did not. On real DynamoDB the window is
narrower but real. Filer's reading, not reproduced: the read in step 1 is
eventually consistent (no `ConsistentRead`, `:3877-3879`), so on real
DynamoDB a `sent` that committed moments BEFORE the `delivered` handler
started can still be read as `queued` - the window includes replication lag,
not only the interleaving.

**Both callers share it.** The group receipt path
(`groupReceipts.ts:448`, `context: 'group'`) and the relay status webhook
(`app/src/routes/webhooks/twilio.ts:3139`, the default `relay` label) call
the same function, so relay legs can lose a `delivered` the same way. Only
the group case was observed.

**Suggested fix.** On the conditional-check failure, re-read the slot once
(strongly consistent) and re-apply when the transition is still forward from
what is there now - `allowedPriorStatuses` already answers that - dropping
the receipt only on a true regression (or when the re-read's status equals
the target). Make the first read strongly consistent as well. Add a unit test
that interleaves a `sent` and a `delivered` for one member (the `sent` write
landing between the `delivered` handler's read and its write) and asserts
the slot ends `delivered` and the rollup counts it. Keep the INFO line for
the true-regression case.

**What this is NOT.** Not a lost or duplicated SEND: every text went out
once; only its delivery-status label and the rollup are wrong. Not the
send-outcome reconcile (it does not touch receipts), and not a DynamoDB
Local artifact - Local only widens a window real DynamoDB also has.

**Related.** [relay-hub-message-delivery-status-never-terminal](./relay-hub-message-delivery-status-never-terminal.md),
[npm-test-dynamodb-local-contention](./npm-test-dynamodb-local-contention.md)
(the degraded-container condition).
