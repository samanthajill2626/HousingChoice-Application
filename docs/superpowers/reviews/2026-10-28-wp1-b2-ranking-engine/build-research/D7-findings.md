# D7 findings - S7 Dashboard and e2e (S7.1-S7.13)

- Reader: D7 (read-only delta reader, B2a build Phase 1).
- Scope: plan section 11, S7 "Dashboard and e2e": contradictions C1-C7,
  cross-slice notes N1-N10, tasks S7.1-S7.13 - the rankings wire types and
  endpoint functions, `ranking.updated` in `EventStreamProvider`,
  `rankingFormat`, `useAnchorRanking`, `RankingTable`, `RankAnchorPanel` +
  `useRankCandidates`, `useRankingRuns`, the runs list / cost totals / run
  detail, `RankingsSection`, the Rankings tab (admin only, `AdminRoute`),
  `e2e/fixtures/ranking.ts`, `rankings.spec.ts`, `contact-notes-conflict.spec.ts`,
  the slice gates. Spec D18, D12 (dashboard side), spec 6 e2e; WI17, WI19.
- Read: plan lines 1-590 (binding) and 30045-35513; the S1 edit-form text S7.12
  drives (plan 3280-3430), the S4 fake rules (20414-20640), the S5 job / tick /
  e2e-session text (21815-21830, 25360-25454, 26160-26563), the S6 wire and
  routers (26869-26930, 27560-27604, 28470-28716, 29277-29420); spec sections
  2, D1, D7, D9, D12, D18, D19, 6. Code: dashboard `api/{client,index,endpoints,
  types,EventStreamProvider,useEventStream}.ts(x)` and its tests,
  `routes/settings/{settingsTabs,SettingsPage,AdminRoute}` and tests,
  `aiRuns/{AiRunsSection,useAiRuns}`, `App.tsx`, `ui/{index,Button,Spinner,
  tokens.css,twoPaneShell}`, `routes/contact/{UnitSearchField,ContactSearchField,
  ContactEditForm,Card,format}`, `test/setup.ts`, `vite.config.ts`, tsconfigs;
  e2e `playwright.config.ts`, `vitest.config.ts`, `fixtures/{orgFixture,reseed}`,
  `support/{today,selectors.md,followUpFixtures}`, `tenant-staff-notes.spec.ts`,
  `ai-run-log.spec.ts`, `settings.spec.ts`, `scenarios/steps.ts` (edit-dialog
  selectors), `performance/{mutationCatalog,routes,firewall,collect}` and tests;
  app `routes/{contacts,units,statusTransition}.ts`, `lib/{unitFields,phone,
  statusModel,tenantMatchingInputs}.ts`, `middleware/auth.ts`, `lib/seed/lean.ts`,
  `eslint.config.mjs`, root/e2e `package.json`.
- Method beyond reading (scratch only, outside the worktree; details and
  byte-exact text in `.superpowers/sdd/research/D7-reference.md`): every S7
  block applied to a copy of the tree straight from the plan's fences (all 17
  replace anchors byte-exact with the expected counts); type-checked (tsc
  5.9.3, dashboard and e2e options), linted (repo eslint config, react-hooks
  rules proven live), run (vitest 3.2.6, jsdom, the repo setup file): the
  dashboard suite and the e2e unit suite (`performance/**`, `support/**`).
