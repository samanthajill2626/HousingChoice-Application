---
id: tours-scheduled-range-query-unpaginated
title: toursRepo.listByScheduledRange reads one Query page (no LastEvaluatedKey follow)
type: debt
severity: low
status: open
area: app/tours
created: 2026-09-26
refs: app/src/repos/toursRepo.ts:347, app/src/repos/toursRepo.ts:366, dashboard/src/routes/tours/useTours.ts
---

**Problem.** `listByScheduledRange(from, to)` (`app/src/repos/toursRepo.ts:347-364`)
issues a single `Query` on the `byScheduledAt` GSI and returns `Items` without
following `LastEvaluatedKey`. DynamoDB caps a Query page at 1 MB, so a window
whose tours exceed that returns a silently truncated list. `listByStatus`
directly below it (lines 366-385) already paginates, and the shared
single-partition helper `queryGsi` (lines 274-291) was moved onto `queryAll`
for the same reason; the range read is the one GSI reader left on a single
page.

Readers today: the Tours page's Active window (start of today to +30 days), the
Today board's tours-today query, the reminder and no-show sweeps, and, since
the Past tab (spec `docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`
section 4.2), a 90-day look-back. A tour item is small (well under 2 KB), so
the 1 MB page holds hundreds of tours; at the current volume no window comes
near it, which is why this is filed as low debt rather than fixed in the Past
tab build.

**Suggested fix.** Paginate exactly as `listByStatus` does: loop on
`ExclusiveStartKey` until `LastEvaluatedKey` is undefined, appending pages.
Add an integration test against DynamoDB Local with a `Limit: 1`-forced page
size (or enough seeded rows) proving a range read returns every row across
pages.
