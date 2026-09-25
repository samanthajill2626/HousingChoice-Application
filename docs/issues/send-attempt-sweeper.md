---
id: send-attempt-sweeper
title: No sweeper closes a send attempt stranded by a crash or a failed write - the Stage 2 backstop the send-outcome design records as residue
type: improvement
severity: med
status: open
area: app/messaging
created: 2026-09-25
refs: docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md, app/src/repos/messagesRepo.ts:714, app/src/services/groupSendStaleness.ts:1, app/src/jobs/groupGuardrails.ts:7, app/src/routes/webhooks/twilio.ts:2742, app/src/routes/webhooks/twilio.ts:2803, dashboard/src/routes/contact/deliveryStatus.ts:221
---

**Problem.** `feat/send-outcome-reconcile` (SOR) gives every adopted send site a
per-recipient send-attempt record (D8a) with a `state`
(`attempting` | `reconciling` | `redriven` | `done`) and an attempt clock
(`attemptedAt`). It closes the ordinary failure paths in-line, but it records,
and does not close, the windows in which that record is left open with nothing
coming back for it (design Sec 1 guarantee 2, D7a, D14):

- **`attempting` past its TTL with no send site revisiting it.** A process died
  between the claim and the send, or between the send and its record write, and
  no later pass or continuation for that recipient will run. D8a's takeover
  only fires when a send site meets the stale record; nothing meets it.
- **`reconciling` with no chain.** The record moved to `reconciling` and the
  process died before the `send.reconcile` enqueue (an enqueue that THROWS is
  handled - D7 - but a crash is not).
- **`redriven` that no continuation lists.** A `never_sent` verdict moved the
  record to `redriven` and the re-drive enqueue was lost to a crash, or the
  continuation early-returned before claiming (see
  [relay-continuation-early-return-strands-slots](./relay-continuation-early-return-strands-slots.md)).
- **A failure-arm write that itself fails** (D7a): the D5/D6/D7 slot or record
  write after a classified outcome throws; the record keeps `attempting` and
  the slot keeps whatever it held. This is the "throwing close" class of
  [fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md)
  one step earlier.

Each leaves a slot non-terminal (`queued`) and, for a broadcast, the row
`sending`. SOR's dashboard rule D20a makes such a relay leg read "Queued - not
confirmed" after 15 minutes when the slot still carries `attemptedAt`, which is
honest but is presentation only: nothing reaches a verdict.

The same class already exists without the record:
[relay-retry-stranded-claim-window](./relay-retry-stranded-claim-window.md) (a
crash between the relay 30003 retry claim at
`app/src/routes/webhooks/twilio.ts:2742` and its enqueue at `:2803`) says the
fix is "a due sweeper" and puts it out of scope.

And one piece of the sweeper is assumed by the dashboard today: its relay
staleness comment (`dashboard/src/routes/contact/deliveryStatus.ts:221-223`)
says "the server's own staleness alarm covers" a relay leg whose dispatch never
happened. No such alarm exists - see
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md).

**Suggested fix.** Group: the sweeper (see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9, and D14: "the attempt record gives it a clock and a state to read").
Build after SOR Stage 1 lands. A periodic job that finds attempt records open
past a bound and hands each to the machinery that already exists: a stale
`attempting` or an orphaned `reconciling` goes to `send.reconcile` (the takeover
D8a already defines), an orphaned `redriven` gets its re-drive enqueued again
(the claim makes a duplicate safe). Precedents for the finding half: the due
row written in the same transaction as the append
(`app/src/repos/messagesRepo.ts:714`) and the native group-text staleness sweep
(`app/src/services/groupSendStaleness.ts`, run from
`app/src/jobs/groupGuardrails.ts`). The relay staleness alarm the dashboard
assumes belongs in the same job. It must not read coordination state through a
GSI (SOR D11: strongly consistent base-table reads only), so how it FINDS open
records - a due row per attempt, or a bounded index used only to nominate
candidates that are then re-read consistently - is its main design question.

**Related.**
[relay-retry-stranded-claim-window](./relay-retry-stranded-claim-window.md),
[fanout-close-path-robustness-residues](./fanout-close-path-robustness-residues.md),
[fanout-pass-setup-throw-strands-pass](./fanout-pass-setup-throw-strands-pass.md),
[relay-continuation-early-return-strands-slots](./relay-continuation-early-return-strands-slots.md),
[relay-staleness-alarm-assumed-not-built](./relay-staleness-alarm-assumed-not-built.md),
[throw-for-redelivery-defeated-by-job-marker](./throw-for-redelivery-defeated-by-job-marker.md).
