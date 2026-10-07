# Planner fix wave - feat/tour-list (planner review, phase 6)

Implementer: Claude Opus 5.5, 2026-10-06. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD e666fae3 (the planner-review records),
ended at cab09c9c (plus this report's commit). Scope: `adjudications.md` in
this directory - SC-F1, SC-F2, E-1, ADV-F2 (the memo only), ADV-F4, and the
two issue appends (ADV-F2's deferred part, ADV-F3, ADV-F4's severity note).
ADV-F1 and ADV-F5 (REJECTED) were not touched.

Method: SC-F2 ran TDD (RED for the finding's reason, then the fix, GREEN).
SC-F1 (the code was already right) ran GREEN on the real guard, then RED
under one hand mutant, restored with the Edit tool. ADV-F2 is
behavior-neutral: the tours test directory was the guard, and a temporary
local probe measured the derivations before and after. DynamoDB Local (the
shared container) was up throughout and never restarted; no captured run
held a `[dynamoAdmin]` line. Every pre-commit check: a separate bare
`git status`, `MERGE_HEAD` absent, explicit paths only, and 0 non-ASCII
bytes in added lines.

## Commits

| item | commit | message |
|---|---|---|
| SC-F2 | a653d944 | fix(dashboard): the All tab de-duplicates its first page too |
| SC-F1 | 8d6a1377 | test(dashboard): a Cmd-click and a Shift-click on a row write nothing |
| ADV-F2 | 775f719f | perf(dashboard): All tab row views derived once per page, not per keystroke |
| ADV-F4 | e84dfbfa | refactor(app): listByScheduledRange's test knob is queryLimit, with the repo's logger |
| E-1 | a2ac6144 | docs(glossary): name the retired label |
| appends | 0f6fc82b | docs(issues): costs at scale for the All tab search and the range read |
| ADV-F4 fix-up | cab09c9c | docs(app): queryLimit's docblock names the page-cap prefix |

## Per item

### 1. SC-F2 - the first page de-duplicates (a653d944)

- Test first (`useAllTours.test.ts`, in "the first page"): a first page of
  t1, t2, t3 and a second copy of t2 (status `toured`, a later `updatedAt`)
  yields ONE row per tour, the later copy's data in the first copy's
  position (index 1), and a complete list.
- RED: `expected [ 't1', 't2', 't3', 't2' ] to deeply equal [ 't1', 't2', 't3' ]`.
- Fix (`useAllTours.ts`): one helper, `mergeRows`, that both paths use -
  `freshState` builds the first page's rows through it, and `withPage`
  appends through it. The replace-in-place rule is unchanged; the helper's
  doc comment names both causes (a rescheduled tour between pages, a tour in
  two phases of one request, spec 5.3).
- GREEN: `useAllTours.test.ts` 37/37; the tours directory 19 files / 542
  tests. eslint on both files: exit 0, no finding, no suppression.

### 2. SC-F1 - Cmd- and Shift-click write nothing (8d6a1377)

- `AllToursView.test.tsx` (the case at :1179): adds a `metaKey` click and a
  `shiftKey` click after the Ctrl and Alt clicks, waits for FOUR jsdom
  navigation reports (was two), and keeps the case's assertions - the entry
  key, URL and null history state unchanged (no stamped replace). Renamed
  "a Ctrl-, Alt-, Cmd- (meta) or Shift-click writes nothing (the tour opens
  elsewhere)".
- On the real guard: 1 passed.
- Mutant: the `metaKey` term dropped from the guard (`AllToursView.tsx:442`)
  with the Edit tool -> RED at `AllToursView.test.tsx:1194`,
  `expected 'dye3nqi5' to be 'default'` (the Cmd-click stamped a REPLACE, a
  new entry key). Restored byte-identically with the Edit tool;
  `git diff -- dashboard/src/routes/tours/AllToursView.tsx` = 0 bytes.
- GREEN: the tours directory 19 / 542. eslint on the test file: exit 0.

### 3. ADV-F2 - row views memoized (775f719f)

- `AllToursView.tsx`: the row views are a `useMemo` on `[data.rows,
  data.contacts, data.units]`; `visible` (the search filter) stays a
  per-render filter over them. Those three are stable references between
  pages (the hook returns its state's arrays, or the module EMPTY), and the
  search text never enters the list key (`tourListApiParams`: "`q` is never
  sent"), so a keystroke leaves them unchanged.
- Lint: eslint (react-hooks `recommended-latest`, the compiler rules
  included) exit 0 on the first try - no `use-memo` /
  `preserve-manual-memoization` finding, no suppression, no restructure.
- How fewer derivations were verified: a TEMPORARY probe test, never
  committed - created in the tours directory, run, then moved out of the
  worktree to the session scratchpad before the commit (`git status` showed
  only `AllToursView.tsx`). It mocked `./tourTime.js` as the real module
  with `whenLabel` wrapped in a counter (`rowView` makes exactly one
  `whenLabel` call per row it derives), mounted ToursPage at `/tours/all`
  with a 200-row first page, typed 5 keystrokes, cleared the box, then ran a
  Load more of 200 more rows. No source file carried a counter.

  | phase | before (e666fae3 code) | after the memo |
  |---|---|---|
  | first page lands (200 rows) | 200 | 200 |
  | 5 keystrokes | 1000 | 0 |
  | clearing the search | 200 | 0 |
  | Load more click (in-flight toggle) | 200 | 0 |
  | Load more, click to landed (+200 rows) | 600 | 400 |

- Behavior: the tours directory 19 / 542 green after the memo, and again at
  0f6fc82b after the comment was tightened. Note for the re-review: the
  return-anchor layout effect lists `visible` as a dependency; with the memo
  `visible` is stable between pages while not searching. The effect is a
  one-shot per record, gated on `restoreOutcome` turning reached or capped -
  itself a dependency - so the identity churn it loses never triggered an
  anchor; every return-restore case passes.

### 4. ADV-F4 - `queryLimit`, with the repo's logger (e84dfbfa, cab09c9c)

- `app/src/repos/toursRepo.ts`: `pageLimit` renamed `queryLimit` in the
  `ToursRepo` interface and the implementation. The docblock says it is EACH
  Query's Limit, for tests that force paging, NOT a page cap (`queryAll`'s
  `maxPages` is), and that a small value bounds nothing - it multiplies the
  round trips and reaches that cap sooner, where the walk returns a PREFIX
  flagged only by a WARN. The `queryAll` call now passes `{ logger: log }`
  (`log` is `createToursRepo`'s logger local). `queryGsi` is untouched
  (pre-existing); the harness fake is untouched.
- `app/test/toursRepo.integration.test.ts`: the three uses (the comment at
  :244, the case name at :279, the call at :293) plus the prose beside them
  at :298 ("ignores the page limit" -> "the query limit").
- `git grep pageLimit -- app/src app/test dashboard/src e2e`: empty.
- GREEN: the integration file 79/79 against DynamoDB Local (no skips), the
  renamed case among them; again 79/79 at cab09c9c. `npm run typecheck`
  exit 0. eslint on both files: exit 0.

### 5. E-1 - the GLOSSARY names the retired label (a2ac6144)

- `documentation/GLOSSARY.md:367-368` now read: these two labels retire
  "Not booked", the single label every undated tour used to show (its
  record: the undated-tour-wording issue). That is the GLOSSARY's own form
  for a retired term - name it, say it is retired (`:111` the "stuck nudge"
  note, `:300` the `HCV` / `Section 8` / `VASH` labels).
- ASCII: lines 350-380 were all ASCII before and after; the file's 22
  non-ASCII lines (elsewhere) are untouched; added lines 0 non-ASCII bytes.
- The E-1 "not booked" grep check now EXCLUDES `documentation/GLOSSARY.md`
  and `docs/issues/`. With that exclusion,
  `git grep -n -i "not booked" -- documentation dashboard/src e2e app/src`
  minus the GLOSSARY is empty; the GLOSSARY's one hit is :367, the named
  retirement. The GLOSSARY was not grep-policed.

### 6. The two issue appends (0f6fc82b)

- `docs/issues/tours-all-server-side-search.md` gains "Costs at thousands of
  tours (2026-10-06, feat/tour-list planner review)": (1) every return to a
  SEARCHED All list re-runs the whole walk - about 250 requests for 8 opens
  at ~3,000 tours, a "Searching..." wait each time - with the two options (a
  short-TTL module cache of the last list keyed by the list key, the Past
  tab's batch store in `ToursPage.tsx` the precedent; or server-side
  search); (2) each landed walk page re-derives every loaded row (quadratic
  over a long walk; keystrokes no longer do since item 3), and module-level
  `Intl.DateTimeFormat` instances in `tourTime.ts` would cut the per-row
  cost. Its refs gain `tourTime.ts:62` and `ToursPage.tsx:324`.
- `docs/issues/tours-date-range-reads-unbounded-span.md` gains "Severity at
  scale (2026-10-06, feat/tour-list planner review)": the plan-blind
  reviewer's note (one request can materialize about 100 MB of tours in the
  API process and serialize one JSON body, blocking the event loop -
  availability, not only cost), and that the range read's test knob is now
  `queryLimit`, a per-Query Limit, so the bound belongs in `queryAll`'s
  `maxPages`. Its two `toursRepo.ts:417` refs (frontmatter and body) now
  read `:420` - item 4's docblock moved the method there.
- `npm run issues`: exit 0, "373 open, 196 closed, 569 total", open by
  severity 7 high / 147 med / 219 low, ZERO warnings. `INDEX.md` is
  gitignored (`.gitignore:62`) and was not added.

## Results at the end (HEAD cab09c9c)

- `npm run typecheck` (root, all workspaces): exit 0 - run after the last
  code edit (the cab09c9c docblock) and at 0f6fc82b.
- `npx eslint` on every touched TS/TSX file (the six above): exit 0, zero
  findings. Baseline on the same six paths at e666fae3: exit 0, zero
  findings. New: none. (`TourDetail.tsx`'s pre-existing
  `react-hooks/purity` is not in this set - the file was not touched.) The
  touched Markdown files are not lintable.
- Dashboard `src/routes/tours/`: 19 files / 542 tests, exit 0.
- App `test/toursRepo.integration.test.ts`: 79/79, exit 0.
- `npm run issues`: exit 0, no warnings.
- Not run (the orchestrator's): the full `npm test`, `npm run smoke`,
  `npm run e2e`, any Playwright or e2e session.

## Divergences from the adjudications, and why

- A SEVENTH commit, cab09c9c, a comment-only fix-up of item 4. e84dfbfa's
  docblock said a small value "only multiplies the round trips" - it also
  reaches the 100-page cap sooner and returns a prefix, the half of the
  ADV-F4 scenario that wording dropped. Amending was not possible (not HEAD)
  and history rewriting is barred, so it is a follow-up commit, kept to four
  lines so the method stays at `toursRepo.ts:420` (item 6's refs).
- Item 4 also renamed the prose "the page limit" at
  `toursRepo.integration.test.ts:298`, beside the three named uses - left
  as is, it would name the knob by its old, misleading reading.
- Item 6(a) names every sharer of the `tourTime.ts` formatters - the
  Active, Past and Closed tabs (`ToursPage.tsx`) and Today (`Today.tsx`
  imports `whenLabel`) - where the adjudication named Past and Closed; and
  it adds two refs to the frontmatter.
- Item 6(b) moved the issue's two `toursRepo.ts:417` refs to `:420`
  (stale after item 4).

## Open points

- `docs/issues/tours-scheduled-range-query-unpaginated.md` (RESOLVED) still
  says `pageLimit` in its Resolution block (lines 66 and 73), as do the
  dated spec and plan for this branch. They are historical records of what
  shipped then and were left alone (outside the six items); a reader who
  meets the old name there now finds the rename in
  `tours-date-range-reads-unbounded-span`.
- The probe is not in the repo; its numbers above are the only record.

## Gates (orchestrator)

(appended by the orchestrator after its verification run)
