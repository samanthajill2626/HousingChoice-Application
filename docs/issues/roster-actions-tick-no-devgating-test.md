---
id: roster-actions-tick-no-devgating-test
title: POST /__dev/roster-actions/tick has no devGating regression test (its two siblings do)
type: debt
severity: low
status: resolved
area: app
created: 2026-08-06
resolved: 2026-08-24
refs: app/src/routes/dev.ts:350, app/test/devGating.test.ts
---

**Resolution (2026-08-24, `fix/test-suite-wave3`).** The sibling block cloned,
with one improvement over the clone: the 200 is proven non-vacuous by OUTCOME.
A due `open_group` deferral on a CANCELED tour must flip pending -> skipped
with `resolvedAt` equal to the tick's NORMALIZED now - so one fixture witnesses
the gate, the ms-less-now normalization reaching the poll, and that the skip
path stays network-free (the poolNumbers stub throws on any use). Malformed
`now` leaves the due row untouched, proving the 400 returns before the poll;
the absent-router 404 matches the siblings.

Probed: stubbing the route's runDuePendingRosterActions call fails the block
with `expected 'pending' to be 'skipped'`. Restored, 43/43.


**Problem.** The roster-actions dev tick (dev.ts:350) rides `createDevRouter`
behind the triple gate like its two siblings, but unlike
`/__dev/tour-reminders/tick` and `/__dev/placement-nudges/tick` it has NO
block in devGating.test.ts - the suite that pins gating, `now` validation,
and the absent-router 404 for each dev seam. This is a coverage gap, not an
exposure (the route is unreachable in deployed envs today); the gap means a
future refactor of the dev router could silently un-gate this one seam
without a red test. Found by the contact-rosters planner review (C9/N3),
adjudicated FILE.

**Suggested fix.** Clone the sibling block in devGating.test.ts for
`/__dev/roster-actions/tick`: gated-off 404, gated-on 200, bad `now` 400,
absent-router 404.
