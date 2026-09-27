---
id: relay-continuation-early-return-strands-slots
title: A relay fan-out continuation that early-returns (group closed, no pool number, source gone) leaves the recipients it carried queued forever
type: bug
severity: low
status: open
area: app/messaging-relay
created: 2026-09-25
updated: 2026-09-27
refs: app/src/jobs/relayFanOut.ts:843, app/src/jobs/relayFanOut.ts:854, app/src/jobs/relayFanOut.ts:862, app/src/jobs/relayFanOut.ts:879, app/src/jobs/relayFanOut.ts:1490, app/src/jobs/relayFanOut.ts:1683, app/src/jobs/relayFanOut.ts:2194, dashboard/src/routes/contact/deliveryStatus.ts:251, dashboard/src/routes/contact/deliveryStatus.ts:298
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
(`dashboard/src/routes/contact/deliveryStatus.ts:202` when filed; narrowed in
the 2026-09-27 section below). The rollup never
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

## 2026-09-27 - feat/send-outcome-reconcile (SOR Stage 1)

**A RE-DRIVE continuation now closes what it carries (plan Task 8, build
finding T8-9).** When a pass marked `redrive: true` returns before its loop -
the conversation gone (`app/src/jobs/relayFanOut.ts:843-847`), the group not
open (`:854-861`), no pool number (`:862-867`), the source not found
(`:879-883`), nothing to relay (`:1119-1124`), or the source vanished at the
post-loop pass claim (`:1466-1473`) - it runs `closeRedriveRefused`
(`:1683-1722`, through `refuseRedrive` at `:821-822`) for each member it
carries: the attempt record FIRST (`closeRedriven` to `done`/`redrive_refused`,
fenced on `redriven`, so a record another pass has claimed since is left
alone), then the slot `failed`/`redrive_refused` only when that close won
(`:1700-1710`). The dashboard reads the code as prose ("Wasn't resent: the
group closed or the member left",
`dashboard/src/routes/contact/deliveryStatus.ts:1048`).

**The ORDINARY transient continuation still strands, as filed.**
`closeRedriveRefused` is a no-op without `redrive: true` (`:1691`), so the
same early returns on an ordinary continuation still leave its carried slots
non-terminal. That includes a member whose attempt record is `redriven`: a
transient continuation strips the re-drive marker (spec D8, revision 11), so an
ordinary continuation can carry a re-driven member - for example when the
re-drive pass deferred it before its claim and its post-loop pass claim
enqueued an ordinary continuation - and an early return there leaves the
record `redriven` (build S2b residue 4; the backstop is
[send-attempt-sweeper](./send-attempt-sweeper.md)).

**Narrowed: whether a carried slot ages (build finding T15-2).** The claim now
stamps OUR attempt clock `attemptedAt` on the member's slot before the
provider call (`relayFanOut.ts:1979-1991`, best-effort), and a `queued` leg
with no `sentAt` ages from it into "Queued - not confirmed" after the
15-minute budget (`deliveryStatus.ts:298-301`; the table at `:251-252`, the
reasoning at `:274-282`). So a carried member that was CLAIMED on a VERSIONED
source keeps the clock through the child-field writes
(`applyRecipientSendResult`, reached through `persistRelayRecipientResult`,
`relayFanOut.ts:2375-2395`) and now does age. On a LEGACY source the
deferral's whole-slot write (`markRecipient` to `setRecipientDelivery`,
`:2398-2410`) erases the clock, so that slot still never ages, and a member no
pass has claimed yet has no clock at all. Presentation only either way:
nothing reaches a verdict.

Anchors at HEAD for the body: the transient slot write is the leg's retryable
arm (`relayFanOut.ts:2194-2209`) and the continuation enqueue is at
`:1490-1506`.
