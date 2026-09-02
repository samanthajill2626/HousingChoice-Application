---
id: conversion-claim-stuck-no-unclaim-path
title: A crashed tour-to-placement conversion claim is a permanent dead end, and Send now's copy promises it will finish
type: bug
severity: med
status: open
area: app
created: 2026-09-02
refs: app/src/routes/placements.ts:665, app/src/routes/tourReminders.ts, app/src/jobs/tourReminders.ts
---

**Problem.** The conversion claim sentinel (`convertedPlacementId =
'pending:<uuid>'`) has no recovery route when the converting process dies
between `claimConversion` and the finalize. A from-tour retry 409s on the stuck
sentinel itself (`placements.ts:665-671` treats any `pending:` value as "a
concurrent convert is in flight"), no operator unclaim exists, and after the
supersession grace window the poll retires the tour's due rungs
`conversion_stalled` - correctly visible, but terminal. Meanwhile the Send-now
409 copy for `conversion_in_progress` reads "try again once that finishes",
which for a crashed claim is a promise that can never be kept.

Found by the planner's plan-blind adversarial review of
`feat/tour-reminder-supersession` (finding 1). The claim mechanism predates
that branch; the grace-window retire and the copy are new with it.

**Suggested fix.** Two halves. (1) An operator-visible unclaim: either a
bounded claim age after which a fresh convert may steal the sentinel
(compare-and-swap on the exact stale value, mirroring the claim's own CCFE
discipline), or an explicit admin action. (2) Honest copy: the
`conversion_in_progress` string should not promise completion; hedge it or
branch it on claim age. The copy half is small but goes through the message
catalog and the send-now copy census (two unions, non-exhaustive maps - see
the supersession spec 3.3).
