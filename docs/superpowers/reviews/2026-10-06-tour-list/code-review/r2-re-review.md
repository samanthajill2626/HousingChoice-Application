# Code review r2 - fresh re-review (feat/tour-list @ b459de9f)

Reviewer: fresh round-2 reviewer (Claude Opus 5.5), 2026-10-06. Worktree
`W:\tmp\tour-list`, merge base main @d839494a. Inputs read in order: the two
r1 reports, the adjudications, the fix-wave report, the fix diff
(ae203afd..b459de9f), the live files, the spec where a rule was in question.
No round-1 participation.

**Summary: new findings 0 HIGH, 0 MEDIUM, 4 LOW (R2-1..R2-4). Fix diff: 9
items reviewed, 8 correct, 1 not a real regression guard (gap 4). Adjudications
contested: 3 (SC-1 severity, gap 4 scope, AD-1 scope - spec not amended); the
REJECT of AD-3 and the FILEs of AD-2 / AD-5 are upheld.**

Paths: `tLQ` = `app/src/lib/tourListQuery.ts`, `tLP` =
`app/src/services/tourListPage.ts`, `ATV` =
`dashboard/src/routes/tours/AllToursView.tsx`, `uAT` =
`dashboard/src/routes/tours/useAllTours.ts`, `tLS` =
`dashboard/src/routes/tours/tourListSelection.ts`.

## 1. New findings

### R2-1 [LOW] The SC-2 regex rejects legal ISO 8601 fractions and still admits impossible calendar dates

- Claim: `tLQ:75` allows at most 3 fractional digits, so a legal ISO 8601
  instant with microseconds - what Python's `datetime.isoformat()` and many
  API clients emit - is a 400; meanwhile a non-existent day passes the regex
  and `Date.parse` silently rolls it into the next month, the "same request,
  shifted window" class SC-2 set out to remove.
- Evidence: throwaway `app/test/zz-review-r2-iso.test.ts` (run, deleted)
  through `parseTourListQuery({ when: 'range', from })`:
  `2026-10-06T00:00:00.123456Z` -> 400, `...123456+00:00` -> 400,
  `...00.1234Z` -> 400 (V8 parses all three, truncating to ms);
  `2026-02-30T00:00:00Z` -> ok, from `2026-03-02T00:00:00.000Z`;
  `2026-04-31T00:00:00-04:00` -> ok, from `2026-05-01T04:00:00.000Z`. The
  dashboard form (`toISOString()`) passes.
- Blast radius: direct API callers only; the dashboard always sends 3-digit
  `Z` forms (`tLS:88-100`). No wrong answer reaches a staff screen.
- Smallest fix: fraction `(\.\d+)?`; then reject a date whose Y-M-D does not
  survive (e.g. the regex's `YYYY-MM-DD` against `Date.UTC(y, m - 1, d)`
  read back with `getUTCMonth()` / `getUTCDate()`); add both rows to parse
  case 9.

### R2-2 [LOW] The From-after-To message is invisible to assistive technology

- Claim: neither copy of "From must be on or before To." is announced or tied
  to the inputs. The under-inputs copy (`ATV:488`) and the new list-area copy
  (`ATV:575-579`) carry no role and sit outside every live region; the From /
  To inputs (`ATV:467-473`, `:479-485`) have no `aria-describedby` or
  `aria-invalid`; and the count region (`ATV:562`, `role="status"`) goes from
  "N tours" to EMPTY, which screen readers do not announce. A screen-reader
  user who picks a From after To hears nothing while the list vanishes.
- Evidence: the lines above; house forms announce validation errors with
  `role="alert"` (e.g. `dashboard/src/routes/contact/ContactCreateForm.tsx`, 4
  uses; `RecipientPreview.tsx`, 4). Pre-existing in the feature (slice G), not
  introduced by the fix wave; r1 did not raise it.
- Blast radius: accessibility only (WCAG 4.1.3 status messages / 3.3.1).
- Smallest fix: `aria-invalid` on the offending input(s) plus
  `aria-describedby` pointing at the under-inputs copy, and `role="alert"` on
  ONE of the two copies (the list-area box is inserted with its text, which an
  alert announces; giving both a role would announce it twice). One view test
  asserting the role and the description.

