# S7a slice report - Dashboard, tasks S7.1-S7.6 (WP1 B2a)

- Implementer: S7a child (Claude Opus 5.5), 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Range: 3aebab97 (the S6 report, the commit before S7.1) .. 5483c92a, plus
  this report's commit.
- Scope: plan section 11 - the slice head (Scope, Contradictions, Cross-slice
  notes; plan 30045-30312) and tasks S7.1-S7.6 (plan 30313-33029): the
  rankings wire types and endpoint functions, `ranking.updated` in the shared
  event stream, the page's copy and pure helpers, `useAnchorRanking`,
  `RankingTable`, and "Rank this anchor" (`RankAnchorPanel`,
  `useRankCandidates`). S7.7-S7.13 (runs list, run detail, the tab and route,
  the e2e specs, the close) are S7b's; the S7 slice report (S7.13) is S7b's
  and links this file.
- Spec: D12 (the event is a hint; the job read polled every 5 s while queued
  or running; the ranking re-read when the FINISHED batch count grows and
  once at the end), D18 (the panel half), D9 (the read rendered as given).
  Rulings in force: PR7, PR13, PR16, PR26, PR38, PR42, PR43. Watch items:
  WI16 (dashboard mirror), WI17 (the dashboard half lands with S7b).
  WORKLIST: section G (G3 named), WL-S7-1, WL-S7-4, WL-S7-7.
- Verdict: six tasks, one commit each, each RED for its stated reason and
  then GREEN. Every new file is byte-identical to its plan block (checked
  with `cmp` against `sed -n` of the plan ranges) except the two sanctioned
  WORKLIST edits (WL-S7-4: R4 in `RankAnchorPanel.tsx` and one added test
  case). The inserted blocks in `types.ts` and `endpoints.ts` match the plan
  except the four G3 comments. No one-value test fix. No QUESTION. Close
  evidence: root `npm run typecheck` exit 0; the WHOLE dashboard suite 279
  files / 5739 tests passed, exit 0; the WHOLE e2e workspace unit suite 22
  files / 509 tests passed, exit 0; eslint on all 17 touched ts/tsx files
  exit 0; ASCII 0 on every added line and every commit message.

## 1. Tasks and commits

All paths under `dashboard/src/` unless named otherwise.

| Task | Commit | Files |
|---|---|---|
| S7.1 rankings wire types and endpoint functions (+ WL-S7-1) | 882055bc | `api/types.ts`, `api/endpoints.ts`, `api/rankings.endpoints.test.ts` (new), `e2e/performance/mutationCatalog.ts`, `e2e/performance/mutationCatalog.test.ts` |
| S7.2 `ranking.updated` in the shared event stream | 94b0c53b | `api/EventStreamProvider.tsx`, `api/useEventStream.test.tsx` |
| S7.3 the Rankings page's copy and pure helpers | cf1f8607 | `routes/settings/rankings/rankingFormat.ts`, `rankingFormat.test.ts` (both new) |
| S7.4 `useAnchorRanking` - read, press, 5 s job poll, event | 0e136b67 | `routes/settings/rankings/useAnchorRanking.ts`, `useAnchorRanking.test.tsx` (both new) |
| S7.5 `RankingTable` | 223bb953 | `routes/settings/rankings/RankingTable.tsx`, `RankingTable.test.tsx`, `RankingsSection.module.css` (all new) |
| S7.6 "Rank this anchor" (+ WL-S7-4) | 5483c92a | `routes/settings/rankings/useRankCandidates.ts`, `useRankCandidates.test.tsx`, `RankAnchorPanel.tsx`, `RankAnchorPanel.test.tsx` (all new) |
| report | this commit | `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/slices/S7a-report.md` |

File ownership: every dashboard file is PR2's S7 list (the rankings page
under `dashboard/src/routes/settings/rankings/`, the API client and types,
`EventStreamProvider`) and N6's named list; the two e2e performance files are
WL-S7-1's allowance. No other file was touched. Diff over the range: 18
files (16 dashboard, 2 e2e).

## 2. Test commands and counts (every run, in order)

