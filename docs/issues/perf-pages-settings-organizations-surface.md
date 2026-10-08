---
id: perf-pages-settings-organizations-surface
title: Settings > Housing authorities & agencies (/settings/organizations) is excluded from the perf:pages route-registry pin instead of being a profiled surface
type: improvement
severity: low
status: open
area: e2e/performance
created: 2026-10-06
refs: e2e/performance/routes.test.ts, e2e/performance/routes.ts, dashboard/src/App.tsx, dashboard/src/routes/settings/OrgListSection.tsx, dashboard/src/routes/settings/useOrgAdmin.ts
---

**Problem.** The clean-org-names feature (spec
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
D10) adds a Settings tab, `/settings/organizations`, to
`dashboard/src/App.tsx`. `e2e/performance/routes.test.ts` ("mechanically
matches App route elements and proves generated placeholders are empty")
recognises Settings children from a hard-coded list and requires the route
set, minus its local `excluded` set, to equal the profiler's `EXPECTED_KEYS`
(exactly 31 registered surfaces). Registering the tab as a 32nd surface
changes that `perf:pages` contract (the 31 pins in `routes.test.ts`,
`EXPECTED_WARM`, the README count, the citation ledgers in `routes.ts`, a new
GET contract), which the feature did not take on: the path joined the
Settings-children list and the `excluded` set instead, the `/tours/past`
precedent (`perf-pages-tours-past-surface`). So the tab is a staff
destination the page profiler never measures. Its reads are scale-bearing:
`GET /api/organizations/usage` and `GET /api/organizations/not-on-list` scan
every contact and every unit (deleted ones included) on each load, and
while a rewrite runs the section re-reads `GET /api/organizations` every 2 s,
then reads the two scans once more when it stops.

**Suggested fix.** Add a `/settings/organizations` row to `ROUTES` in
`e2e/performance/routes.ts` modeled on the `/settings/numbers` row: source
`SETTINGS_SOURCE('/settings/organizations', 'Housing authorities & agencies')`;
terminal = the Housing authorities list region and the detail panel's
placeholder settled, or the load alert (the tab became a list + detail layout
on 2026-10-07, `fix/org-settings-layout`; it no longer renders three
regions); GET contract = `GET /api/organizations`,
`GET /api/organizations/usage`, `GET /api/organizations/not-on-list`, all on
mount, no polling when no rewrite runs. Then add the key to `EXPECTED_KEYS` /
`EXPECTED_WARM`, bump the 31 pins to 32, refresh the `routes.ts` citation
ledgers, update the README count, remove the two `excluded` entries
(`/settings/organizations` and, since the route became
`organizations/:orgId?`, `/settings/organizations/:orgId?`), and re-run the
profiler self-QA (`npm run perf:pages -- hermetic --self-qa=full`,
human-owned per `e2e/README.md`). Decide `surfaceScaleBearing` /
`loadScaleBearing` from the two full scans above.
