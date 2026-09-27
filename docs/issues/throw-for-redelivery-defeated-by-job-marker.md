---
id: throw-for-redelivery-defeated-by-job-marker
title: Both fan-outs throw to force an SQS redelivery that the job-execution marker then suppresses
type: bug
severity: high
status: open
area: jobs
created: 2026-09-01
updated: 2026-09-27
refs: app/src/jobs/broadcastFanOut.ts:806, app/src/jobs/relayFanOut.ts:1753, app/src/jobs/relayRetryLeg.ts:878, app/src/lib/sendOutcome.ts:69, app/src/repos/sendAttemptsRepo.ts:329, app/src/jobs/sendReconcile.ts:369, app/src/jobs/jobs.ts:188, app/src/jobs/jobs.ts:262, app/src/repos/messagesRepo.ts:3285, app/src/jobs/retrySend.ts:212, app/src/jobs/retrySend.ts:339
---

**Problem.** `broadcastFanOut` and `relayFanOut` both handle an unrecognised
per-recipient send error by deliberately throwing, so that SQS redelivers the
envelope and the work is retried. Both said so in a comment:

```
// Unknown error: leave the recipient queued and let the job FAIL so SQS
// redelivers the whole envelope (a fresh jobId via the visibility
// timeout; the marker is per-jobId).
throw err;
```

**The parenthetical was false.** A redelivery carries the SAME `jobId`:

- `buildEnvelope` mints `jobId: randomUUID()` ONCE, at enqueue time
  (`jobs.ts:188`), and the envelope travels inside the SQS message body.
- `dispatchJob` uses a complete envelope VERBATIM (`jobs.ts:262`). The fresh
  `randomUUID()` a few lines below is only for the synthesized,
  envelope-less path. The function's own docblock says it re-hydrates "the new
  jobRunId + **the stable jobId**" (`jobs.ts:286`).
- `putJobExecutionMarker` is a conditional PUT with **no TTL**
  (`messagesRepo.ts:2653-2672`), so its suppression never expires.

So the redelivered envelope reaches the handler, `putJobExecutionMarker` returns
`false`, and the handler **returns immediately having done nothing**. The
deliberate throw does not retry the work.

`retrySend.ts:122-128` documents the correct semantics for the same marker and
does not rely on redelivery. The two fan-outs are the outliers.

**It does not even reach the DLQ.** The suppressed redelivery RETURNS
SUCCESSFULLY - that is the marker's whole design, so the consumer deletes the
message instead of DLQ-cycling it. There is exactly one redelivery (receive 2),
it no-ops, and the message is gone. `maxReceiveCount` is never approached, so
**no DLQ alarm fires and nothing pages anybody.** The failure is completely
silent.

**Why it matters, and it is worse than one recipient.** The `throw` exits the
`for` loop over recipients. Every recipient AFTER the failing one is never
attempted at all - one unrecognised error on recipient 3 of 800 strands 798,
with their slots left `queued` and the broadcast row left `sending`. Nothing
repairs any of it, and nothing reports it.

**Both fan-outs, not just broadcasts.** `relayFanOut.ts:1002` has the
identical shape and comment. Its symptom differs only in surface: the relay
source message's `delivery_recipients` slots stay `queued` for every member from
the failing one onward, so the thread shows a message that was silently
delivered to a prefix of the group. There is no `finalize()` on that path to
mis-report, which makes it quieter still.

This is the same "stuck forever" class as
[retry-counter-in-envelope-makes-caps-unreachable](./retry-counter-in-envelope-makes-caps-unreachable.md),
reached by a different door: there the counter could not advance, here the retry
cannot happen at all. The dashboard symptom is identical to the 2026-08-16 prod
voicemail stuck on "Transcribing..." - except silent, and at broadcast scale.

Discovered during M5's design review (`feat/retry-counter-durable`), while
verifying whether a post-throw redelivery could advance a durable pass counter.
It cannot. M5's fix therefore closes the ENQUEUE-failure path by running the
cap-and-close branch immediately, and does not touch this path.

**Comment corrected, BEHAVIOR UNCHANGED (2026-09-01, commit `8cebbebf`).** The
two false comments quoted above no longer exist in the tree: both were replaced
with an accurate one carrying a `TODO(throw-for-redelivery-defeated-by-job-marker)`
marker. The quoted block is kept here as the historical text this issue was
filed against. Both files also moved under M5's edits, so the CURRENT anchors
are `broadcastFanOut.ts:545` and `relayFanOut.ts:1002` - re-derive by reading
rather than trusting either number. Nothing about the argument below changes:
the throws are still there and still retry nothing.