- Verdict: the dashboard half is build-ready as written (compiles, lints
  clean, all 268 S7-relevant dashboard tests and the whole 5750-test dashboard
  suite green, S7.11's RED reproduced), but `npm test` (gate 2) goes red in
  the e2e workspace on two hand-maintained pins the plan never mentions -
  0 BLOCKER, 2 MAJOR, 5 MINOR.

## Findings

### D7-1 - MAJOR - `startRanking` breaks the dashboard mutation catalog pin

- Plan: S7.1 Step 3(b) (lines 30775-30787, the new POST `startRanking`);
  S7.1 Step 4 (30866-30871) runs only dashboard tests; S7.13 Step 3
  (35398-35407); PR2's S7 list (234-236) does not include `e2e/performance/`.
- Code fact: `e2e/performance/mutationCatalog.test.ts:310-330` scans every
  non-test `dashboard/src` file for `request(...)` calls with a POST / PUT /
  PATCH / DELETE method; `:364-390` requires the hand list
  (`e2e/performance/mutationCatalog.ts:38-179`) to match it fingerprint for
  fingerprint and pins the count at `:384` (`toHaveLength(122)`). It runs in
  gate 2: root `npm test` = `npm run test --workspaces`; e2e `test` =
  `vitest run` over `performance/**/*.test.ts` (`e2e/vitest.config.ts`).
- Problem: run in scratch against the S7-applied dashboard it fails -
  "expected [ Array(123) ] to have a length of 122", and the discovered
  fingerprint `dashboard/src/api/endpoints.ts :: startRanking :: request:POST ::
  /api/rankings/:kind/:anchorId/rank` is missing from the catalog. Nothing in
  the plan, spec or records mentions the catalog. S7.13 Step 3 would surface
  it, but its triage rule ("Red with no connection to S7: record file, case
  and error") invites recording it rather than fixing it, and the file is
  outside S7's PR2 list - so it can reach S9's gate run red.
- Correction: S7.1 adds the catalog entry and bumps the count to 123 with a
  comment line (byte-exact text: reference R1; verified green 4/4 in
  scratch); its Files list gains `e2e/performance/mutationCatalog.ts` and
  `e2e/performance/mutationCatalog.test.ts` (planner: a PR27-style
  allowance); Step 4 adds
  `cd W:/tmp/wp1-b2-ranking-engine/e2e; npx vitest run performance/mutationCatalog.test.ts`;
  Step 5 commits both files.

### D7-2 - MAJOR - the new `rankings` route breaks the perf route-registry pin

- Plan: S7.11 Step 3(b) (lines 35139-35173, `<Route path="rankings">` in
  App.tsx); S7.11 Step 4 (35178-35195); C7 (30149-30152) names only two
  tests that enumerate settings tabs.
- Code fact: `e2e/performance/routes.test.ts:353-421` reads `App.tsx`,
  extracts every `<Route ... path="...">` (regex `:367`), maps only the listed
  Settings children (`:376-390`) to `/settings/...`, and requires the route
  set minus its `excluded` set (`:396-415`) to equal the profiler's
  `EXPECTED_KEYS`. Also gate 2 (same e2e vitest run).
- Problem: run in scratch with S7.11's App.tsx it fails - "expected [ '/',
  '/broadcasts', ...(27) ] to deeply equal [ ...(26) ]" with `+ "/rankings"`.
  The precedent for a new Settings tab (`/settings/organizations`) added the
  path to the Settings-children list and to `excluded`, and filed
  `docs/issues/perf-pages-settings-organizations-surface.md`.
- Correction: S7.11 adds `'/rankings'` to the children list and
  `'/settings/rankings'` (with an issue comment) to `excluded` (byte-exact
  text: reference R2; verified green 30/30 in scratch); Files list gains
  `e2e/performance/routes.test.ts`; Step 4 adds
  `cd W:/tmp/wp1-b2-ranking-engine/e2e; npx vitest run performance/routes.test.ts`;
  S8 (owner of `docs/issues/`, PR2) files
  `perf-pages-settings-rankings-surface.md` from the organizations precedent,
  or the planner rules the comment cites that issue. C7 should read "three".

### D7-3 - MINOR - e2e test 1's band and cap assertions can pass vacuously

- Plan: S7.10 `rankings.spec.ts` test 1 (lines 34804-34806 names,
  34823-34832 row assertions, 34852-34853 run-detail assertions).
- Code fact: the tenants are named `Strong<s> Rankcand`, `Good<s> Rankcand`,
  `Capped<s> Rankcand` and `toContainText` is a substring match, so
  `rows.nth(1)` "Strong", `rows.nth(2)` "Good" and the run-detail row
  "Capped" are satisfied by the NAME; "80" is satisfied whenever the 6-digit
  stamp holds "80". S6's `sortRows` keeps unmatched rows in pool order
  (plan 27586-27604), and the `not.toContainText('not ranked yet')` guard
  is the LAST row assertion (34832) - so rows 1-2 can be checked against the
  stale pre-tick table and never re-checked after the re-read.
- Problem: a wrong area bonus (the strong tenant at 70 Good) or a wrong
  strong/good order passes whenever pool order happens to equal creation
  order; only "the capped pair last" is really proven.
- Correction: band-free first names, the "not ranked yet" guard moved up to
  right after the job-status assertions, and cell-level band / score / cap
  assertions (reference R3). Tests 2-4 are not affected (their names and
  street lines hold no band word).

### D7-4 - MINOR - S7.13's WI19 grep record cannot come out as written

- Plan: S7.13 Step 5 (lines 35432-35433): "`git grep -n "__dev/ranking/tick"
  -- e2e` lists only fixtures/ranking.ts".
- Fact: the same grep also lists `e2e/tests/dashboard-next/rankings.spec.ts`
  (its header comment, plan 34698-34699) and `e2e/support/selectors.md` (the
  seam row S7.10 adds, plan 34686, two hits) - confirmed on the scratch tree.
- Correction: record those three files and state that the only CALLER is
  `rankingTick` in `fixtures/ranking.ts` (e.g. grep `post(.*__dev/ranking/tick`
  over `e2e/`, which lists only the fixture).

### D7-5 - MINOR - the job-view JSDoc still says "failed calls only" (PR42 drift)

- Plan: S7.1 types (lines 30500-30503) and N1 (30172-30174).
- Fact: PR42 (556-562) - `failedBatches` holds every batch that left
  candidates without a new match (a failed call, run write or match write);
  a partial match write's index is in BOTH `batchesDone` and
  `failedBatches` (N1's own round-2 paragraph, 30250-30253). S7.1's JSDoc says
  "Indexes of the batches that SCORED; a failed call is in failedBatches" and
  "Failed CALLS only (plan PR13)". The code (`finishedBatchCount`,
  `notScoredCount`) already follows PR42; only the comment misleads.
- Correction: `batchesDone` - "Indexes of the batches whose call succeeded (a
  partial match write's index is in failedBatches too)"; `failedBatches` -
  "Every batch that left candidates without a new match: a failed call, run
  write or match write (plan PR42)".

### D7-6 - MINOR - S7.10's RED reason names the wrong render

- Plan: S7.10 Step 2 (lines 34975-34979): "/settings/rankings has no child
  route yet, so the settings Outlet renders nothing".
- Fact: with no child route the URL matches the authed app's catch-all
  `<Route path="*" element={<Placeholder title="Not found" />} />`
  (`dashboard/src/App.tsx:281`); SettingsPage does not render at all. The
  failing assertions are the ones stated (no Rankings heading; the VA's URL
  stays `/settings/rankings`).
- Correction: reword to "renders the Not found placeholder", so a builder
  reading the RED trace does not chase an empty Outlet.

### D7-7 - MINOR - a reloaded tenant anchor flips to Property when cleared

- Plan: S7.6 `RankAnchorPanel.tsx` (lines 32877-32880).
- Fact: `chosenKind` always starts `'unit'`; `kind` is `anchor?.kind ??
  chosenKind`. On `?rank=tenant:<id>` (a reload), the field's Clear button
  (ContactSearchField `handleClear` -> `onChange({ name: '' })` ->
  `typeQuery('')` -> `onAnchorChange(undefined)`) leaves `kind` = `'unit'`:
  the radio jumps to Property and the property search replaces the tenant
  search.
- Correction: seed the state from the anchor (reference R4); no S7.6 test
  changes.

## Checked and fine

- Anchors: all 17 S7 replace anchors (types.ts, endpoints.ts x2,
  useEventStream.test.tsx x2, EventStreamProvider.tsx x3, settingsTabs.test.ts
  x3 incl. the replace-all pair, SettingsPage.test.tsx x2, settingsTabs.ts,
  App.tsx x2, selectors.md) are byte-exact with the counts the plan assumes;
  S1's types.ts edits (plan 1932-1947, 2927-2941, 3226+) leave S7.1's
  `AiRunDetailResponse` anchor untouched.
- Typecheck: the whole dashboard `src` with S7 applied, and the three new e2e
  files, compile with 0 errors under the repo options
  (`noUncheckedIndexedAccess`, bundler / NodeNext).
- Lint: every new and edited S7 file is clean under the repo config,
  including the React Compiler rules on `useAnchorRanking.ts`,
  `useRankingRuns.ts`, `useRankCandidates.ts` (no disable comment needed).
- Dashboard tests: the 17 S7-relevant files pass as written (268 tests);
  every hand-worked status line, count, cost string and cell array holds;
  the full dashboard suite stays green; S7.1-S7.9 RED reasons are missing
  modules or the stated missing listener; S7.11's RED is exactly the three
  order arrays, the admin-only list and the new case.
- Client conventions: `request(path, { method, body, query, signal })`,
  `query` drops undefined; `ApiError(status, code, message, body)` with
  `code` = the body's `error` (`client.ts:22-33, 75-83`), so 409
  `ranking_running`, 429 and the 503 `message` read as the hook expects.
- Wire contract vs S5/S6: `RankingJobView`, `RankingUpdatedEvent`, the read
  body (`poolWindowDays`, `poolTooLarge { size, message }`, rows with
  `notScored` and `match`), runs rows, run detail (`anchorDisplay` top level,
  pairs `returned`/`missing`/`cappedAtRun`/`currentRunId`, arrays defaulted
  by S6), cost (`environment`, `weeks`, `totalUsd`, `truncated`,
  `incomplete`), `matchesWritten { count, at }`, usage names, reason sources
  (= spec D5's enum) all match; the SSE name is `ranking.updated`.
- Reused components: `UnitSearchField` / `ContactSearchField` props (`value`,
  `onChange`, `candidates`, `inputLabel`), role combobox named by
  `inputLabel`, portaled options; `getAllUnits({}, signal)` /
  `getAllContacts({ type: 'tenant' }, signal)`; `Button` / `Spinner` props;
  every CSS token in `RankingsSection.module.css` exists in `ui/tokens.css`;
  860 px = `TWO_PANE_BREAKPOINT_PX`; no page width cap.
- Settings / WI17: tab model, `visibleTabs`, `AdminRoute` redirect to
  `/settings/templates`, `requireRole('admin')` answers 403, VA dev user
  `va@example.com` (role `va`), no scope enforcement on `/api`; no other
  dashboard test or e2e spec counts the tabs exactly (`settings.spec.ts`
  loops named tabs only).
- e2e fixtures vs the API: POST /api/contacts accepts `type`, names, `phone`,
  `voucherSize`, `status: 'searching'`, `pets`, `notes`, `area_preference`
  and answers 201 `{ contact }`; the PATCH runs the org-list check on
  `housingAuthority`; POST /api/units accepts `voucher_size_accepted`,
  `accepted_authorities` (org-checked), `area`, `no_pets`, `rent_min/max`
  with landlord `contact-landlord-0001` (no requirements to inherit); the
  listing-status flip is the `followUpFixtures.ts` precedent; `addOrg`,
  `reseed`, `expectTodayReady`, the dev-login and `E2E_DASHBOARD_URL`
  patterns all exist.
- e2e expectations vs S4/S5/S6 behavior: fresh tenants fall in the 90-day
  window via `created_at`; run-unique authorities on both sides keep each
  pool to its own records and exclude Dario (size 1) and Tasha; fake scores
  80 Strong / 70 Good / 45 capped Weak; one batch (size 40); an all-failed
  batch finishes `done` with S5's count message, so "Done: 1 batch; 2
  candidates not scored" holds; Tasha's empty pool finishes `done`; the tick
  answers `{ ok, expired, claimed, tookOver, failedStale }` after its jobs;
  rate limit 6/min per user covers the spec's 4 + 1 presses; expect timeout
  15 s covers the 5 s poll.
- S7.12 vs S1: the conflict panel is `role="alert"` with
  `NOTES_STALE_COPY` (holds both asserted sentences) and the current notes;
  the dialog is `Edit contact`, opened by the `Edit contact details` card
  action; Notes is a wrapping label (`/^Notes/`); the only exact `Save`
  button on the page with the editor closed is the form's.
- ASCII: every S7 line in the plan and every new file is ASCII.
