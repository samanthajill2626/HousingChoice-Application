---
id: perf-pages-contacts-caseworkers-surface
title: Contacts > Caseworkers (/contacts/caseworkers) is excluded from the perf:pages route-registry pin instead of being a profiled surface
type: improvement
severity: low
status: open
area: e2e/performance
created: 2026-10-08
refs: e2e/performance/routes.test.ts, e2e/performance/routes.ts, dashboard/src/App.tsx, dashboard/src/routes/contacts/CaseworkersList.tsx, app/src/services/possibleCaseworkers.ts
---

**Problem.** The caseworkers feature (spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D18, D19) adds a Contacts page, `/contacts/caseworkers`, to
`dashboard/src/App.tsx` and the nav. `e2e/performance/routes.test.ts`
requires the App route set, minus its local `excluded` set, to equal the
profiler's `EXPECTED_KEYS` (31 registered surfaces). Registering the page as a
32nd surface changes that `perf:pages` contract (the 31 pins, `EXPECTED_WARM`,
the README count, the `routes.ts` citation ledgers, a new GET contract), which
the feature did not take on (planner ruling R4-13): the path joined the
`excluded` set instead, the `/tours/past` and `/settings/organizations`
precedent. So the page is a staff destination the profiler never measures.
Its reads are scale-bearing: it walks EVERY live partner
(`GET /api/contacts?type=partner`, all pages) and calls
`GET /api/contacts/possible-caseworkers`, which reads the whole tenant,
landlord and partner partitions on the server (no index exists for any
possible-caseworker signal), on every mount and again after each conversion.

**Suggested fix.** Add a `/contacts/caseworkers` row to `ROUTES` in
`e2e/performance/routes.ts` modeled on the `/contacts/unknown` row: source =
the Contacts > Caseworkers nav link; terminal = the "Caseworkers" list (or
"No caseworkers yet.") AND the "Possible caseworkers" list (or "No possible
caseworkers right now.") settled, or a load alert; GET contract = the partner
walk plus `GET /api/contacts/possible-caseworkers`, both on mount. Then add
the key to `EXPECTED_KEYS` / `EXPECTED_WARM`, bump the 31 pins to 32, refresh
the citation ledgers, update the README count, remove the `excluded` entry,
and re-run the profiler self-QA (`npm run perf:pages -- hermetic
--self-qa=full`, using the hermetic lane per `e2e/README.md`). Mark it
`surfaceScaleBearing` and `loadScaleBearing` (the two full reads above).
