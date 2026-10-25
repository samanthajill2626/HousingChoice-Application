# FW3 report - feat/today-checklist (tracker #31), fix wave 3

Implementer: the FW3 child (Claude Opus 5.5), 2026-10-25. Scope: exactly
FW3-1..FW3-3 of `R3-adjudications.md`. Base 9323507d. Commits: 8ec98517
(FW3-1), 33cb000a (FW3-2), 3e60c745 (FW3-3), then this report. Strict TDD
per item: every new test was run RED first, for the reason stated below; the
one added pin of behavior that already held (FW3-2) was proven able to fail
by a temporary mutation, run once and reverted. Dashboard only; no app,
seed or dependency change.

## FW3-1 (R3-1) - a failed past-tours reload withholds "All caught up"

Changed `dashboard/src/routes/today/Today.tsx`:
- `allCaughtUp` also requires `!past.reloadFailed` (:507-514), beside
  FW1-1's `!refreshFailed`; its comment (:502-506) and the file header
  (:24-25) name both refresh failures.
- PastToursSection (:299-344): with no rows it returns null only when the
  last reload did not fail (:319); otherwise it renders its heading and the
  EXISTING note "Could not refresh past tours. Reload the page to see the
  latest." (the copy already in the tree, unchanged). The list renders only
  when there are rows (:323), so the note keeps its own slot and the
  rows-plus-note shape is unchanged. Doc comment updated (:291-298).
- `useTodayPastTours.ts` needed no change (it already passes `reloadFailed`
  through, :199). `settling` is unaffected: `reloadFailed` is only ever true
  with status 'ready', and `settling` requires 'idle'.

Tests:
- `Today.test.tsx:902` (mocked hooks, R3's probe): `:906` empty rows +
  `reloadFailed` - no "All caught up", the section's heading with ONE alert
  carrying the note, no list; `:917` the next good reload that still lists
  nothing hides the section and "All caught up" returns (guards against the
  section rendering when nothing failed).
- NEW `Today.pastToursReload.test.tsx:57` (R3's real-hooks probe): the REAL
  useToday and useTodayPastTours under the real page, api barrel mocked
  (getToday an empty queue; getTours [] then a 503 ApiError; every
  useEventStream subscriber hears one tour.updated). It waits for getTours x4
  and getToday x2, then for "All caught up" to go, then asserts the section's
  note and no Today refresh note. A new file because both page test files
  mock useTodayPastTours at module level.
- The rows-plus-note case (`Today.test.tsx:872`) is unchanged and green.

RED (before the source edit): 3 failed, 47 passed (Today.test.tsx +
Today.pastToursReload.test.tsx), all three "expected document not to
contain element, found <p class="_emptyTitle_de976c"> All caught up </p>
instead" - R3's reason. The real-hooks case failed at its line 72, i.e.
after both call-count waits had passed, so the reload had really run.
GREEN: the `src/routes/today` dir 8 files / 138 passed; dashboard tsc 0;
eslint 0. Either half alone stays RED: without the `allCaughtUp` clause
"All caught up" shows beside the note; without the section change
`sectionOf` finds no heading.

## FW3-2 (R3-3) - closing the AI line drops its Show all

Changed `dashboard/src/routes/today/Today.tsx`:
- `collapseList(label)` (:469-478) beside `expansionOf`: removes one label
  from the lifted `expandedLists` Set (no new Set when absent). Only the AI
  line's toggle calls it.
- AtAGlance takes `collapseList` (:380, :385); the AI line's button calls it
  for AI_LABEL when the line is open, then toggles as before (:412-415). Its
  doc comment (:371-375) and the Set's comment (:453-457) say a viewer close
  is the one non-reload way an expansion is lost.
- Nothing else about the Set changes: a live refetch still keeps every
  list's expansion, the open AI line's included.

Tests:
- `Today.test.tsx:935` (R3's probe, 7 AI rows, mocked useToday): open, Show
  all 7 (7 rows), close (no list), re-open -> 5 rows and "Show all 7" with
  aria-expanded false.
- `Today.refetch.test.tsx:343` (added pin, the real useToday): the open AI
  line's "Show all 7" survives one 404 FALLBACK refetch that hides the line
  (asserted absent during the drop), and comes back open with 7 rows and
  "Show fewer". It held before the fix; mutation proof: the AI LimitedList
  without `expansion={expansionOf(AI_LABEL)}` turned it RED, "expected [
  ...(5) ] to have a length of 7 but got 5" (:363); reverted, the diff
  re-read, the dir re-run green.

RED (before the source edit): 1 failed, 59 passed (Today.test.tsx +
Today.refetch.test.tsx) - "expected [ ...(7) ] to have a length of 5 but got
7" at the re-open, R3's reason; the pin passed.
GREEN: the today dir 8 files / 140 passed (and again after the mutation
revert); dashboard tsc 0; eslint 0.

## FW3-3 (R3-2) - the fallback collapses only by a real contact id

Changed `dashboard/src/routes/today/buildToday.ts`:
- `identifyRefIds` (a Set of refIds) becomes `identifyByContact`, a Map
  contactId -> the kept TodayItem (:257-266).
- Per unknown_1to1 thread (:284-304): `participantContactId(conv)` decides.
  With a contact id already listed, no second row; the kept row takes this
  thread's `conversationWho` only while its own is blank (:286-290), so the
  label is the FIRST non-blank in the fallback's order and the row keeps the
  contact's first place. With no contact id (refId `unknown?phone=...`, ''
  phone for an email thread) every thread keeps its own row, as before
  FW2-3. The row literal, its copy (the pinned em dash in 'New inbound ...
  untriaged') and the every-thread rule are unchanged (spec 3.1); the em-dash
  line is not in the diff.
- Header comment updated (:12-16).

Tests (`buildToday.test.ts`, a shared `identifyRowsOf` helper :199):
- `:204` R3's probe (a): [blank email thread, phone thread] of ct-1 ->
  [['ct-1', '(404) 010-0007']]; and [blank email, ct-2 'Bo Phone', phone,
  'Dee Mail' email] -> ct-1 first with '(404) 010-0007' (the first label,
  not the later 'Dee Mail'), then ct-2.
- `:244` R3's probe (b): two unlinked email threads (no contact id, no
  phone) -> 'Ana Mail', 'Bo Mail'; and two unlinked threads on ONE phone ->
  two rows (the adjudication's "never the placeholder keys").
- FW2-3's case (`:167`) unchanged and green in both input orders.

RED (before the source edit): 2 failed, 24 passed - "expected [ [ 'ct-1',
'' ] ] to deeply equal [ [ 'ct-1', '(404) 010-0007' ] ]" and "expected [
'Ana Mail' ] to deeply equal [ 'Ana Mail', 'Bo Mail' ]", R3's two reasons
verbatim.
GREEN: buildToday.test.ts 26 passed; the today dir 8 files / 142 passed;
dashboard tsc 0; eslint 0.