Dashboard form: `cd W:/tmp/wp1-b2-ranking-engine/dashboard && npx vitest run <files>`.
e2e unit form: `cd W:/tmp/wp1-b2-ranking-engine/e2e && npx vitest run <files>`.
No `npm ci`, `npm install` or `npm run db:start` was run (G1). Every command
ran in the foreground with a hard timeout; nothing was left running (G7).

1. Baseline `performance/mutationCatalog.test.ts` (e2e): 4 passed.
2. S7.1 RED `src/api/rankings.endpoints.test.ts`: 5 failed (5) - each
   "TypeError: startRanking / getRanking / getRankingJob / listRankingRuns /
   getRankingRun is not a function" (the stated reason: not exported).
3. S7.1 GREEN `rankings.endpoints.test.ts types.test.ts endpoints.test.ts`:
   3 files, 104 passed (5 + 40 + 59; the two existing files PIN).
4. WL-S7-1 RED `performance/mutationCatalog.test.ts`: 1 failed, 3 passed -
   "expected [ Array(123) ] to have a length of 122 but got 123" (the scanner
   found `startRanking`; D7-1 reproduced).
5. WL-S7-1 GREEN `performance/mutationCatalog.test.ts performance/firewall.test.ts`:
   2 files, 23 passed (4 + 19).
6. e2e workspace unit suite (`npx vitest run`, all of `performance/**` and
   `support/**`) after S7.1: 22 files, 509 passed.
7. S7.2 RED `src/api/useEventStream.test.tsx`: 1 failed, 14 passed - the new
   case only, "expected "spy" to be called with arguments: [ { anchorKind:
   'unit', ... } ]" (no `ranking.updated` listener).
8. S7.2 GREEN: 15 passed.
9. S7.3 RED `rankingFormat.test.ts`: 1 file failed, no tests - "Failed to
   resolve import "./rankingFormat.js" ... Does the file exist?" (G4 wording
   of the stated missing module).
10. S7.3 GREEN: 15 passed.
11. S7.4 RED `useAnchorRanking.test.tsx`: no tests - "Failed to resolve import
    "./useAnchorRanking.js"".
12. S7.4 GREEN: 15 passed. One stderr line, benign: "An update to Probe
    inside a test was not wrapped in act(...)" in the last case ("returns the
    read window, and keeps the last one while a new read loads") - the
    plan's test ends with its second read still in flight; the case passes.
    Left as written (no deviation taken).
13. S7.5 RED `RankingTable.test.tsx`: no tests - "Failed to resolve import
    "./RankingTable.js"".
14. S7.5 GREEN: 7 passed. (Before the CSS was written, every `var(--...)`
    token the module uses was checked present in `ui/tokens.css`: none
    missing.)
15. S7.6 RED `useRankCandidates.test.tsx RankAnchorPanel.test.tsx`: 2 files
    failed, no tests - "Failed to resolve import "./RankAnchorPanel.js"" and
    "./useRankCandidates.js"".
16. S7.6 on the plan's VERBATIM code (before R4): 1 failed, 23 passed - only
    the added WL-S7-4 case, at `RankAnchorPanel.test.tsx:149` (after the
    rerender with no anchor): the Tenant radio is not checked (the kind fell
    back to `'unit'`), D7-7's defect reproduced.
17. S7.6 GREEN after R4
    `useRankCandidates.test.tsx RankAnchorPanel.test.tsx UnitSearchField.test.tsx ContactSearchField.test.tsx`:
    4 files, 64 passed (2 + 22 + 15 + 25; the two field suites PIN).
18. `npx eslint` from the worktree root, per task (S7.1-S7.3 files together,
    S7.4, S7.5, S7.6) and once over all 17 touched ts/tsx files at the
    close: exit 0 every time (no disable comment added).
19. Root `npm run typecheck` (bare): exit 0 (app, dashboard, e2e,
    fake-twilio, fake-twilio-web).
20. Whole dashboard suite (`npx vitest run` in `dashboard/`): 279 files,
    5739 passed, exit 0.
21. e2e workspace unit suite again at the close: 22 files, 509 passed,
    exit 0.

## 3. Byte checks

