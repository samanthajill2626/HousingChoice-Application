---
id: relay-continuation-early-return-strands-slots
title: A relay fan-out continuation that early-returns (group closed, no pool number, source gone) leaves the recipients it carried queued forever
type: bug
severity: low
status: open
area: app/messaging-relay
created: 2026-09-25
refs: app/src/jobs/relayFanOut.ts:772, app/src/jobs/relayFanOut.ts:780, app/src/jobs/relayFanOut.ts:791, app/src/jobs/relayFanOut.ts:1186, app/src/jobs/relayFanOut.ts:1196, app/src/jobs/relayFanOut.ts:1429, dashboard/src/routes/contact/deliveryStatus.ts:202
---

**Problem.** When a relay leg hits a transient error (429 / 30022), the fan-out
writes the member's slot `queued` with the code
(`app/src/jobs/relayFanOut.ts:1429-1435`) and enqueues a backed-off continuation
that carries those members as `recipientKeys` (`:1186-1199`). The continuation
runs the same handler, which checks the world before doing anything and simply
RETURNS when:

- the group is no longer `open` (`:772-778`, "relay fan-out skipped - group not
  open", INFO);
- the conversation has no pool number (`:780-783`, WARN);
- the source message cannot be found (`:791-794`, WARN).

None of those returns closes the carried slots. They stay `queued` with the
transient code, and because they have no `sentAt` they never age to "Queued -
not confirmed" on the dashboard
(`dashboard/src/routes/contact/deliveryStatus.ts:202`). The rollup never
completes for those members, and nothing reports that a member was never sent
the message.

Returning is right - a closed group must never be fanned out to - but the
honest outcome is a terminal close with a reason, not silence. The relay 30003
retry job already does this for the same situations (`retry_group_closed`,
`retry_member_removed`), and `feat/send-outcome-reconcile`'s re-drive does it
too (D16: a failed sendability pre-check closes `redrive_refused`).

Shared with that branch: its re-drive of a `never_sent` recipient is also a
relay fan-out continuation, so a group that closes after the pre-check and
before the continuation runs strands the recipient here with its attempt record
`redriven` - one of the states [send-attempt-sweeper](./send-attempt-sweeper.md)
exists to find.

Low: the group closing mid-ladder, or the source vanishing, is uncommon, and
for a closed group nothing further should be sent anyway; what is wrong is the
record.

**Suggested fix.** Found along the way (the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9); not a send - local error handling. When a continuation (a payload with
`recipientKeys`) early-returns, close the carried recipients that are still
non-terminal with an internal code that says why (a group-closed code
analogous to `retry_group_closed` / `redrive_refused`), through the close gate
SOR D8 defines once the attempt record exists, and render it as prose (SOR D23).
The first-pass returns (no continuation) have no deferred slots to close.

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md),
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md).
