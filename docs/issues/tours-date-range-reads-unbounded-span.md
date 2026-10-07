---
id: tours-date-range-reads-unbounded-span
title: The tours date-range read pages to completion over client-supplied windows with no span bound; from > to on GET /api/tours is a 500
type: debt
severity: low
status: open
area: app/tours
created: 2026-10-06
refs: app/src/repos/toursRepo.ts:420, app/src/lib/dynamoPaging.ts:20, app/src/routes/tours.ts:428, app/src/routes/today.ts:287, app/src/routes/today.ts:550, docs/superpowers/reviews/2026-10-06-tour-list/code-review/r1-adversarial.md, docs/superpowers/reviews/2026-10-06-tour-list/code-review/r2-re-review.md
---

**Problem.** The unbounded walk is NEW on feat/tour-list. Spec
`docs/superpowers/specs/2026-10-06-tour-list-design.md` section 7 turned
`toursRepo.listByScheduledRange` (`app/src/repos/toursRepo.ts:420`) from a
one-page read into a `queryAll` walk of every page (commit 17f07803), capped
only by `DEFAULT_MAX_PAGES = 100` (`app/src/lib/dynamoPaging.ts:20`). The
walk itself is right - the old one-page read dropped the newest tours of a
window - but both callers take the window from the query string with no span
limit:

- `GET /api/tours?from=&to=` (`app/src/routes/tours.ts:428`) checks only that
  each bound parses, then returns every full tour item in the window (rosters
  included) in one JSON body;
- `GET /api/today?toursFrom=&toursTo=` (`parseToursWindow`,
  `app/src/routes/today.ts:287`) checks only that from is before to, and
  `today.ts:550` then resolves a contact label for each scheduled tour in the
  window (cached per contact).

Before the branch, the old single page capped such a request at about 1 MB -
by accident, not by design. Now one hand-made request (for example
`toursFrom=0001-01-01T00:00:00.000Z&toursTo=9999-12-31T00:00:00.000Z`) can
read the whole byScheduledAt partition - up to 100 Queries, about 100 MB.
Authenticated staff only. The dashboard always sends small windows: Today one
local day, the Active tab 30 days, the Past tab 90 days; and with today's
table (hundreds of tours, well under one 1 MB page) the walk costs what the
one-page read did. `?status=` (`listByStatus`) has always walked a whole
status partition unbounded, so the branch adds no new KIND of read - but on
these two endpoints the unbounded walk is the branch's own change, not
something it inherited.

The ONLY part that predates feat/tour-list: `GET /api/tours?from=<later>&to=<earlier>`
reaches DynamoDB as `BETWEEN` with the lower bound above the upper one, which
DynamoDB refuses with a ValidationException - a 500. The harness fake answers
`[]`, so no route test can see it.

Found by the plan-blind code review of feat/tour-list (r1 AD-2); the r2
re-review corrected this issue's framing (the walk is new on the branch, only
from > to predates it). Spec D6 and section 7 keep both callers' parameters
and behavior unchanged, so the span bound was filed rather than added on that
branch.

**Suggested fix.** In both parsers, a 400 when the window is longer than a
fixed span (for example 400 days; the dashboard's widest window is 90), and in
`GET /api/tours` a 400 when from is after to (Today already refuses from >=
to). Alternatively pass a small `maxPages` to `queryAll` for these two
callers. Regression tests:
`GET /api/today?toursFrom=0001-01-01T00:00:00.000Z&toursTo=9999-12-31T00:00:00.000Z`
and `GET /api/tours?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`
each expect a 400.

**Severity at scale (2026-10-06, feat/tour-list planner review).** The
plan-blind reviewer's note
(`docs/superpowers/reviews/2026-10-06-tour-list/planner-review/adversarial.md`,
"Already filed"): at scale the risk is availability, not only cost. One such
request can make the API process materialize about 100 MB of tour items and
serialize them as one JSON body, blocking that container's event loop while
it does. Unreachable at today's volume, and the interim bound above (a small
`maxPages` for the two callers) is one line. The bound belongs in
`queryAll`'s `maxPages`, NOT in the knob beside it: the same review renamed
`listByScheduledRange`'s optional third argument from `pageLimit` to
`queryLimit`, because it is EACH Query's `Limit` - a test knob that forces
paging. A small `queryLimit` only multiplies the round trips, and at the
100-page cap the walk returns a prefix (`queryAll` logs a WARN, now through
the repo's logger).
