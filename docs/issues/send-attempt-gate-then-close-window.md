---
id: send-attempt-gate-then-close-window
title: A close by another writer reads the send-attempt gate and then writes the slot as two separate calls, so a claim that lands in between can have its send recorded under the close
type: bug
severity: low
status: open
area: app/messaging
created: 2026-09-27
refs: app/src/lib/sendAttemptGate.ts:30, app/src/jobs/broadcastFanOut.ts:419, app/src/jobs/broadcastFanOut.ts:636, app/src/jobs/relayFanOut.ts:1259, app/src/jobs/relayFanOut.ts:1854, app/src/jobs/relayRetryLeg.ts:552, app/src/jobs/relayRetryLeg.ts:574, app/src/jobs/relayRetryLeg.ts:672, app/src/repos/sendAttemptsRepo.ts:422
---

**Problem.** `feat/send-outcome-reconcile` (SOR) makes every close written by
a writer OTHER than the recipient's own attempt pass the D8 gate first
(`gateFor`, `app/src/lib/sendAttemptGate.ts:30-39`): an absent attempt record
or a `done`/`retryable` one PROCEEDS (`:32-33`), and the close then writes the
slot. The gate's read and the close's slot write are two separate DynamoDB
calls; nothing ties the slot write to the record state the gate read. A pass
that CLAIMS the recipient in between - an absent record, or a
`done`/`retryable` one, becomes `attempting` (`claim`,
`app/src/repos/sendAttemptsRepo.ts:422-446`) - and then sends can have its
send recorded under the close.

The writers that close this way:

- the broadcast fences (`declineAtFence`,
  `app/src/jobs/broadcastFanOut.ts:636-670`): a blind `setRecipient` through
  `recordRecipient` (`:660`, `:1488-1495`) plus `bumpStats` (`:664`);
- the cap-closes: `closeBroadcast` (`broadcastFanOut.ts:419-479`, its slot
  write `closeRecipientIfQueued` at `:452`) and `closeRelay`
  (`app/src/jobs/relayFanOut.ts:1259-1312`, `closeRelayRecipientIfUnsent` at
  `:1290-1293`);
- the relay opt-out suppression arm (`relayFanOut.ts:1854-1915`, its
  `persistRelayRecipientResult` at `:1885-1888`);
- the relay retry rung's `refuseGate` and `closeTerminally`
  (`app/src/jobs/relayRetryLeg.ts:552-583`), reached through
  `closeUnlessOwned` (`:672-722`).

**What goes wrong.** The claimant's own success-path slot write is
conditional on the slot still being open (broadcast `recordRecipientOutcome`
from `['queued']`, `broadcastFanOut.ts:941-947`; relay
`persistRelayRecipientResult`, forward-only on a versioned row,
`relayFanOut.ts:2039-2051`). So a conditional close that lands after the claim
but before the claimant's slot write moves the slot to the close's code, the
claimant's slot write then does not apply, and the claimant's record still
closes `done`/`sent`. A blind writer (the fences; the suppression arm and the
rung's closes on a legacy relay row, whose slot writer is wholesale) can also
overwrite a slot the claimant already wrote. Either way the slot can end
carrying the close's code - `failed`/`transient_cap`, `skipped` with an
opt-out code, and so on - over a text that went out.

**User-visible.** A mislabeled row: the share recipient or relay leg reads
failed or skipped (on a broadcast, `transient_cap` shows the retry hint) while
the text was delivered. Never a second send: the record's claim still admits
only one attempt.

**Trigger.** Two passes on one key inside one DynamoDB round trip - a close
in one pass (a fence, a cap-close, a suppression, a rung refusal) and a claim
in another (an overlapping continuation, re-drive or duplicate pass). Rare.

**Already closed on the branch: the redriven case** (code review round 1
C-4 / R-a, fix FW2-4, commit `c44216cd`). When the gate read a `redriven`
record, every such close now runs `closeRedriven` FIRST - a conditional
record write - and writes its slot only when that won, so a pass that
re-claimed the record in between keeps it and the close writes nothing
(`broadcastFanOut.ts:442-451` and `:656-659`; `relayFanOut.ts:1280-1289` and
`:1875-1881`; `relayRetryLeg.ts:680-699`). That was the case a real re-drive
can produce; what remains is the absent and `done`/`retryable` cases.

**Suggested fix.** The recorded direction (round 1 adjudication): give each
such close's slot write a transactional condition on the attempt record - for
example one TransactWrite holding the slot write and a ConditionCheck that the
record is still in the state the gate read (absent, or `done`/`retryable`
with its `attemptNo`) - so a claim in between cancels the close. A lighter
variant is FW2-4's record-first order generalized (close the record `done`
conditionally first, then the slot), which inherits the double fault filed in
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md)
(Addendum 2026-09-27, a won record close whose slot write then throws).

**Why it was not fixed on the branch.** Ruled RESIDUE in code review round 1
(`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/code-review/r1-adjudications.md`,
sections 1 and 4; the finding is `r1-conformance.md` C-4, held item R-b): a
transactional condition with every other writer's slot write is a design
change larger than the branch, its damage is a mislabeled slot and never a
second send, and it needs two passes on one key inside one DynamoDB round
trip. It also falls under the human's standing ruling on the branch (no new
machinery for a rare double-fault or race path).

**Related.** [fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[send-attempt-sweeper](./send-attempt-sweeper.md),
[send-attempt-rearm-residues](./send-attempt-rearm-residues.md).