**Suggested fix.** Decide what an unrecognised per-recipient send error should
DO, then make the code do it:

- if it is retryable, the retry must be a NEW enqueue (fresh `jobId`), not a
  throw - a throw cannot retry under the marker;
- if it is not retryable, mark the recipient failed, **continue the loop so the
  remaining recipients are still attempted**, and let the job complete so the
  row reaches a terminal state;
- the two false comments are already corrected (see above); the remaining work
  is the behavior.

Note the interaction with the marker's purpose: it exists so a redelivery cannot
TEXT SOMEONE TWICE. Any fix must keep that guarantee.

The per-recipient terminal-status skip is the obvious candidate to carry it
instead - but **confirm the window before relying on it**. The skip reads the
slot's status, and the slot is written AFTER the provider send returns. A
process that dies between the send and the slot write leaves a recipient marked
`queued` who has already been texted; a re-run that trusts only the skip would
text them again. The marker closes that window today precisely because it is
claimed before any send.

Whatever replaces the throw has to preserve that ordering guarantee, not just
the skip.

**Also worth checking.** Any other handler that throws expecting a redelivery to
re-run its work has the same defect. This sweep has not been done.

## Update 2026-09-25

**Correction: `retrySend` has the same shape.** The claim above that
`retrySend.ts:122-128` "does not rely on redelivery" is wrong. That comment
describes the marker's duplicate suppression correctly, but the handler claims
the marker (`app/src/jobs/retrySend.ts:131`) BEFORE the attachment presign
(`:164-166`) and the send (`:200-207`), and then rethrows every error that is
not a refusal (`:218`). The redelivery carries the same `jobId`, the marker
suppresses it, and the automatic 30003 retry is lost exactly as the fan-outs'
recipients are. Filed as
[retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md).

**Current anchors.** The broadcast throw is now `broadcastFanOut.ts:564`
(`TODO` at `:553`). The relay throw moved into the extracted per-leg unit
`sendOneRelayLeg` (`relayFanOut.ts:1447`), so the relay 30003 retry rung
inherits it: `relay.retryLeg` claims its own marker
(`relayRetryLeg.ts:352`) and calls that unit with no catch (`:575`).

**The fix is designed and being built.** The
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md)
replaces the throw with a three-way classification of every provider send
failure (`rejected` / `retryable` / `unknown`), typed errors from `sendMessage`,
a per-recipient send-attempt record claimed before every provider call (so the
redelivery guarantee this issue warns about is kept without the marker doing
the work), and a `send.reconcile` job that looks an ambiguous send up at Twilio
and adopts it or re-drives it once. It is being built on
`feat/send-outcome-reconcile` for BOTH fan-outs and the relay retry rung. The
one-to-one retry job (`retrySend`) is adopted afterwards, once
`feat/retry-send-window` has merged (design Sec 2a), because that branch
rewrites the same job. This issue closes when `feat/send-outcome-reconcile`
merges; its status is unchanged until then.

**The sweep is done.** The 2026-09-24 sweep of `app/src` found the same
claim-then-throw shape at nine more sites beyond this branch's own; findings
with file:line citations are in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
Each is filed as its own issue (design Sec 9); none is edited on this branch:

| # | site | issue | group |
|---|---|---|---|
| F1 | `relay.numberReady` post-flip enqueues | [relay-number-ready-post-flip-enqueue-loss](./relay-number-ready-post-flip-enqueue-loss.md) | not a send |
| F2 | `relay.intro` | [relay-intro-lost-under-job-marker](./relay-intro-lost-under-job-marker.md) | send-shaped + pre-send reads |
| F3 | `relay.memberAdded` | [relay-member-added-lost-under-job-marker](./relay-member-added-lost-under-job-marker.md) | send-shaped + pre-send reads |
| F4 | `messaging.retrySend` | [retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md) | Stage 1b of the same mission, its own worktree after Stage 1 lands |
| F5 | `call.missedAutoText` | [missed-call-autotext-pre-send-failure-not-retried](./missed-call-autotext-pre-send-failure-not-retried.md) | send-shaped |
| F6 | tour reminder poll (1:1, group, Send now) | [tour-reminder-lost-on-post-claim-send-error](./tour-reminder-lost-on-post-claim-send-error.md) | send-shaped |
| F7 | placement nudge poll | [placement-nudge-lost-on-post-claim-send-error](./placement-nudge-lost-on-post-claim-send-error.md) | send-shaped |
| F8 | pending roster-action poll | [roster-action-lost-on-post-claim-error](./roster-action-lost-on-post-claim-error.md) | not a send |
| F9 | voice recording callback after the mirror | [voicemail-upgrade-and-transcript-lost-after-mirror](./voicemail-upgrade-and-transcript-lost-after-mirror.md) | not a send |

