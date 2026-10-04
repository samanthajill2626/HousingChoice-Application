---
id: tours-scheduled-range-query-unpaginated
title: toursRepo.listByScheduledRange reads one Query page (no LastEvaluatedKey follow) and drops the NEWEST tours first
type: debt
severity: low
status: open
area: app/tours
created: 2026-09-26
refs: app/src/repos/toursRepo.ts:347, app/src/repos/toursRepo.ts:366, app/src/routes/today.ts:550, app/src/routes/tours.ts:413, dashboard/src/routes/tours/useTours.ts
---

**Problem.** `listByScheduledRange(from, to)` (`app/src/repos/toursRepo.ts:347-364`)
issues a single `Query` on the `byScheduledAt` GSI and returns `Items` without
following `LastEvaluatedKey`. DynamoDB caps a Query page at 1 MB, so a window
whose tours exceed that returns a silently truncated list. The Query is
ASCENDING on `scheduledAt`, so the rows dropped are the NEWEST in the window.
`listByStatus` directly below it (lines 366-385) already paginates, and the
shared single-partition helper `queryGsi` (lines 274-291) was moved onto
`queryAll` for the same reason; the range read is the one GSI reader left on a
single page.

Callers (the only two): `app/src/routes/today.ts:550` (the Today board's
tours-today window) and `app/src/routes/tours.ts:413` (`GET /api/tours?from&to`),
which serves the Tours page's Active window (start of today to +30 days) and,
since the Past tab (spec `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`
section 4.2), a 90-day look-back sorted most-recent-first - so for Past a
truncation would remove exactly the rows it puts at the top.

A tour item is small (well under 2 KB), so the 1 MB page holds hundreds of
tours; at the current volume no window comes near it, which is why this is
filed as low debt rather than fixed in the Past tab build.

**Suggested fix.** Paginate exactly as `listByStatus` does: loop on
`ExclusiveStartKey` until `LastEvaluatedKey` is undefined, appending pages.
Add an integration test against DynamoDB Local with a `Limit: 1`-forced page
size (or enough seeded rows) proving a range read returns every row across
pages.

**Update 2026-09-30.** The Today page now reads this window too:
feat/today-past-tours added a "Past tours needing an outcome" section that
reuses the Past tab's loader (`usePastTours`), so a truncated range read would
also drop the most recent rows from the landing page. Still low at the
current volume (review finding L9,
`docs/superpowers/reviews/2026-09-30-today-past-tours/`).

**Update 2026-10-04.** The tour auto-close sweep (feat/tour-auto-close,
`app/src/jobs/tourAutoClose.ts`) is not a third caller: it reads its
candidates by STATUS - `listByStatus` for `scheduled`, `toured` and `no_show`,
each paged to exhaustion - never by range (spec
`docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`, section
6.2), so a truncated range page cannot hide a tour from it, and it also reaches
the undated tours the `byScheduledAt` GSI leaves out. The range read still has
exactly the two callers above. Line numbers above are as of main @ae04122d; on
feat/tour-auto-close `listByScheduledRange` is
`app/src/repos/toursRepo.ts:393-410`, `listByStatus` is `:412-432` and the
tours route's caller is `app/src/routes/tours.ts:387`. Status unchanged.