- `cmp` of each new file against `sed -n '<first>,<last>p'` of its plan
  block: IDENTICAL for `rankings.endpoints.test.ts`, `rankingFormat.test.ts`,
  `rankingFormat.ts`, `useAnchorRanking.test.tsx`, `useAnchorRanking.ts`,
  `RankingTable.test.tsx`, `RankingsSection.module.css`, `RankingTable.tsx`,
  `useRankCandidates.test.tsx`, `useRankCandidates.ts`. DIFFERS only by the
  sanctioned edits: `RankAnchorPanel.tsx` (R4, 1 line -> 3, byte-identical
  to D7 reference R4) and `RankAnchorPanel.test.tsx` (the added WL-S7-4
  case, 14 lines).
- `types.ts` inserted block (after `AiRunDetailResponse`, lines 410-720) vs
  plan 30426-30730: only the four G3 comments differ (section 5).
  `endpoints.ts` inserted block (after `getAiRun`) vs plan 30769-30860:
  identical; the import list edit is the plan's.
- No plan block in this range contains a backslash (`grep -cF` 0), so G2's
  escape trap does not arise; every block was still copied with `sed -n`.
- ASCII: `tr -d '\11\12\15\40-\176' | wc -c` = 0 on every new file, on the
  added lines of the whole range (`git diff -U0 3aebab97..HEAD`), and on the
  six commit messages.

## 4. Watch items

- WI16 (the event's key set; dashboard mirror). `RankingUpdatedEvent` in
  `api/types.ts:712` carries exactly `anchorKind, anchorId, generation,
  status, batchesDone, batchCount`, matching `app/src/lib/events.ts:356`
  (status `queued|running|done|failed`). The S7.2 case dispatches that
  six-key payload. The page never reads the counts: `useAnchorRanking.ts:198`
  only compares the anchor and then reads the job. The server-side key-set
  assertion is S5's. RESULT: consistent.
- WI17 (roles). Server half is S6's. In this range: the S7.1 endpoint
  comments state the split (press, read and job read are admin AND va; runs,
  run detail and cost are admin only), and the panel and its hook call only
  the va-allowed three (`startRanking`, `getRanking`, `getRankingJob`). The
  dashboard half - the admin-only `rankings` settings tab routed inside
  `AdminRoute` and its tests (C7) - is S7.11, S7b's. RESULT: open for S7b.
- WI12 / WI13 (one band, one cap; PR7). The page computes no band, cap or
  out-of-date reason: `rankingFormat.ts` only maps the server's values to
  labels; a grep of `routes/settings/rankings/` (non-test) for score
  comparisons, the 80/60/40 thresholds, `bandOf` or `capOf` finds nothing.
- WI19 (e2e). Not in this range (S7.10, S7.13).

## 5. WORKLIST items

- G1: honored (no install, no `db:start`).
- G2: every block copied with `sed -n` and checked (section 3).
- G3 (PR42) - APPLIED in S7.1, `api/types.ts`. The plan's job-view comments
  said `failedBatches` holds failed CALLS only. Rewritten to the ruling's
  meaning, matching S5's code (`runBatch.ts:175, 255, 263, 332-337`):
  - `RankingNotScored`: "A candidate the job left without a new match
    OUTSIDE failedBatches: the model did not return it, or a record could
    not be read (plan PR13, PR38, PR43)." ('unreadable' comes from the
    anchor's own record - PR38 / PR43 - or a candidate whose card read was
    incomplete - PR13; `job.ts:371, 399`.)
  - `batchesDone`: "Indexes of the batches that scored: the call succeeded
    and its matches were written, all or some. A partial match write's index
    is in failedBatches too (plan PR37, PR42)." D7-5 suggested "whose call
    succeeded"; S5 records `batchDone` only when no match write failed
    entirely (`written > 0` on a partial write), and a successful call whose
    RUN write failed is in `failedBatches` only, so the wording above is the
    exact one.
  - `failedBatches`: "Every batch that left candidates without a new match
    through a failure - the model call, the run write or the match write -
    each listing exactly those candidates and its failure kind (plan
    PR42)."
  - `notScored`: "Candidates left without a new match outside failedBatches
    (plan PR13)."
  The `rankingFormat.ts` comments already followed PR42 (unchanged).
- G4: every RED was for its stated reason (section 2); vitest 3.2.6 words
  a missing module "Failed to resolve import ... Does the file exist?".