### R2-3 [LOW] Gap 4's `toBeInViewport()` cannot fail in its fixture

- Claim: the e2e assertion added for spec 9's "the opened row in view"
  (`e2e/tests/dashboard-next/tours-all.spec.ts:314`) is non-discriminating.
  Test 3 filters to Past + No show + the tenant search (`:290-292`), so the
  opened row is one of at most two rows (this test's and test 2's no-show) at
  the top of the list, inside the default viewport at mount with or without
  the view's `scrollIntoView` (`ATV:426`).
- Evidence: the fixture above; the fix-wave's own divergence 9 ("no product
  mutant ... can move it out of view"). Not run (Playwright is out of scope
  for this review), so the cannot-fail half is by reading.
- Blast radius: a test gap; the scroll half of the anchor is still pinned
  only by the unit spy (`AllToursView.test.tsx`, the `scrollIntoView` spy).
- Smallest fix: shrink the viewport before the back-arrow click (for example
  `page.setViewportSize({ width: 1280, height: 360 })`, so the header and
  filter bar push the list below the fold), then mutant-prove it by dropping
  `link?.scrollIntoView(...)` at `ATV:426`.

### R2-4 [LOW] Spec 5.5 and section 9 still state the per-request 400 rule the AD-1 fix replaced

- Claim: spec lines 632-634 ("A DynamoDB ValidationException on a request
  that CARRIED a cursor is answered 400") and the section-9 bullet at
  756-757 ("400 with a cursor, 500 without") contradict the code since
  5d61a075 (`app/src/routes/tours.ts:488-524`: 400 only for Query 1 carrying
  the cursor's key). The fix wave flagged it (divergence 2) and left the edit
  to the orchestrator; nothing amended it.
- Blast radius: documentation drift; the next reader of 5.5 re-derives the old
  rule (the house amends specs in place for build rulings, e.g. A-7 at spec
  5.4).
- Smallest fix: amend both sentences in place: "400 `invalid cursor` only when
  the page's FIRST Query carried the cursor's key; any other
  ValidationException - a later Query, a k-less cursor, a first page - is a
  500."

## 2. The fix diff, reviewed cold

- **AD-1, 5d61a075 - CORRECT, minimal.** The wrapper (`tours.ts:492-504`)
  tags only call 1 with `opts.startKey`; the engine passes the cursor's key
  only on call 1 (`tLP:62-63,97`) and afterwards a server-made
  `lastEvaluatedKey` or nothing (`tLP:112-119`). Walked: a k-less `u` cursor
  refused on Query 1 -> 500 (right: the client supplied no key and `i` is
  plan-checked); a D cursor whose Query 2 of the SAME phase resumes from a
  server LEK and is refused -> 500 (right: an LEK is a real item's key); a
  client-caused refusal can only come through `k` on Query 1 (the cursor's `n`
  shapes D's key condition, which every Query of D shares, so if `n` broke it
  Query 1 would fail first, with the key -> 400). Residual: a server defect
  in the FIRST Query of a keyed cursor page (say a bad status filter on D)
  still reads as 400, but the client's restart then runs the same Query with
  no key -> 500 plus the error line, so the defect surfaces. Mutant
  (`clientKey = rawCursor !== undefined`) -> cases 11 and 12 red, "expected
  400 to be 500". Non-blocking note: the WARN puts `name` at the top level;
  the house idiom is `{ err: { name } }` (`routes/relayGroups.ts:487`,
  `services/rosterProvision.ts:366`). The logger sets no `name` binding
  (`lib/logger.ts:178-200`), so nothing collides; only a log query on
  `err.name` would miss it.
- **SC-2, 87d7a34b - CORRECT for every form the dashboard sends; edges in
  R2-1.** Mutant (regex bypassed) -> parse case 9 and route case 1 red.
- **AD-4, a369f2b2 - CORRECT.** Both halves mutant-proven: byte cap and
  `isWellFormed` off -> 3b ("a 1,100-byte d tourId") and route 13 red;
  `isWellFormed` off alone -> 3b red on "a lone surrogate in a d tourId". Real
  key values are ASCII and tiny (an ISO instant 24 bytes, `tour-<uuid>` 41,
  a status at most 9, `tours` 5, perf ids `perf-tour-000NN`), so no
  server-made cursor can be refused. The `/// <reference lib="es2024.string" />`
  (`tLQ:9`) is sound: TypeScript 5.9.3 ships `es2024.string`; the directive
  is types-only (the call needs no downleveling, `target` stays ES2023); Node
  24.21 here and `node:24-slim` in production have the method (Node 20+). It
  IS program-wide - every file in the app, test and scripts programs can now
  type-check `isWellFormed` / `toWellFormed` - harmless on Node 24. A tsconfig
  bump would not be smaller: `app/tsconfig.json`, `tsconfig.test.json` and
  `tsconfig.scripts.json` each extend the shared `tsconfig.base.json` directly
  (which other workspaces also use), so the bump would touch three configs or
  the shared base. If the house would rather have no lib reference at all,
  `!/\p{Surrogate}/u.test(value)` (ES2018) or a round-trip
  `Buffer.from(value, 'utf8').toString('utf8') === value` is equivalent.
  Preference only, not a defect.
- **SC-3 / SC-4, 32052e7c - CORRECT (a11y gap of both copies in R2-2).** CSS:
  `.search { width: 360px }` (`AllToursView.module.css:134-136`) and the
  container query's `.control { width: 100% }` (`:218-220`) have equal
  specificity and the query comes later, so Search goes full width at 480px
  or less; dropping `.searchInput`'s `max-width` is covered by the wrapper's
  width; the deleted `.searchLabel` had no other reference in this module
  (the `searchLabel` hits elsewhere are other modules' own classes); the
  removed `.search` margin is replaced by `.controls`' gap and margin. DOM and
  tab order now match spec 4.3; Clear filters still hands focus to When
  (`ATV:351`). Mutant (list-area copy disabled) -> the SC-4 case and the
  amended Date range case red. SC-3 confirmed by reading: the pairwise
  DOM-order test fails for the pre-fix order (Search after Sort).
- **SC-1, 1a37a4be - real runtime pin, but duplicative for this profile (see
  3).** Deterministic: with an anchor, `normalizedAnchor` never reads the
  clock (`app/src/lib/seed/performance.ts:169-172`); 50 tours, all through
  `buildTour`; the test runs in about 1 ms.
- **SC-5, SC-6, gap 5 - CORRECT.** Read the assertions: route 14 compares
  exact id lists (a raw-bound mutant reorders them); SC-6 (a) asserts one page,
  `calls` 1 and `nextCursor` null (the peek mutant leaves a phantom cursor);
  (b) asserts no `statusFilter` plus the peek bound; gap 5 asserts the walk's
  exact cursor and limit.
- **Gap 4, 85709cab - NOT a real guard (R2-3).**
- **Issues, 73bf231c - accurate.** The three files match the adjudication and
  the code they cite.

## 3. Adjudication challenges

- **SC-1 [MEDIUM] -> should have been LOW.** Its premise "no red test" was
  false for the performance world: `buildTour` returns `{ ... } satisfies
  TourItem` (`performance.ts:651-667`) and `TourItem._schedPartition` is a
  REQUIRED `'tours'` (`app/src/repos/toursRepo.ts:80`). Mutant (the stamp line
  `performance.ts:655` removed) -> `npx tsc -p app/tsconfig.json --noEmit`
  exit 2 with TS2741 / TS1360; restored. Gate 1 already caught the case. The
  pin is still worth keeping (it is the runtime check the untyped cast,
  matrix and lean rows need), so the FIX stands; only the severity was wrong.
- **Gap 4 (FIX, tests only) - scope too narrow.** It prescribed
  `toBeInViewport()` in a fixture where the row is always on screen; the scope
  needed a viewport or fixture change to discriminate (R2-3).
- **AD-1 (FIX) - scope missed the spec.** The rule it adopted contradicts spec
  5.5 and section 9 as written; the adjudication should have ordered the
  in-place amendment (R2-4).
- **AD-3 REJECT (PATCH stamping) - upheld.** Its premise holds on the code:
  `create` stamps every tour (`toursRepo.ts:376`); `TourItem` requires the
  field (`toursRepo.ts:80`); the M1.6 import deliberately never loads tours
  (`app/src/lib/import/airtableSource.ts:189-194`); the only other raw tours
  write outside the repo is the live seed (`app/src/lib/seed/live.ts:523`),
  pinned by `seedLive.test.ts`. No production state reaches the gap.
- **AD-2 FILE - upheld, with one correction to the issue's framing.** The
  unbounded walk is NEW on this branch (spec 7 turned a one-page read into
  `queryAll`), not pre-existing; only from > to on `GET /api/tours` is. With
  today's table (hundreds of tours, well under one 1 MB page) the walk costs
  what the old read did, so filing is right.
- **AD-5 FILE - upheld.** Spec 4.9 names `wheel` on purpose; a change needs
  the trace the issue describes.

## 4. Fix confirmation

| item | verdict | evidence |
|---|---|---|
| SC-1 | REAL (runtime pin); duplicative of typecheck for this profile | fix-wave mutant; my tsc mutant (section 3) |
| SC-2 | REAL | my mutant: parse 9 and route 1 red |
| SC-3 | REAL | pairwise DOM-order test read; fix-wave RED "Sort after Search" |
| SC-4 | REAL | my mutant: 2 cases red |
| SC-5 | REAL | fix-wave mutant (raw bound -> wrong rows); assertions read |
| SC-6 | REAL | fix-wave mutants A (peek) and B (always filtered); assertions read |
| gap 4 | NOT REAL - cannot fail in its fixture | R2-3 |
| gap 5 | REAL | fix-wave mutant (Sort bypassing `change()`); assertions read |
| AD-1 | REAL | my mutant: cases 11 and 12 red |
| AD-4 | REAL, both halves | my mutants: 3b and 13 red; 3b red on the lone surrogate alone |

## 5. Checked and found sound

- The client against the new 500 path: a cursor-page 500 sets `moreFailed`
  (`uAT:277,306`), which blocks every automatic mode (`uAT:221`) and shows
  "We couldn't load tours. Please try again." with Retry (`ATV:646-652`,
  spec 4.5 "the same message"); Retry is `loadMore` on the same cursor
  (`uAT:283-309`). No automatic retry anywhere, so no loop. A first page
  carries no cursor, so its behavior is unchanged (it was already a 500).
- `restoreOutcome` while the first page is pending is `'none'` (`uAT:319-320`)
  and the anchor waits (`ATV:407`); after a FAILED first page it reads
  `'reached'` (rows empty, cursor null, `uAT:322-329`) and the anchor is
  spent with no target - harmless, since Retry is itself a `pointerdown` /
  `keydown` that cancels it.
- History-state writes: the app mounts a `BrowserRouter` (`dashboard/src/main.tsx:5,16`,
  react-router 7.18.0), whose history writes are synchronous, so the
  row-open REPLACE lands before the Link's PUSH. That argument is specific to
  `BrowserRouter`; re-verify it if the app ever moves to a data router.
- Dashboard range bounds always pass the new regex: `localDayStartIso` /
  `localDayEndIso` emit `toISOString()` and `ymdParts` refuses years under
  100 and 5+ digits (`tLS:74-100`).
- Cursor `n` keeps its own canonical check (`tLQ:285`); an extended-year `n`
  decodes but reshapes only the caller's own list.
- The engine never enters a phase full, so a "page full in a batch" key is
  always from the current phase (`tLP:95-111`); phase plan, skips and
  `isUnfilteredPhase` match spec 5.3-5.4.
- Throwaways: `app/test/zz-review-r2-iso.test.ts` created, run, deleted by
  exact name. Mutants (each restored with Edit, then `git diff --stat` empty):
  `tours.ts:495` (AD-1); `tLQ:80` and `tLQ:257-258` (SC-2, AD-4, then the
  `isWellFormed` half alone); `ATV:575` (SC-4); `performance.ts:655` (SC-1
  typecheck). No npm test, e2e or Playwright run; no commit.
