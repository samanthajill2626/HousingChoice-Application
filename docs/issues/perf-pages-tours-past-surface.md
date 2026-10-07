---
id: perf-pages-tours-past-surface
title: The Tours page's Past and All tabs (/tours/past, /tours/all) are excluded from the perf:pages route-registry pin instead of being profiled surfaces
type: improvement
severity: low
status: open
area: e2e/performance
created: 2026-09-27
updated: 2026-10-06
refs: e2e/performance/routes.test.ts, e2e/performance/routes.ts, e2e/README.md, dashboard/src/App.tsx, dashboard/src/routes/tours/ToursPage.tsx, dashboard/src/routes/tours/useTours.ts, dashboard/src/routes/tours/AllToursView.tsx, dashboard/src/routes/tours/useAllTours.ts
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

**Update 2026-10-06 (feat/tour-list).** This issue now covers TWO
unregistered Tours views: `/tours/past` above and the All tab, `/tours/all`
(spec `docs/superpowers/specs/2026-10-06-tour-list-design.md` 4.11 and P11),
which feat/tour-list left out of the profiler the same way - excluded on
purpose in the same route pin (`e2e/performance/routes.test.ts:383-384`,
under its own comment line), named in the same KNOWN GAP comment
(`e2e/performance/routes.ts:628-634`) and in `e2e/README.md:87-89`. Its reads
differ from Past's: `/tours/all` reads `GET /api/tours/list?when&sort&limit`
for the first page (`limit=50`), the same plus `cursor` after it (`limit=100`
for a search walk or a return restore; `status`, `type`, `from` and `to` only
when filtered), and NEVER the contact or unit walks - each page carries the
names its rows need. Registering it needs a row (source `/tours` with a
`link('/tours/all')` click, modeled on the `/tours/closed` row), a terminal -
the list "All tours list" | the text "No tours match these filters." | the
alert (a failed first page renders inside `role="alert"`: the first-page
failure block of `AllToursView`, its `data.status === 'error'` branch, in
`dashboard/src/routes/tours/AllToursView.tsx`) - and that GET contract;
then the same steps as the Suggested fix (`EXPECTED_KEYS`, `EXPECTED_WARM`,
the 31 pins - 32 for one view, 33 for both - the README count, the
`excluded` entry, the profiler self-QA).
