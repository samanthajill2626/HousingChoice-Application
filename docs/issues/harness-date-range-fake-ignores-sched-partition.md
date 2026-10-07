---
id: harness-date-range-fake-ignores-sched-partition
title: The harness fake of listByScheduledRange admits tours without _schedPartition, while the All-tab fake of the same index requires it
type: debt
severity: low
status: open
area: app/test-harness
created: 2026-10-06
refs: app/test/helpers/twilioWebhookHarness.ts:3521, app/test/helpers/tourListIndexFake.ts:91, app/src/repos/toursRepo.ts:376, docs/superpowers/reviews/2026-10-06-tour-list/design-review/adjudications.md:27, docs/superpowers/reviews/2026-10-06-tour-list/code-review/r1-adversarial.md
---

**Problem.** Two in-memory fakes model the same sparse `byScheduledAt` GSI
(hash `_schedPartition`, range `scheduledAt`) and disagree about membership:

- the harness's `listByScheduledRange`
  (`app/test/helpers/twilioWebhookHarness.ts:3521`) admits any tour whose
  `scheduledAt` string falls in the window;
- the All tab's shared phase model (`app/test/helpers/tourListIndexFake.ts:91`,
  pinned to DynamoDB Local by `tourListIndexFakeMirror.integration.test.ts`)
  admits a dated tour only when it also carries `_schedPartition: 'tours'` -
  as DynamoDB does: a row is in the index only with BOTH attributes.

So in the harness world a dated row without the partition would show on Today
and on the Active and Past tabs (`GET /api/tours?from&to`) but not on the All
tab; on DynamoDB it shows on none of them. Route tests on those two endpoints
could not catch a writer that forgets the partition.

Inert today: every writer stamps it. The repo's create stamps every tour
(`app/src/repos/toursRepo.ts:376`) and has since its first commit, the
harness's own create stamps it too, tours are never imported, and the seeds -
the only gap - were fixed and pinned by feat/tour-list
(`app/test/seedTourPartition.test.ts`, `app/test/seedLive.test.ts`).
Pre-existing; feat/tour-list did not change the harness fake.

Not the fix: making PATCH stamp `_schedPartition` when it writes a date. The
design review of feat/tour-list rejected that (R1-2,
`docs/superpowers/reviews/2026-10-06-tour-list/design-review/adjudications.md:27`):
production rows are all written by the repo's create, tours are never
imported, and the seeds were the only gap - a writer change for a state
production cannot reach. The reviewer who raised it conceded. The plan-blind
code review (r1 AD-3) re-derived the same proposal; its adjudication rejected
it again on the same evidence and filed only this fake divergence.

**Suggested fix.** Make the harness `listByScheduledRange` require
`_schedPartition === 'tours'` like the All-tab fake (ideally one membership
predicate shared by both fakes), then run the harness-backed suites
(`toursApi`, `todayApi` and any other route test that reads a date range) to
find fixtures that write raw dated tours without the partition - and fix
those fixtures, not the fake.
