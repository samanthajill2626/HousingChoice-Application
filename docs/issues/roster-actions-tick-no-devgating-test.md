---
id: roster-actions-tick-no-devgating-test
title: POST /__dev/roster-actions/tick has no devGating regression test (its two siblings do)
type: debt
severity: low
status: open
area: app
created: 2026-08-06
refs: app/src/routes/dev.ts:350, app/test/devGating.test.ts
---

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