- G6: no `ANTHROPIC_*` value read, printed or used.
- G7: all long commands foreground with a hard timeout.
- WL-S7-1 - DONE in S7.1's commit (882055bc).
  `e2e/performance/mutationCatalog.ts:149-152` (D7 reference R1 text: the
  comment and `entry(ENDPOINTS, 'startRanking', 'request:POST',
  '/api/rankings/:kind/:anchorId/rank')`, placed after
  `applyLandlordRequirements`); `mutationCatalog.test.ts:384-385` (the
  `+ startRanking` comment line and the pin 122 -> 123). Evidence: runs 4-6
  and 21. E1 reference R1 placed the entry after `createRelayGroup` and wrote
  `:anchorKind` in the test comment; D7's placement and `:kind` were taken
  (the catalog test compares SORTED fingerprints, so position is cosmetic,
  and `:kind` is the category the scanner derives). The stale "120 = ..."
  comment line at `mutationCatalog.test.ts:367` was left as it was (it
  already lagged the 122; E1 calls it cosmetic).
- WL-S7-4 - DONE in S7.6 (5483c92a). `RankAnchorPanel.tsx:69-71` is D7
  reference R4 verbatim (`useState<RankingAnchorKind>(() => anchor?.kind ??
  'unit')` with its two-line comment). Test:
  `RankAnchorPanel.test.tsx:140` "a tenant anchor from the URL stays on
  Tenant when its field is cleared (WORKLIST WL-S7-4)" - renders with a
  tenant anchor, presses "Clear Tenant to rank", expects
  `onAnchorChange(undefined)`, rerenders with no anchor (the section owns
  the URL), and expects the Tenant radio checked, the "Tenant to rank"
  combobox empty and no "Property to rank" combobox. RED on the plan's code
  (run 16), GREEN with R4 (run 17). Every plan case still holds.
- WL-S7-7 - honored: the whole dashboard suite (run 20), the whole e2e unit
  suite (runs 6, 21) and the root typecheck (run 19) are green with this
  range applied; the one S7.1-caused red (the catalog pin) was fixed in the
  same commit.
- WL-S7-2, WL-S7-3, WL-S7-5, WL-S7-6: S7b's (S7.10, S7.11, S7.13).

## 6. Deviations from the plan text

1. G3 comment rewrites in `api/types.ts` (section 5) - WORKLIST-mandated.
2. S7.1's commit also carries the two e2e performance files (WL-S7-1); the
   plan's Step 5 lists only the three dashboard files.
3. WL-S7-4: R4 in `RankAnchorPanel.tsx` and one added test case in
   `RankAnchorPanel.test.tsx` (22 cases where the plan has 21).
4. The S7.1 and S7.6 commit messages carry one extra body line naming the
   WORKLIST items; subjects are the plan's.
No one-value test fix was needed; no plan expected value changed.

## 7. QUESTIONS

None.

## 8. For S7b - what S7a shipped (exact names)

- `dashboard/src/api/types.ts` (re-exported by `api/index.ts`):
  `RankingAnchorKind`, `RankingAnchorRef`, `RankingDirection`, `RankingBand`,
  `RankingJobStatus`, `RankingAnchorNote`, `RankingOutOfDateReason`,
  `RankingReasonSource`, `RankingDriverKind`, `RankingReason`,
  `RankingMissingFlag`, `RankingMissingItem`, `RankingFairHousingFlag`,
  `RankingFailedBatch`, `RankingNotScored`, `RankingJobView`,
  `RankJobResponse`, `RankingJobResponse`, `RankingMatchView`,
  `RankingRowView`, `RankingUnlawfulFlagView`, `RankingAnchorView`,
  `RankingReadResponse`, `RankingRunListRowLive`, `RankingRunListRow`,
  `RankingRunListPage`, `RankingRunView`, `RankingRunPair`,
  `RankingRunDetailResponse`, `RankingCostWeek`, `RankingCostResponse`,
  `RankingUpdatedEvent` - exactly the plan's shapes (N1).