The residue this branch records rather than closes is filed too:
[fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md)
(this issue's shape in the per-PASS setup, before any recipient) and
[send-attempt-sweeper](./send-attempt-sweeper.md) (the crash windows).

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

**Built on the branch, for both fan-outs and the relay retry rung.** The
deliberate throws are gone. Each recipient is one unit with PREPARE / SEND /
RECORD phases inside one try/catch that tracks the phase and never throws out
of the loop: the broadcast unit `runRecipient`
(`app/src/jobs/broadcastFanOut.ts:806-998`) and the relay leg unit
`sendOneRelayLeg` (`app/src/jobs/relayFanOut.ts:1753-2239`), which the relay
retry rung also calls; the rung handles every leg outcome in an exhaustive
switch (`app/src/jobs/relayRetryLeg.ts:878-1121`). A provider failure is
classified by `classifySendFailure` (`app/src/lib/sendOutcome.ts:69`):
`rejected` fails the recipient with the provider code and the loop continues;
`retryable` defers it to the backed-off continuation - a NEW enqueue, never a
throw; `unknown` hands it to the new `send.reconcile` job
(`app/src/jobs/sendReconcile.ts`), which looks the message up at Twilio and
adopts it, re-drives it once, or closes it `send_unconfirmed`. Three
consecutive unknowns brake the pass and defer the untried remainder
(`broadcastFanOut.ts:1005-1035`, `relayFanOut.ts:1331-1440`).

**The ordering guarantee this issue warns about is kept without the marker
doing the work.** Every send site claims the recipient on its send-attempt
record before the provider call (`app/src/repos/sendAttemptsRepo.ts:329-352`;
claimed at `broadcastFanOut.ts:833-843` and `relayFanOut.ts:1942-1952`). A
record holding a SID refuses every later claim, so a re-run - a redelivery, a
continuation or a re-drive - never texts anyone twice, and a claim older than
the 30 s provider timeout is taken over into reconcile, never re-sent. The job
markers stay (`broadcastFanOut.ts:381-393`, `relayFanOut.ts:828-840`,
`relayRetryLeg.ts:482-491`); `send.reconcile` has none and retries genuinely
(`sendReconcile.ts:10-17`).

**The TODO markers are gone** (plan Task 15, build finding T15-5).
`grep -rn "throw-for-redelivery-defeated-by-job-marker" app/src` at the
branch's HEAD (`b7b3f24b`) returns no match (exit status 1): the
`TODO(throw-for-redelivery-defeated-by-job-marker)` marker and the docblock
mention that remained in `broadcastFanOut.ts` went with the throw, and
`relayFanOut.ts` and `relayRetryLeg.ts` carried none.

**Still open elsewhere, each filed:** the per-PASS throws outside the units
([fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md)),
the crash windows and strands ([send-attempt-sweeper](./send-attempt-sweeper.md)),
`retrySend` ([retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md),
this mission's Stage 1b), and the nine sweep sites in the table above.

**Status stays `open`:** the human sets it `resolved` when
`feat/send-outcome-reconcile` merges. The refs above are re-anchored at HEAD on
the fix (the units, the classifier, the record's claim, the reconcile), the
marker (`jobs.ts:188`, `:262`; `app/src/repos/messagesRepo.ts:3285`) and
`retrySend` (`app/src/jobs/retrySend.ts:212`, `:339`).

## Addendum 2026-09-27 - code review rounds 1-4

The sentence above that a re-run "never texts anyone twice" holds for every
path the build and its four code review rounds tested, with narrow
exceptions the review found and the human accepted under his standing ruling
on the branch - a double text is annoying, not critical
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/r1-adjudications.md`,
section 6). Each is filed:

- a stall of about 90 s or more inside the pre-send re-arm with a concurrent
  taker, or a provider request that trickles past the reconcile window
  ([send-attempt-rearm-residues](./send-attempt-rearm-residues.md), items 1
  and 2);
- a message held in Twilio's queue past the last check, if unsent messages
  turn out not to be listed
  ([send-reconcile-hosted-dev-checks](./send-reconcile-hosted-dev-checks.md),
  item 1 - owed at the first hosted-dev run);
- a filer's reading of a phone-keyed recipient's contact read after a crash
  ([send-reconcile-job-residues](./send-reconcile-job-residues.md), item 10).

The stale-claim takeover is now measured from the attempt's last RE-ARM,
taken immediately before the provider call (code review ADV-1; FW1-1 and
FW2-1), not from the claim. Nothing here changes this issue's status.
