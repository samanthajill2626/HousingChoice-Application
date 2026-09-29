---
id: tour-reminder-lost-on-post-claim-send-error
title: A tour reminder rung is lost, and the panel reads "Sent", when the send errors after claimSend has stamped sentAt (1:1, group and Send now)
type: bug
severity: med
status: open
area: app/tours
created: 2026-09-25
refs: app/src/jobs/tourReminders.ts:841, app/src/jobs/tourReminders.ts:1421, app/src/jobs/tourReminders.ts:1436, app/src/jobs/tourReminders.ts:1475, app/src/jobs/tourReminders.ts:1601, app/src/jobs/tourReminders.ts:1612, app/src/jobs/tourReminders.ts:1646, app/src/jobs/tourReminders.ts:1968, app/src/jobs/tourReminders.ts:1980, app/src/jobs/tourReminders.ts:2031, app/src/routes/tourReminders.ts:193, app/src/services/relayAnnouncements.ts:181, app/src/services/relayAnnouncements.ts:229
---

**Problem.** The tour reminder poll claims each due rung with `claimSend`, which
IS the `sentAt` stamp, before sending - so two overlapping ticks cannot both
send. For the poll the next tick plays the role a redelivery plays for a job,
and the claim suppresses it the same way. Three paths then send after the
claim, and each loses the rung on a non-refusal error:

- **1:1 route.** Claim at `app/src/jobs/tourReminders.ts:1421`, send at `:1436`,
  every non-refusal error rethrown at `:1475` into the poll's per-row catch
  (`:841-850`), which logs and moves on. The claim stays. Documented as an
  accepted tradeoff (`:1433-1434`, `:1468-1470`).
- **Group route.** Claim at `:1601`, then `announceGroupReminder` (`:1612`,
  `:1646`) calls `sendRelayAnnouncement`, whose conversation read
  (`app/src/services/relayAnnouncements.ts:181`) and append (`:229`) are
  unguarded and run before any member is texted. A throw there reaches the
  per-row catch with nothing sent to anyone. This loss is NOT documented. (A
  group that became unusable between resolution and send also returns
  `undefined` from the service after the claim, so the rung is stamped with
  zero legs sent.)
- **Send now** (the operator force-send). Claim at `:1968`; the group branch
  (`:1980`) has the same unguarded pre-send reads, and the 1:1 branch rethrows
  at `:2031`, which the operator sees as a 500.

The errors that reach these arms include failures before the provider call
(`sendMessage`'s reads, the announcement's reads and append) where nothing was
sent, ambiguous provider outcomes, and post-send write failures where the text
did go out. Today all three are one bucket.

What staff see: the Reminders panel derives the rung's state from `sentAt`
alone (`app/src/routes/tourReminders.ts:193`), so a rung that texted nobody
reads "Sent - <time>" and quotes the body. That display half is the same
overstatement
[reminder-state-sent-overstates-delivery](./reminder-state-sent-overstates-delivery.md)
records for REFUSALS; this issue is the thrown-error path, whose loss (not just
its label) needs the fix below.

**Suggested fix.** Group: send-shaped - adopt the send-outcome core + the
send-attempt record from `feat/send-outcome-reconcile` (merged at `79b9479e`; see the
[send-outcome-reconcile design](../superpowers/specs/2026-09-24-send-outcome-reconcile-design.md),
Sec 9). With D3's typed errors the 1:1 route can tell "nothing was sent" (the
rung can be released for the next tick or recorded as not sent) from `unknown`
(reconcile) and from sent-but-unrecorded. The group route gets the same once
`sendRelayAnnouncement` adopts the core (see
[relay-intro-lost-under-job-marker](./relay-intro-lost-under-job-marker.md));
its pre-send reads need local handling first, since they run after the claim.
Whatever the fix, `stateOf` must stop reading `sentAt` alone as "Sent".

**Related.**
[reminder-state-sent-overstates-delivery](./reminder-state-sent-overstates-delivery.md),
[placement-nudge-lost-on-post-claim-send-error](./placement-nudge-lost-on-post-claim-send-error.md)
(identical shape in the nudge poll),
[relay-intro-lost-under-job-marker](./relay-intro-lost-under-job-marker.md).
Sweep finding F6 in
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/research/marker-sweep-findings.md`.
