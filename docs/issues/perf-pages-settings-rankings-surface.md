---
id: perf-pages-settings-rankings-surface
title: Settings > Rankings (/settings/rankings) is excluded from the perf:pages route-registry pin instead of being a profiled surface
type: improvement
severity: low
status: open
area: e2e/performance
created: 2026-10-29
refs: e2e/performance/routes.test.ts:385, e2e/performance/routes.test.ts:411, e2e/performance/routes.ts:693, dashboard/src/App.tsx:234, dashboard/src/routes/settings/rankings/RankingsSection.tsx, dashboard/src/routes/settings/rankings/useRankingRuns.ts, dashboard/src/routes/settings/rankings/useRankCandidates.ts
---

**Problem.** WP1 B2a (spec
`docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md` D18)
adds an admin-only Settings tab, `/settings/rankings` (Settings > Rankings,
routed inside `AdminRoute` in `dashboard/src/App.tsx`).
`e2e/performance/routes.test.ts` ("mechanically matches App route elements
and proves generated placeholders are empty") recognises Settings children
from a hard-coded list and requires the route set, minus its local
`excluded` set, to equal the profiler's `EXPECTED_KEYS` (31 registered
surfaces at B2a). Registering the tab as one more surface changes that
`perf:pages` contract (the surface-count pins in `routes.test.ts`,
`EXPECTED_WARM`, the README count, the citation ledgers in `routes.ts`, a
new GET contract), which B2a did not take on: `'/rankings'` joined the
Settings-children list and `'/settings/rankings'` the `excluded` set, with
a `TODO(perf-pages-settings-rankings-surface)` in `e2e/performance/routes.ts`
- the precedent of `perf-pages-settings-organizations-surface` and
`perf-pages-tours-past-surface`. So the tab is a staff destination the page
profiler never measures.

Its reads on mount are scale-bearing - four GETs, none of them bounded by
the page:

- `GET /api/admin/rankings/runs` - the runs list: a Query of the run
  pointers, then one BatchGet of the run summaries (paged by cursor);
- `GET /api/admin/rankings/cost` - the weekly cost totals: with no range it
  reads every run of the last 12 ISO weeks (up to 50 pages);
- `GET /api/units` walked to its last page - every unit, for the "Rank this
  anchor" property search (`useRankCandidates`);
- `GET /api/contacts?type=tenant` walked to its last page - every tenant,
  for the tenant search.

With a ranked anchor in the URL (`rank=<kind>:<id>`) the page also reads
`GET /api/rankings/:kind/:anchorId` (the ranking read) and, while that
anchor's job runs, polls `GET /api/rankings/:kind/:anchorId/job` every 5 s;
`run=<runId>` adds the run detail, `GET /api/admin/rankings/runs/:runId`.

**Suggested fix.** Add a `/settings/rankings` row to `ROUTES` in
`e2e/performance/routes.ts`, modeled on the admin-only `/settings/ai-runs`
row: `requiredRole: 'admin'`, source
`SETTINGS_SOURCE('/settings/rankings', 'Rankings')`; terminal = the "Ranking
runs" list (or its empty line) and the "Cost by week" region settled, or the
load alert; GET contract = the four GETs above, all on mount, no polling
without a running job. Then add the key to `EXPECTED_KEYS` /
`EXPECTED_WARM`, bump the surface-count pins by one, refresh the
`routes.ts` citation ledgers, update the README count, remove the
`'/settings/rankings'` entry from `excluded` (and its TODO), and re-run the
profiler self-QA (`npm run perf:pages -- hermetic --self-qa=full`,
human-owned per `e2e/README.md`). Decide `surfaceScaleBearing` /
`loadScaleBearing` from the two full walks (every unit, every tenant) and
the cost read's 12-week span. Seed the lane with ranking runs first, or the
runs list and the cost totals measure an empty table.
