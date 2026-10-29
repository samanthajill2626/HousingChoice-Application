# S7 slice report - Dashboard and e2e (WP1 B2a)

- Implementers: S7a child (tasks S7.1-S7.6, its own report:
  [S7a-report.md](S7a-report.md)) and S7b child (tasks S7.7-S7.13, this
  file), both Claude Opus 5.5, 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Slice range: 3aebab97 (the S6 report) .. f782131d, plus this report's
  commit. S7b range: 6b338d94 (the S7a report) .. f782131d.
- Scope: plan section 11 in full (head 30045-30312, tasks S7.1-S7.13,
  coverage table 35458-35512). Spec D18, D12 (dashboard side), D9 (read as
  given), D11 (run detail), spec 6 e2e. Rulings in force: PR2, PR7, PR9,
  PR13-PR16, PR26, PR34, PR38, PR42, PR43. Watch items: WI16 (S7a), WI17,
  WI19. WORKLIST: section G, WL-S7-1..WL-S7-7.
- Verdict: thirteen tasks, one commit each (twelve code commits plus this
  report; S7a's report is its own commit). Every RED was for its stated
  reason; every new file is byte-identical to its plan block except the
  WORKLIST-sanctioned edits (section 3). Both e2e specs are green on the
  hermetic lane: `rankings.spec.ts` 5/5, `contact-notes-conflict.spec.ts`
  1/1. Close evidence: root `npm run typecheck` exit 0 (five workspaces);
  eslint on all 34 slice ts/tsx files exit 0; whole dashboard suite 282
  files / 5776 tests exit 0; e2e workspace unit suite 22 files / 509 tests
  exit 0; branch-wide ASCII sweep over `dashboard` and `e2e` = 0. No
  QUESTION. No one-value test fix.

## 1. Tasks and commits

| Task | Commit | Files |
|---|---|---|
| S7.1 rankings wire types and endpoints (+ WL-S7-1) | 882055bc | see S7a-report.md section 1 |
| S7.2 `ranking.updated` in the event stream | 94b0c53b | see S7a-report.md |
| S7.3 the page's copy and pure helpers | cf1f8607 | see S7a-report.md |
| S7.4 `useAnchorRanking` | 0e136b67 | see S7a-report.md |
| S7.5 `RankingTable` (+ `RankingsSection.module.css`) | 223bb953 | see S7a-report.md |
| S7.6 Rank this anchor (+ WL-S7-4) | 5483c92a | see S7a-report.md |
| S7a report | 6b338d94 | `slices/S7a-report.md` |
| S7.7 `useRankingRuns` - list, detail, cost reads | 8771feec | `dashboard/src/routes/settings/rankings/useRankingRuns.ts`, `useRankingRuns.test.tsx` (new) |
| S7.8 runs list, cost totals, run detail | 3931b6aa | `RankingRunList.tsx`, `RankingCostTotals.tsx`, `RankingRunDetail.tsx`, `RankingRunViews.test.tsx` (new, same directory) |
| S7.9 `RankingsSection` and its URL state | 73082a98 | `RankingsSection.tsx`, `RankingsSection.test.tsx` (new, same directory) |
| S7.10 ranking e2e specs and fixtures (+ WL-S7-3, WL-S7-6) | fae728b3 | `e2e/fixtures/ranking.ts` (new), `e2e/tests/dashboard-next/rankings.spec.ts` (new), `e2e/support/selectors.md` (one row) |
| S7.11 the Rankings tab, admin only, inside AdminRoute (+ WL-S7-2) | af93c0f6 | `dashboard/src/routes/settings/settingsTabs.ts`, `settingsTabs.test.ts`, `SettingsPage.test.tsx`, `dashboard/src/App.tsx`, `e2e/performance/routes.test.ts`, `e2e/performance/routes.ts` |
| S7.12 the edit form's Notes conflict e2e (RED waived, PR26) | f782131d | `e2e/tests/dashboard-next/contact-notes-conflict.spec.ts` (new) |
| S7.13 close and this report | this commit | `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/slices/S7-report.md` |

Commit order note: S7.10's spec was written and run RED first, then S7.11
was built and the spec run GREEN; both commits were made after that GREEN
run (the dispatch's "iterate uncommitted, commit after green"), S7.10 first.
So the history at fae728b3 holds the spec without the route - red by design,
as the plan intends (N7) - and af93c0f6 mounts it.

## 2. Test commands and counts (S7b, every run, in order)

Dashboard form: `cd W:/tmp/wp1-b2-ranking-engine/dashboard && npx vitest run <files>`.
e2e unit form: `cd W:/tmp/wp1-b2-ranking-engine/e2e && npx vitest run <files>`.
e2e form (the plan's): `cd W:/tmp/wp1-b2-ranking-engine && npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/<spec>.spec.ts`.
Every command ran in the foreground with a hard timeout; nothing was left
running. No `npm ci`, `npm install` or `npm run db:start` (G1).

1. S7.7 RED `src/routes/settings/rankings/useRankingRuns.test.tsx`: 1 file
   failed, no tests - "Failed to resolve import "./useRankingRuns.js" ...
   Does the file exist?" (G4 wording of the stated missing module).
2. S7.7 GREEN: 7 passed. No stderr. eslint on both files exit 0.
3. S7.8 RED `RankingRunViews.test.tsx`: no tests - "Failed to resolve import
   "./RankingCostTotals.js"" (the three component modules missing).
4. S7.8 GREEN: 22 passed. No stderr. eslint on the four files exit 0.
5. S7.9 RED `RankingsSection.test.tsx`: no tests - "Failed to resolve import
   "./RankingsSection.js"".
6. S7.9 GREEN `src/routes/settings/rankings` (every rankings suite): 8 files,
   97 passed (rankingFormat 15, useRankCandidates 2, RankingTable 7,
   useAnchorRanking 15, useRankingRuns 7, RankingRunViews 22,
   RankingsSection 7, RankAnchorPanel 22). One stderr line, S7a's known
   benign one: "An update to Probe inside a test was not wrapped in act(...)"
   in useAnchorRanking.test.tsx "returns the read window, and keeps the last
   one while a new read loads (plan PR26)" (S7a-report.md section 2 item 12).
7. S7.10 prerequisites (plan S7.10): `git grep -n "RANKING_WORKER_POLL\|RANKING_DRIVER" -- scripts/e2e-session.mjs`
   -> :268, :271 `RANKING_DRIVER: 'fake'`, :272 `RANKING_WORKER_POLL: 'off'`;
   `git grep -n "__dev/ranking/tick" -- app/src/routes/dev.ts` -> :146, :798,
   :819 (the route). Both present.
8. e2e workspace `npx tsc -p tsconfig.json` (the new fixture and spec): exit
   0; eslint on both exit 0.
9. e2e RED `rankings.spec.ts` (14:14:23-14:15:56, exit 1, lane 8): 5 tests,
   5 failed, exactly as the plan states. Tests 1-4 failed at
   `openRankings` (`rankings.spec.ts:53`, the `Rankings` heading not found
   within 15 s), each AFTER its fixtures (called from :118, :185, :208,
   :237), so every fixture call - the organization add, the unit create and
   publish, the tenant create and authority PATCH - answered 2xx. Test 5
   failed at `rankings.spec.ts:262` `toHaveURL(/\/settings\/templates$/)`,
   received `/settings/rankings` (an unrouted path does not redirect); its
   `waitForURL` and the "no Rankings tab" assertion before it passed. No
   failure anywhere else (no fixture 4xx, no tick 404).
10. S7.11 RED `src/routes/settings/settingsTabs.test.ts src/routes/settings/SettingsPage.test.tsx`:
    2 files, 4 failed, 7 passed - settingsTabs "the model carries all
    sections in order, with the admin-only flags" (the order array and the
    admin-only list are one case), "visibleTabs(true) ...", the new "the
    Rankings tab is admin only ..." (expected -1 to be 6), and SettingsPage
    "an admin sees all tabs ..."; the VA cases pass (PIN), as the plan says.
11. S7.11 GREEN `src/routes/settings`: 31 files, 448 passed.
12. WL-S7-2 RED `performance/routes.test.ts` (App.tsx carrying the route,
    the pin not yet updated): 1 failed, 29 passed - "route registry
    completeness > mechanically matches App route elements ...": the
    received list holds `"/rankings"` (D7-2 reproduced).
13. WL-S7-2 GREEN `performance/routes.test.ts`: 30 passed.
14. eslint on the eight S7.10 / S7.11 files: exit 0.
15. e2e GREEN `rankings.spec.ts` (14:18:58-14:19:12, exit 0, lane 7): 5
    tests, **5 passed (13.1 s)** - test 1 808 ms, test 2 555 ms, test 3
    581 ms, test 4 530 ms, test 5 319 ms. App log: five `dev ranking tick
    ran` lines, each `claimed: 1, expired: 0, tookOver: 0, failedStale: 0`.
    First GREEN run; no re-run was needed.
16. S7.12 prerequisite: `git grep -n "notes_expected_updated_at\|These notes were changed since you opened this form" -- dashboard/src/routes/contact/ContactEditForm.tsx`
    -> :138 (the copy) and :444 (the stamp sent). Both present.
17. e2e workspace `npx tsc -p tsconfig.json`: exit 0; eslint on the spec
    exit 0.
18. e2e `contact-notes-conflict.spec.ts` (14:20:58-14:21:10, exit 0, lane
    7): 1 test, **1 passed (11.1 s)**, test 973 ms. App log: the three
    PATCHes of the contact answered 200 (theirs), 409 with `error:
    "notes_stale"` ("contact patch refused: a guarded value changed"), then
    200 (mine, re-based).
19. S7.13 root `npm run typecheck` (bare): exit 0 - app, dashboard, e2e,
    fake-twilio, fake-twilio-web.
20. S7.13 eslint on the 34 slice files (the plan's 31 plus
    `e2e/performance/routes.ts`, `routes.test.ts`, `mutationCatalog.ts`,
    `mutationCatalog.test.ts`): exit 0, no problem reported - so no
    baseline comparison was needed and no pre-existing error is in a touched
    file.
21. S7.13 whole dashboard suite (`npx vitest run` in `dashboard/`): 282
    files, 5776 passed, exit 0 (S7a close: 279 / 5739; +3 files and +37
    tests = 7 + 22 + 7 new and one new settingsTabs case).
22. S7.13 e2e workspace unit suite (`npm test -w @housingchoice/e2e`): 22
    files, 509 passed, exit 0.
23. Before every e2e run `e2e/.artifacts/session.pid` was checked; it was
    absent before run 9 and present after each run (the launcher leaves it),
    so `npm run e2e:stop` ran before runs 15 and 18 and before the close
    ("no running session found ... nothing to stop") and no listener
    survived on the lane ports (Get-NetTCPConnection: lane 7's ports before
    run 9; lanes 7 and 8 before runs 15 and 18). Lane note: a probe of
    `node e2e/support/lane.mjs` before run 9 RESERVED lane 7 (the resolver
    leases a lane for its 240 s grace window, `laneLease.mjs`), so run 9
    took lane 8; the lease lapsed and runs 15 and 18 took lane 7. Read
    `e2e/.artifacts/lane.json` instead of running the resolver.

e2e run table:

| Run | Spec | Exit | Tests | Result | Wall | Lane |
|---|---|---|---|---|---|---|
| 9 (RED) | rankings.spec.ts | 1 | 5 | 5 failed (for the stated reason) | 93 s | 8 |
| 15 (GREEN) | rankings.spec.ts | 0 | 5 | 5 passed (13.1 s) | 14 s | 7 |
| 18 (GREEN, RED waived) | contact-notes-conflict.spec.ts | 0 | 1 | 1 passed (11.1 s) | 12 s | 7 |

## 3. Byte checks

- `cmp` of each S7b new file against `sed -n '<first>,<last>p'` of its plan
  block: IDENTICAL for `useRankingRuns.test.tsx` (33044-33235),
  `useRankingRuns.ts` (33250-33453), `RankingRunViews.test.tsx`
  (33492-33845), `RankingRunList.tsx` (33860-33986), `RankingCostTotals.tsx`
  (33992-34068), `RankingRunDetail.tsx` (34074-34232),
  `RankingsSection.test.tsx` (34271-34410), `RankingsSection.tsx`
  (34425-34522), `e2e/fixtures/ranking.ts` (34570-34672),
  `contact-notes-conflict.spec.ts` (35230-35341). DIFFERS only by the
  WL-S7-3 edits: `rankings.spec.ts` (34693-34965; section 5).
- Every plan block was copied with `sed -n` (G2). Only `rankings.spec.ts`
  holds backslashes (5 lines: `escapeRegExp`, the cost and environment
  regexes, the two templates-URL regexes); `grep -nF '\'` showed all five
  intact after the copy and after the WL-S7-3 edits (none of which touched a
  backslash line).
- The `selectors.md` row was inserted byte-exact from plan line 34686 (an
  awk insert before the anchor row; the diff is that one added line).
- Edited files (`settingsTabs.ts`, `settingsTabs.test.ts`,
  `SettingsPage.test.tsx`, `App.tsx`, `routes.test.ts`, `routes.ts`) match
  the plan's / the references' replacement text except as named in
  section 6.
- ASCII: `tr -d '\11\12\15\40-\176' | wc -c` = 0 on every new file; the
  plan's sweep `git diff -U0 404e039d -- dashboard e2e | grep '^+' | tr ...`
  = 0 (branch-wide, S1's dashboard lines included); the S7b commit messages
  = 0.

## 4. Watch items

- WI17 (roles) - DONE, both halves now. Dashboard: the tab is
  `{ id: 'rankings', label: 'Rankings', path: '/settings/rankings',
  adminOnly: true }` at `dashboard/src/routes/settings/settingsTabs.ts:28`,
  directly after `ai-runs` (:25); pinned by `settingsTabs.test.ts:68` (the
  new case: beside the AI run log, the exact entry, not in
  `visibleTabs(false)`) and the admin-only list at :30; `SettingsPage.test.tsx`
  shows it in the admin array (:67) and asserts no `Rankings` tab for a VA
  (:89). The route is inside `AdminRoute`: `dashboard/src/App.tsx:233-240`
  (`path="rankings"` at :234, the import at :41). e2e (run 15, test 5, as
  `va@example.com`): no `Rankings` tab on `/settings/templates`;
  `/settings/rankings` redirects to `/settings/templates` with no
  `Rankings` heading; `GET /api/admin/rankings/runs` 403 and
  `GET /api/admin/rankings/cost` 403 (app log: `/runs` 403, `/cost` 403,
  user-0002); `GET /api/rankings/tenant/contact-tenant-0001` 200,
  `POST .../rank` 202, `POST /__dev/ranking/tick` ok, `GET .../job` 200 with
  `job.status` `done`. The server half is S6's route tests.
- WI19 (e2e) - DONE.
  - Lean world (`app/src/lib/seed/lean.ts`): no available unit - unitA is
    `under_application` (:218), unitB `occupied` (:240); one searching
    tenant - Dario Reyes (`IDS.tenantOff`, :187), voucher size 1, Atlanta
    Housing Authority - kept out of every spec pool twice over: the spec
    properties accept voucher size 2 only and ONLY their run-unique
    authority (`pool.ts` `authorityAllows`: some mapped -> limited to those;
    a tenant whose authority does not fold-equal one is excluded). Tasha
    (`contact-tenant-0001`) is `placing` (:97); test 5 uses her only as an
    API anchor (C6), and her job finished `done` with no batches.
  - Every ranking test builds its fixtures through the API with
    `e2e/fixtures/ranking.ts`: `runUniqueAuthority` (POST
    /api/organizations, kind housing_authority), `createAvailableProperty`
    (POST /api/units + PATCH .../listing-status to available),
    `createSearchingTenant` (POST /api/contacts + PATCH housingAuthority),
    each with a run-unique authority (`Rank<x> Authority <stamp>`), line
    (`<stamp> Rank<x> ...`) and first name (`<Name><stamp>`).
  - Jobs run only through `rankingTick`: `git grep -n "__dev/ranking/tick" -- e2e`
    -> `e2e/fixtures/ranking.ts:26-27` (the only caller), the
    `rankings.spec.ts:6` header comment and the `e2e/support/selectors.md:125`
    seam row (WL-S7-5: every hit listed). The lane runs the fake driver with
    the worker poll off (prerequisite run 7), so "Waiting for a free slot"
    holds until the tick (`pressRank` asserts it in every UI test).
  - One reseed in `beforeAll` (`rankings.spec.ts:98`).
  - The legacy match row grep is S2's record: S2-report.md:282-288 (no hit
    in `e2e/`).
- WI16 / WI12 / WI13: S7a's records stand (S7a-report.md section 4). S7b's
  views compute no band, cap or out-of-date reason: `RankingRunDetail` shows
  the server's `band` through `bandLabel` and the server's `cappedAtRun`;
  the run list and cost only format.

## 5. WORKLIST items (S7b's)

- G1: honored. G2: section 3. G3: no comment in S7b's range states a
  ruling's old meaning (the S7.7-S7.9 comments name PR34, IR35, PR15, R2B6
  as the ruling texts say). G4: every RED quoted in section 2. G6: no
  `ANTHROPIC_*` value read, printed or used. G7: all long commands in the
  foreground with a hard timeout.
- WL-S7-2 - DONE in S7.11's commit (af93c0f6). E1 reference R2 taken in
  full: `e2e/performance/routes.test.ts:385` `'/rankings'` between
  `'/ai-runs'` and `'/numbers'` in the settings-children list (R2a);
  `:409-411` the comment and `'/settings/rankings'` in `excluded`, after the
  organizations pair (R2b); `e2e/performance/routes.ts:693-701` the
  `TODO(perf-pages-settings-rankings-surface)` directly after the
  organizations TODO (R2c; one comment widening, section 6 item 3). D7
  reference R2 differs only in the list position (after
  `'/organizations/:orgId?'`) and the comment wording; the list is an
  `includes()` filter, so position is cosmetic. Proven with the e2e
  workspace unit test: RED 1 failed / 29 passed with `"/rankings"`
  unlisted (run 12), GREEN 30 passed (run 13), whole e2e unit suite 509
  green (run 22). The issue file is S8's (WL-S8-14).
- WL-S7-3 - DONE in S7.10 (fae728b3), D7 reference R3 applied to test 1:
  first names `Areamatch<s>`, `Plain<s>`, `Haspets<s>` (variables `strong`,
  `good`, `capped` kept; `rankings.spec.ts:112-116`); the "not ranked yet"
  rows asserted per row BEFORE the press and the tick (:122-124, the plan's
  loop) and on the table after the press (:127); the table-wide
  `not.toContainText('not ranked yet')` moved up to directly after the
  job-status assertions (:135), so every later row assertion reads the
  re-read table; band per CELL (`rows.nth(1|2|3).getByRole('cell').first()`
  -> `Strong` / `Good` / `Weak`, :140-145) and the cap per CELL
  (`rows.nth(3).getByRole('cell').nth(2)` -> `Capped: requirement not met`,
  :146); the run detail per CELL (the strong pair's first cell `80`, the
  capped pair's `cell.nth(2)` `Capped`, :168-169). Green in run 15.
- WL-S7-5 - DONE: the WI19 grep record above lists every hit.
- WL-S7-6 - used: `e2e/support/selectors.md:125`, the dev-seam row (plan
  review BA7), inserted before the "plant an AGED message" row.
- WL-S7-7 - DONE: the one S7-caused red in another workspace (the perf
  route pin, `routes.test.ts`) was fixed in the same commit as its cause
  (S7.11); the whole dashboard suite (run 21), the whole e2e unit suite
  (run 22) and the root typecheck (run 19) are green with the slice
  applied. Checked by reading for e2e specs that could break on a new tab:
  `settings.spec.ts:38` checks named tabs are visible (not an exhaustive
  list) and no spec lists the settings tabs or the mobile options in full.
- WL-S7-1, WL-S7-4: S7a's (S7a-report.md section 5).

## 6. Deviations from the plan text

1. WL-S7-3 edits in `rankings.spec.ts` test 1 (section 5), with three short
   comments naming the WORKLIST item - WORKLIST-mandated. The capped CELL
   assertion on the ranking table (`cell.nth(2)`) is WL-S7-3's "band /
   capped per CELL"; R3's text spells out only the band cells there.
2. WL-S7-2 rides in S7.11's commit (`routes.test.ts`, `routes.ts`); the
   plan's Step 5 lists only the four dashboard files.
3. `routes.ts` TODO text (comment only): E1 R2c says the surface's GETs are
   "the runs list and the cost read on mount"; the page ALSO walks every
   unit and every tenant on mount (`useRankCandidates`: `getAllUnits({})` =
   GET /api/units, `getAllContacts({ type: 'tenant' })` = GET
   /api/contacts?type=tenant, every page), so the TODO names those too -
   whoever registers the surface needs them.
4. Commit timing for S7.10 (section 1 note): committed after the S7.11
   GREEN run, before S7.11's commit.
5. The S7.10 and S7.11 commit messages carry one extra body line naming the
   WORKLIST items; subjects are the plan's.
No one-value test fix; no plan expected value changed.

## 7. QUESTIONS

None.

## 8. N1 / PR13-PR16 / PR26 - S7.1's types against S5's and S6's committed code

Every field the page reads is what the server sends; no drift, nothing
fixed.

- Job view: `app/src/services/ranking/job.ts:229-243` `RankingJobView`
  (`status`, `generation`, `includeOlder`, `requestedAt`, `startedAt?`,
  `finishedAt?`, `poolSize?`, `batchCount`, `batchesDone: number[]`,
  `failedBatches`, `notScored: { candidateId, reason }[]` (PR13),
  `message?`) built by `jobView` :251-268 (`batchCount` 0 until built,
  derived `expired`) = `dashboard/src/api/types.ts` `RankingJobView`. No
  `anchorKind` / `anchorId` / `requestedBy` / `requestId` / `traceparent`
  (IR31).
- Read: `app/src/services/ranking/readRanking.ts:107-118` sends `anchor`,
  `job`, `rows`, `flags`, `poolWindowDays` (PR26, :353, :398, :497) and
  `poolTooLarge?: { size, message }` (PR16, :400); the anchor block
  :97-105 (`kind`, `id`, `display`, `anchorNotes`, `missing`,
  `cardChanged`); rows :74-87 (`candidateId`, `display`, `hasConsent?`,
  `priority?`, `notScored`, `match`, plus `tenantId`, `unitId`,
  `notRankedYet`, typed optional and unread on the page); match :58-72 (the
  page's `RankingMatchView` field for field).
- Runs list: `app/src/routes/adminRankings.ts:212-239` - a live row carries
  exactly `RankingRunListRowLive`'s fields plus `failure?` (:232), which
  the page type does not declare and the list does not show (S7a's note;
  harmless); an expired or unread row is `{ runId, expired: true }`;
  `nextCursor?`, `incomplete?: true` (PR34).
- Run detail: `adminRankings.ts:286-330` - pairs `candidateId`, `handle`,
  `display`, `returned`, `score?` / `band?` (only when returned and scored;
  `bandOf`, `weak` when `cappedAtRun`, PR7 / PR14), `cappedAtRun`,
  `capReason`, `for`, `against`, `missing` (the stored merged list, PR14),
  `unknowns`, `failedRequirements`, `fairHousingFlags`, `currentRunId`,
  `sinceRescored`; top-level `anchorDisplay` (PR14), `input`, `flags`,
  `currentUnavailable?`, `flagsUnavailable?`. `run` is the stored record
  less `inputGzip`, `itemId`, `handles`, `results` (:320), so `usage?`
  (`app/src/repos/rankingRunsRepo.ts:581`, IR35), `rawText?`,
  `inputOmitted?`, `matchesWritten?: { count, at }` (:596, PR15),
  `droppedUnlawfulFlags` and `environment` ride along. Two extra keys also
  ride along undeclared and unread: `kind: 'ranking'` and `expires_at`
  (rankingRunsRepo.ts:569, :601). Harmless.
- Cost: `adminRankings.ts:376-385` - `environment` (config.appEnv),
  `weeks` (week desc, environment asc), `totalUsd`, `truncated`,
  `incomplete?: true` = `RankingCostResponse`.
- Event: `app/src/lib/events.ts:356-363` `RankingUpdatedEvent` (the six
  keys; `batchesDone` a count, IR27) = the dashboard mirror (S7a, WI16).
- PR26: the checkbox reads the read's `poolWindowDays` (S7a); S7.12's RED
  is waived and the spec ran green against S1's form (run 18).

## 9. PR2 / PR9 - files

- PR9: both new specs are S7's - `e2e/tests/dashboard-next/rankings.spec.ts`
  and `e2e/tests/dashboard-next/contact-notes-conflict.spec.ts` - with the
  helper `e2e/fixtures/ranking.ts`. S7.12 ran green against S1's form
  (`ContactEditForm.tsx:137-138` `NOTES_STALE_COPY`, the panel :1264-1276,
  the textarea's `aria-describedby` :1285).
- PR2 / N6: files S7 touched outside `dashboard/src/routes/settings/rankings/`:
  `dashboard/src/api/types.ts`, `endpoints.ts`, `rankings.endpoints.test.ts`,
  `EventStreamProvider.tsx`, `useEventStream.test.tsx` (S7a);
  `dashboard/src/App.tsx`, `routes/settings/settingsTabs.ts`,
  `settingsTabs.test.ts`, `SettingsPage.test.tsx` (S7b). e2e:
  `fixtures/ranking.ts`, the two specs (PR2 "every new e2e spec and
  helper"); `support/selectors.md` (WL-S7-6); `performance/routes.ts`,
  `routes.test.ts` (WL-S7-2); `performance/mutationCatalog.ts`,
  `mutationCatalog.test.ts` (WL-S7-1, S7a). No other file.

## 10. For S8 - what S7 shipped

- Issue files (S8's, `docs/issues/`):
  - WL-S8-14: `perf-pages-settings-rankings-surface` is cited, with no issue
    file yet, by `e2e/performance/routes.ts:693` (the TODO, which points at
    `docs/issues/perf-pages-settings-rankings-surface.md`, :701) and
    `e2e/performance/routes.test.ts:410`. `scripts/issues.mjs` checks only
    issue frontmatter, so nothing fails meanwhile; file it from
    `perf-pages-settings-organizations-surface.md` (E1 reference R2d) and
    name the surface's four GETs as the TODO now does (runs, cost, the unit
    walk, the tenant walk).
  - `contact-edit-form-notes-save-drops-auto-lines`: the S7.12 spec's
    header says it closes this issue
    (`contact-notes-conflict.spec.ts:3-4`); the e2e proof is run 18. WL-S8-4:
    quote S1's copy as BUILT - `ContactEditForm.tsx:137-138`
    `NOTES_STALE_COPY` = "Nothing was saved. These notes were changed since
    you opened this form. The current notes are below, and your text is
    still in the box. Save again to replace them, or Cancel to keep them.";
    the spec asserts the sentence "These notes were changed since you
    opened this form." and "Nothing was saved.".
- RUNBOOK / GLOSSARY / gate sheet facts: the page is Settings > Rankings
  (`/settings/rankings`, admin only, beside the AI run log); its URL state
  is `rank=<kind>:<id>`, `older=1`, `from`, `to`, `anchor=<kind>:<id>` (the
  runs filter), `run=<runId>` (`RankingsSection.tsx` header comment); the
  lane seam row is `e2e/support/selectors.md:125`; staff copy says
  "property" (GLOSSARY). The page's region / control names for any doc or
  self-QA script: region "Rank this anchor", table "Ranking", status
  "Ranking job", region "Cost by week" ("Environment: <name>", table
  "Weekly ranking cost"), list "Ranking runs" (section "Ranking run list";
  buttons "Refresh", "Load more", "All anchors"; date inputs "From" /
  "To"), region "Ranking run detail" (table "Run pairs", region "Run
  failure", region "Open fair-housing flags", details "Raw model output" /
  "Input sent").
- e2e fixture exports (`e2e/fixtures/ranking.ts`): `rankingTick(request)`,
  `runUniqueAuthority(api, name)`, `RankingTenant`,
  `createSearchingTenant(api, { firstName, authority, pets?, notes?,
  areaPreference? })` (display `<firstName> Rankcand`),
  `createAvailableProperty(api, { line1, authority, area?, noPets? })`
  (landlord `contact-landlord-0001`, 2 BR, voucher [2], rent 1500-1600).
- The e2e specs leave their records in the lane (no cleanup, like the
  other specs that build through the API); the next reseed after
  `rankings.spec.ts` in file order is `relay-inbound-caller-identity.spec.ts`'s
  `beforeEach`, and the specs in between (`recording-range`,
  `relay-30003-retry`, `relay-connect-when-ready`, `relay-group-view`) read
  no tenant audience or available-property count.
- S9 gate note: the full `npm run e2e` was not run here (the orchestrator's
  gate). The two specs' single-spec runs took 14 s and 12 s wall on a quiet
  machine; `rankings.spec.ts` test 1 is `test.slow()`.

## 11. Untrimmed input

None new. The runs list's date inputs pass their value raw as `from` /
`to` (N9; the browser's date input yields `YYYY-MM-DD` or empty, and the
server trims and validates them, S6-report.md section 11); the URL params
are parsed by `parseAnchorParam` (S7a). No typed text reaches a store or a
server compare in S7b's range.
