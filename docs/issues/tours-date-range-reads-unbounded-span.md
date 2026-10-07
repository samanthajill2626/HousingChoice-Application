---
id: tours-date-range-reads-unbounded-span
title: The tours date-range read pages to completion over client-supplied windows with no span bound; from > to on GET /api/tours is a 500
type: debt
severity: low
status: open
area: app/tours
created: 2026-10-06
refs: app/src/repos/toursRepo.ts:417, app/src/lib/dynamoPaging.ts:20, app/src/routes/tours.ts:428, app/src/routes/today.ts:287, app/src/routes/today.ts:550, docs/superpowers/reviews/2026-10-06-tour-list/code-review/r1-adversarial.md
---

**Problem.** Since feat/tour-list (spec
`docs/superpowers/specs/2026-10-06-tour-list-design.md` section 7),
`toursRepo.listByScheduledRange` (`app/src/repos/toursRepo.ts:417`) walks
every page through `queryAll`, capped only by `DEFAULT_MAX_PAGES = 100`
(`app/src/lib/dynamoPaging.ts:20`). That is correct - the old one-page read
dropped the newest tours of a window - but both callers take the window from
the query string with no span limit:

- `GET /api/tours?from=&to=` (`app/src/routes/tours.ts:428`) checks only that
  each bound parses, then returns every full tour item in the window (rosters
  included) in one JSON body;
- `GET /api/today?toursFrom=&toursTo=` (`parseToursWindow`,
  `app/src/routes/today.ts:287`) checks only that from is before to, and
  `today.ts:550` then resolves a contact label for each scheduled tour in the
  window (cached per contact).

Before the change the accidental one-page read capped a request at about
1 MB. Now one hand-made request (for example
`toursFrom=0001-01-01T00:00:00.000Z&toursTo=9999-12-31T00:00:00.000Z`) can
read the whole byScheduledAt partition - up to 100 Queries, about 100 MB.
Authenticated staff only. The dashboard always sends small windows: Today one
local day, the Active tab 30 days, the Past tab 90 days. `?status=`
(`listByStatus`) already walks a whole status partition unbounded, so this is
not a new class of exposure; it removes an accidental bound on two more
endpoints.

Pre-existing and unchanged by feat/tour-list: `GET /api/tours?from=<later>&to=<earlier>`
reaches DynamoDB as `BETWEEN` with the lower bound above the upper one, which
DynamoDB refuses with a ValidationException - a 500. The harness fake answers
`[]`, so no route test can see it.

Found by the plan-blind code review of feat/tour-list (r1 AD-2). Spec D6 and
section 7 keep both callers unchanged, so it was filed rather than fixed on
that branch.

**Suggested fix.** In both parsers, a 400 when the window is longer than a
fixed span (for example 400 days; the dashboard's widest window is 90), and in
`GET /api/tours` a 400 when from is after to (Today already refuses from >=
to). Alternatively pass a small `maxPages` to `queryAll` for these two
callers. Regression tests:
`GET /api/today?toursFrom=0001-01-01T00:00:00.000Z&toursTo=9999-12-31T00:00:00.000Z`
and `GET /api/tours?from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z`
each expect a 400.
