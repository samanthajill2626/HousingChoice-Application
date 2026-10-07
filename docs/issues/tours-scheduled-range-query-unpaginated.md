---
id: tours-scheduled-range-query-unpaginated
title: toursRepo.listByScheduledRange reads one Query page (no LastEvaluatedKey follow) and drops the NEWEST tours first
type: debt
severity: low
status: resolved
resolved: 2026-10-06
area: app/tours
created: 2026-09-26
refs: app/src/repos/toursRepo.ts:399, app/src/repos/toursRepo.ts:418, app/src/routes/today.ts:550, app/src/routes/tours.ts:387, dashboard/src/routes/tours/useTours.ts
---

**Problem.** `listByScheduledRange(from, to)` (`app/src/repos/toursRepo.ts:399-416`)
issues a single `Query` on the `byScheduledAt` GSI and returns `Items` without
following `LastEvaluatedKey`. DynamoDB caps a Query page at 1 MB, so a window
whose tours exceed that returns a silently truncated list. The Query is
ASCENDING on `scheduledAt`, so the rows dropped are the NEWEST in the window.
`listByStatus` directly below it (lines 418-437) already paginates, and the
shared single-partition helper `queryGsi` (lines 326-342) was moved onto
`queryAll` for the same reason; the range read is the one GSI reader left on a
single page.

Callers (the only two): `app/src/routes/today.ts:550` (the Today board's
tours-today window) and `app/src/routes/tours.ts:387` (`GET /api/tours?from&to`),
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
exactly the two callers above. Every line number in this file was re-derived
on feat/tour-auto-close (2026-10-04); until then they cited main @ae04122d.
Status unchanged.

**Resolution (2026-10-06, feat/tour-list).** Fixed as the first slice of the
Tours page All tab (spec `docs/superpowers/specs/2026-10-06-tour-list-design.md`
section 7, decision D5), so every date-window list - Active, Past and Today -
is complete:

- `listByScheduledRange` now walks EVERY page through `queryAll`
  (`app/src/lib/dynamoPaging.ts`), like the other tours reads
  (`app/src/repos/toursRepo.ts:416-426`; interface and docblock `:203-210`).
  It gained an optional third argument `{ pageLimit?: number }` - the Query's
  `Limit`, used only by tests. Its two callers are unchanged
  (`app/src/routes/tours.ts:418` and `app/src/routes/today.ts:550` on
  feat/tour-list). Commit `17f07803`.
- A DynamoDB Local integration test
  (`app/test/toursRepo.integration.test.ts:252-308`, "listByScheduledRange
  pages to completion (March 2027 window)") writes several tours in one
  window, reads it with `pageLimit: 1` and proves the window comes back whole
  across at least seven Queries; a pin keeps the default read (no `opts`)
  whole too.
- Today's stale warning is removed: `warnIfCapped('tours_today', ...)` fired
  on a COUNT of 100 or more over a read that now pages to completion, so it
  could only be false. A one-line comment stands in its place
  (`app/src/routes/today.ts:551`); the remaining cap (100 pages of 1 MB,
  unreachable in production) lives in `queryAll`, which warns on its own
  (`dynamoPaging.ts:20, 55`). A case seeds 100 tours today and asserts all
  100 show with no `tours_today` cap WARN (`app/test/todayApi.test.ts:594`).
  Commit `cb0bee40`.

The line numbers above the Resolution cite the pre-fix code; they are left as
the record.

Renamed later on feat/tour-list (planner review ADV-F4, commit `e84dfbfa`): the test knob `pageLimit` above is now `queryLimit` - EACH Query's `Limit`, not a page cap (the `listByScheduledRange` docblock in `app/src/repos/toursRepo.ts`); the integration test reads with `queryLimit: 1`.