## Existing tests changed

None. Every change to the three existing test files is an added case (or
the added describe-level helper in buildToday.test.ts); no assertion,
fixture or mock of an existing case was edited.

## Gates (after the last code commit, 3e60c745)

- `npm run typecheck` (bare, root): exit 0, all 5 workspaces.
- Dashboard (`cd dashboard; npx vitest run`): exit 0; Test Files 270 passed
  (270); Tests 5569 passed (5569); 61.69 s. FW2: 269 / 5562; +1 file, +7
  cases (FW3-1 3, FW3-2 2, FW3-3 2).
- eslint on the 6 .ts/.tsx files FW3 touched (`git diff --name-only
  --diff-filter=d 9323507d..HEAD`): exit 0, no output.
- ASCII: 0 non-ASCII bytes on every added line and in the new test file; no
  `\u` escape in any touched file; the pinned em dash untouched.
- e2e: `run-spec.sh fw3` (cold boot, lane 12, fresh dashboard build of the
  clean tree at 3e60c745; today-checklist, today-past-tours,
  conversation-fact-extraction): exit 0, "17 passed (29.7s)". Then `npm run
  e2e:stop` exit 0 ("no running session found"); no listener on 10201 /
  10211 / 10221 / 10231; no session.pid.
- Not run (no app change, not asked): the app workspace, `npm run smoke`,
  the full `npm run e2e` (S8's).

## Found that the adjudication did not cover

1. FW3-3 React keys. Keeping contact-less threads distinct (as adjudicated)
   brings back one React key for two rows when their refIds match: two
   unlinked threads on one phone (`contact:unknown?phone=%2B1...`) or two
   unlinked email threads (`contact:unknown?phone=`). Today.tsx keys every
   Identify row by refType:refId (`rowKey`, :93), and TodayItem carries no
   conversation id, so buildToday cannot tell them apart without changing
   the link. This is the pre-FW2-3 shape (FW2-report item 5 for the
   same-phone pair) and the fallback runs only on a 404 (effectively dead in
   prod). Not changed (scope): a Today.tsx key change, or filing it beside
   the fallback's other residue, is the orchestrator's call.
2. FW3-3 choice between the two forms the brief allowed: "keep those rows
   distinct" (no de-dupe without a contact id) rather than "key them by
   their own conversation". The output is identical unless one conversation
   appears twice in the list; the simpler rule was kept.
3. FW3-1: the empty section with a failed reload shows the heading and the
   note only (as adjudicated) - no "Open the Past tab" link, which the
   first-load error copy carries. The Past tab stays reachable from the nav.