- `dashboard/src/api/endpoints.ts`: `startRanking(kind, anchorId, {
  includeOlder })`, `getRanking(kind, anchorId, { includeOlder }, signal?)`
  (sends `includeOlder: 'true'` only when on), `getRankingJob(kind,
  anchorId, signal?)`, `listRankingRuns({ from?, to?, anchorKind?,
  anchorId?, cursor?, limit? } = {}, signal?)`, `getRankingRun(runId,
  signal?)`, `getRankingCost({ from?, to? } = {}, signal?)` (sends
  `{ from, to }`, undefined dropped by the client).
- `EventStreamHandlers.onRankingUpdated` and the `ranking.updated` listener
  (`api/EventStreamProvider.tsx:67, 244-248`).
- `routes/settings/rankings/rankingFormat.ts`: `NOT_RANKED_YET`,
  `NOT_SCORED`, `bandLabel`, `cappedText`, `outOfDateText`, `reasonsText`,
  `ANCHOR_NOTE_TEXT`, `directionLabel`, `formatCost`, `isJobLive`,
  `notScoredCount`, `finishedBatchCount`, `jobStatusText`,
  `currentMatchText`, `anchorParam` / `parseAnchorParam` (`<kind>:<id>`).
- `routes/settings/rankings/useAnchorRanking.ts`: `JOB_POLL_MS` (5000),
  `RankingReadStatus`, `AnchorRankingState`, `useAnchorRanking(anchor,
  includeOlder)`.
- `routes/settings/rankings/RankingTable.tsx`: `RankingTable({ rows,
  anchorKind })` - table `aria-label="Ranking"`, first column header Tenant
  (unit anchor) / Property (tenant anchor), name in the row header, cells in
  the order Band, Score, Capped, Out of date, Reasons, Missing; an empty pool
  reads "No candidates are in this pool.".
- `routes/settings/rankings/RankingsSection.module.css` EXISTS (S7.5) with
  every class S7.7-S7.9 use (`page`, `header`, `heading`, `lede`, `runs`,
  `listPane`, `detailPane`, `listHeader`, `filters`, `dateLabel`,
  `dateInput`, `filterChip`, `rows`, `runRow`, `runTime`, `outcome`,
  `expired`, `detailHeader`, `block`, `failure`, `raw`, `loadMore`, `error`,
  `note`, `empty`, ...). Do not create it again; edit only if a task says so.
- `routes/settings/rankings/useRankCandidates.ts`: `RankCandidates`,
  `useRankCandidates()` (loads every unit and every tenant).
- `routes/settings/rankings/RankAnchorPanel.tsx`: `RankAnchorPanelProps {
  anchor, includeOlder, onAnchorChange, onIncludeOlderChange, onShowRuns }`,
  `RankAnchorPanel`. Accessible names the e2e can use: region and heading
  "Rank this anchor"; radiogroup "Anchor type" with radios "Property" /
  "Tenant"; comboboxes "Property to rank" / "Tenant to rank" (clear buttons
  "Clear Property to rank" / "Clear Tenant to rank"); checkbox "Include
  tenants not heard from in N days" (property anchor, shown once a read
  answered); button "Rank" ("Starting..." while the press is in flight;
  disabled with no anchor or while the job is live); button "Show runs for
  this anchor"; status "Ranking job"; list "About this anchor"; read error
  alert with a "Retry" button; spinner "Loading the ranking"; the hint "Pick
  a property or a tenant to see its ranking.". The panel's kind is seeded
  from the anchor (WL-S7-4).
- e2e: the mutation catalog already holds `startRanking` (123). Do NOT add
  it again. WL-S7-2 (the route pin in `routes.test.ts` / `routes.ts`) is
  still S7.11's.
- Server facts to keep in mind (S6 report section 8): a live runs-list row
  also carries `failure?`, which `RankingRunListRowLive` (plan text) does
  not declare - harmless unless the list wants to show it; the 409 body has
  `message` equal to the hook's own copy; any other non-2xx is "try again".
- Dashboard suite total with S7a applied: 279 files / 5739 tests, green -
  S7.11 will break `settingsTabs.test.ts` and `SettingsPage.test.tsx` by
  design (C7) and must update both in the tab's commit.

## 9. Untrimmed input

None new. The panel's search fields filter client-side lists (C3) and commit
an id from a picked option; no typed text reaches a store or a server compare
in this range.
