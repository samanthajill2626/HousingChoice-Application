---
id: perf-pages-tours-past-surface
title: The Tours page's Past tab (/tours/past) is excluded from the perf:pages route-registry pin instead of being a profiled surface
type: improvement
severity: low
status: open
area: e2e/performance
created: 2026-09-27
refs: e2e/performance/routes.test.ts, e2e/performance/routes.ts, dashboard/src/App.tsx, dashboard/src/routes/tours/ToursPage.tsx, dashboard/src/routes/tours/useTours.ts
---

**Problem.** The Past tab (spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` section 4)
adds a third tours route, `/tours/past`, to `dashboard/src/App.tsx`.
`e2e/performance/routes.test.ts` ("mechanically matches App route elements and
proves generated placeholders are empty") reads `App.tsx`, collects every
`<Route path>` and requires that set, minus its local `excluded` set, to equal
the profiler's `EXPECTED_KEYS`, which pins exactly 31 registered surfaces
(`/tours` and `/tours/closed` among them; the README's full self-QA also
requires "the exact 31 registered surfaces"). Registering `/tours/past` as a
32nd surface changes that `perf:pages` contract (the 31 pins in
`routes.test.ts`, `EXPECTED_WARM`, the README count, the citation ledgers in
`routes.ts`, a new GET contract), which the overnight build of 2026-09-27 did
not take on its own: the route was added to the test's `excluded` set instead
(commit `0ad6200a`). So the Past tab is a staff navigation destination the page
profiler never measures, although its list is scale-bearing (one range read
over 90 days of tours, selected on the client).

**Suggested fix.** Add a `/tours/past` row to `ROUTES` in
`e2e/performance/routes.ts` modeled on the `/tours/closed` row: source `/tours`
with a `link('/tours/past')` click; terminal = the list "Past tours list" | the
empty text "No past tours need attention in the last 90 days." | the alert; GET
contract = one `GET /api/tours?from=&to=` (the 90-day window built by
`pastToursDateRange` in `dashboard/src/routes/tours/useTours.ts`), noting that
the Past fetch is issued by a child component that mounts only after the
contact and unit lookups land, so it is one round trip AFTER them rather than
beside them (Closed's fetch runs at page level, in parallel). Then add the key
to `EXPECTED_KEYS` / `EXPECTED_WARM`, bump the 31 pins to 32, refresh the
`routes.ts` citation ledgers (the Tours line ranges moved in this build),
update the README count, remove the `excluded` entry, and re-run the profiler
self-QA (`npm run perf:pages -- hermetic --self-qa=full`, human-owned per
`e2e/README.md`).

**Update 2026-09-27 (guard review round 2).** The GET contract above is out of
date: since spec 4.2a the Past view also reads `GET /api/tours?status=toured`
(toured tours the range cannot reach: undated, or dated after today). The page
always issues the Active window's two reads (`?from&to` and
`?status=requested`) and the contact and unit walks every Tours list carries
(`TOUR_LIST_ACTIVE_GETS` in `e2e/performance/routes.ts`), then Past's range
read and its status read. In the contract's path + query-key model the two
`?from&to` reads share one shape and the two `?status` reads share another,
so a registered row must count occurrences rather than list keys. The KNOWN
GAP note in `routes.ts` says the same.
