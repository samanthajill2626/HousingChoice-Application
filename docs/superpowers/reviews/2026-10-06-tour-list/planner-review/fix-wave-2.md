# Planner fix wave 2 - feat/tour-list (planner review round 2)

Implementer: Claude Opus 5.5, 2026-10-07. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD fcdcf9a5 (the round-2 records), ended at
8e101714 (plus this report's commit). Scope: the Round 2 rulings in
`adjudications.md` in this directory - R2-1, R2-2, R2-4 + R2-F3, R2-5, R2-F2,
R2-F4, R2-F5, and the two DEFERs (R2-3, ADV-F5) filed as issues.

Method: the two code items ran TDD (RED for the finding's reason, then the
fix, GREEN); item 1's two hand-off guards were also pinned by a hand mutant,
restored with the Edit tool. Every pre-commit check: a separate bare
`git status`, `MERGE_HEAD` absent, explicit paths only, 0 non-ASCII bytes in
added lines, and 0 in each new file. No `[dynamoAdmin]` line in any captured
run. Not run (the orchestrator's): the full `npm test`, `npm run smoke`,
`npm run e2e`, any Playwright or e2e session.

## Commits

| item | commit | message |
|---|---|---|
| 1. R2-1 | f6b1bc88 | fix(dashboard): the All tab's action controls keep keyboard focus |
| 2. R2-2 | 21af7f10 | fix(dashboard): the newer copy of a tour wins the de-duplication |
| 3. R2-4 + R2-F3 | 7db2fa5b | docs(spec): queryLimit, the range read's test knob, named in sections 7 and 9 |
| 4. R2-5 | 5c769c1e | docs(app): the byScheduledAt readers named as they are |
| 5. R2-F2 + R2-F4 | 75e7f0f4 | docs: the search cache option needs a spec change; where "Not booked" appeared |
| 6. R2-F5 | 634bb77a | docs(issues): AllToursView cited by symbol, not line |
| 7. ADV-F5 (DEFER) | b8fb412d | docs(issues): file the duplicated BatchGet walk; TODO marker at unitsRepo.getDisplaysByIds |
| 8. R2-3 (DEFER) | 8e101714 | docs(issues): file the half-typed-year date input behavior (confirm first) |

## Per item

### 1. R2-1 - the action controls keep keyboard focus (f6b1bc88)

- Tests first: a new describe block in `AllToursView.test.tsx`, "keyboard
  focus after the action controls", with deferred (unscripted) pages as the
  file already does. A `press` helper focuses the control, then clicks it (a
  keyboard Enter). Cases: Load more (busy, then the first new row); Load more
  adding no row (focus stays); Keep checking (busy, then the count line when
  an empty page hands over to the automatic follow, and NO move after that
  automatic page lands); Retry after a failed Load more (busy, a second
  failure, then a landed page); Start over after a dead list; the first-page
  Retry (a second failure, then an empty list); the first-page Retry landing
  rows; focus the user moved meanwhile.
- RED (old code; 7 failed, 1 passed of the 8):
  - Load more: `Unable to find an accessible element with the role "button"
    and name "Load more"` (the pressed control unmounted).
  - Load more adding no row: `expected <button> to be <button> // Object.is
    equality` (a NEW, unfocused Load more after the page).
  - Keep checking: `Unable to find ... name "Keep checking"`.
  - Retry after a failed page, Start over: `expected <body> to be <button>`.
  - The first-page Retry (both cases): `expected <body> to be <p
    class="_countLine_...">` and `expected <body> to be <a ...>`.
  - The moved-focus case passed on the old code by construction (it never
    moves focus); it is pinned by the mutant below instead.
- A ninth case was added with the fix: a filter change while Load more runs
  starts another list, which is never focused into.
- Mutant: both hand-off guards (the list-key check and the moved-focus
  check) removed with the Edit tool -> 2 failed, 7 passed: the moved-focus
  case `expected <a ...> to be <input ...>` (a new row stole focus from the
  search box); the filter-change case `expected <p class="_countLine_...">
  to be <body>` (the count line took focus on the other list). Each case
  pins its own guard. Restored with the Edit tool.
- The existing case "Load more shows only with a cursor and no loader
  running ..." asserted Load more hidden right after its own press - the
  rule this ruling amends. Renamed ("... no automatic loader running - busy
  while its own page loads - ...") and now asserts `aria-busy="true"` there.
- Spec 4.5 amended in place, marked "(Amended by the planner review, round
  2, R2-1 ...)": the ONE LOADER bullet (hidden only during an automatic
  loader; the pressed control busy, focused, ignoring a second activation),
  the Load more bullet, and a new focus bullet. Section 9's Loaders line names
  the cases.
- GREEN: `AllToursView.test.tsx` 75/75; the tours directory 19 files / 551
  tests. eslint on both files: exit 0, no suppression.

#### The focus rules as BUILT

The busy control is the SAME element (each action block is keyed), with
`aria-busy="true"` and `aria-disabled="true"` and no `disabled` attribute;
its look comes from the existing `Button.module.css` rule for
`[aria-busy='true']` (dimmed, no pointer events). Every move uses the
anchor's idiom: focus without scrolling, then `scrollIntoView` nearest.

| control | while busy | after the page lands | on failure |
|---|---|---|---|
| Load more | stays, busy, focused; a second activation sends nothing (the handler returns early; the hook ignores it too) | the first NEWLY ADDED visible row's link; no row added: Load more if still shown (focus simply stays), else the count line (an empty page handing over to the automatic follow, or a complete list) | the Retry that replaced it (the action control now shown); a second cursor 400: Start over; a first cursor 400 (the automatic restart): the count line, which then says "The list was refreshed." |
| Keep checking | as Load more; its sentence stays | as Load more | as Load more |
| Retry after a failed page | as Load more; the failure sentence is withdrawn from the alert while it runs | as Load more (no row added and a cursor left: the Load more then shown) | the same Retry element keeps focus; the sentence is inserted again, so the alert announces the second failure |
| Start over (dead list) | the control leaves with the old list: focus moves to the count line at once (`tabindex="-1"`) | the first row's link; an empty list: stays on the count line | stays on the count line |
| first-page Retry | as Start over | as Start over | as Start over |

- The first-page-failure precision (not stated by the planner): focus STAYS
  ON THE COUNT LINE. The count line is mounted in every state (ruling D-6),
  the error state included, so the "else focus the first-page Retry" branch
  never applies; the failure alert's Retry follows the count line in DOM
  order and is the next Tab stop (asserted).
- Never moved: after the first page of a list, an automatic page (follow,
  walk, restore) or the return restore (the anchor's layout effect is
  untouched); onto another list (a filter change while the request runs);
  or away from where the user put focus meanwhile (anything other than the
  pressed control, the count line or the page body).
- Implementation: a `pressed` state (set in the click handler, read only
  while the loader is `more`), and a `pendingFocus` ref written only in the
  click handlers and read and cleared only in one `useEffect`, which calls
  `focus()` and sets no state. React Compiler rules: no finding.

### 2. R2-2 - the newer copy wins (21af7f10)

- Test first (`useAllTours.test.ts`, "the first page"): one page lists t2
  twice, the second copy STALE (older `updatedAt`, status `requested`, no
  `scheduledAt`).
- RED: `expected { tourId: 't2', ... } to deeply equal { tourId: 't2', ... }`
  - received `status: "requested"`, `scheduledAt: undefined` (the stale copy
  won).
- Fix: `mergeRows` replaces a listed row only when the incoming `updatedAt`
  is the same or newer (canonical ISO strings compared as strings; a tie goes
  to the later read). Its doc comment and `withPage`'s say so. The cross-page
  reschedule case (a same-age copy) passes unchanged.
- Spec 4.5 "the LATER copy's data replaces" -> "the NEWER copy (by
  `updatedAt`; a tie goes to the later read) replaces ...", marked R2-2;
  section 9's "(later copy wins)" -> "(the newer copy wins - round 2, R2-2)".
- GREEN: `useAllTours.test.ts` 38/38; the tours directory 19 / 552. eslint on
  both files: exit 0.

### 3. R2-4 + R2-F3 - `queryLimit` in the spec (7db2fa5b)

- Spec section 7 (the third argument; the integration test) and section 9
  (the paged range read) now say `queryLimit`, each marked "amended, ADV-F4".
  The spec's one remaining `pageLimit` is inside that amendment's own "from
  `pageLimit`".
- `tours-scheduled-range-query-unpaginated` (resolved) gains one line naming
  the rename (ADV-F4, e84dfbfa) and pointing at the docblock by symbol.
- Verified: the integration test reads with `queryLimit: 1`
  (`app/test/toursRepo.integration.test.ts`). The plan is left as written.

### 4. R2-5 - the byScheduledAt readers (5c769c1e)

- `git grep "listByScheduledRange\|byScheduledAt\|queryListPhase" -- app/src`,
  every hit read. The readers: `listByScheduledRange` in `routes/today.ts`
  (Today's tours) and in `routes/tours.ts` (`GET /api/tours?from&to`, called
  by `useTours.ts` for the Active tab and for the Past tab's loader, which
  Today's past-tours list reuses); `queryListPhase` (phase D of
  `GET /api/tours/list`, through `services/tourListPage.ts`). The reminder
  poll reads `tourRemindersRepo.listDue` and fetches tours by id
  (`toursRepo.get`); auto-close reads `listByStatus`; no job reads the index.
- `toursRepo.ts` header (one line) and `tables.ts` (the table note's two
  lines, the GSI note's four) rewritten in ASCII to name only those readers.
  Both files keep their line counts (910, 668), because many issues cite them
  by line.
- App tests nearest the change (`unitsRepoDisplays`, `tables`, `genTables`):
  3 files / 46 passed.

### 5. R2-F2 + R2-F4 (75e7f0f4)

- `tours-all-server-side-search`: options now in preference order -
  server-side search first; the short-TTL list cache marked as NEEDING A
  SPEC CHANGE (spec 4.9's "fresh reads, never a cache"; a cached list would
  focus the row just handled, with its old status, instead of the next one -
  P14, D9) plus per-tour invalidation; a TTL alone does not help.
- GLOSSARY: "Not booked" was shown on the tour page and the tenant, landlord
  and property files' tour lists (the Past tab and Today already said
  "Undated"; the Closed tab showed a blank date); `undatedTourLabel` is the
  rule's one implementation, read by every surface that shows a missing date.
  Checked against spec P7.

### 6. R2-F5 - cited by symbol (634bb77a)

- After item 1: `perf-pages-tours-past-surface` (the first-page failure
  block, the `data.status === 'error'` branch), `tour-list-restore-anchor-
  trackpad-swipe` (the `userActed` effect; its refs carry the file without a
  line) and `undated-tour-wording` (`rowView`). Each symbol verified in the
  current file. `git grep "AllToursView.tsx:" -- docs/issues`: empty.

### 7. ADV-F5 DEFER - the duplicated BatchGet walk (b8fb412d)

- New `docs/issues/units-contacts-batchget-walk-duplicated.md` (debt, low,
  open, area app): `unitsRepo.getDisplaysByIds` mirrors `contactsRepo`'s
  private `batchGetByIds` (de-duplicated ids, 100-key chunks, `UnprocessedKeys`
  retried with the same backoff, best-effort, a WARN carrying counts); the
  deferral's reason and why it no longer holds; a helper shape and the tests
  that pin it. Both walks cited by file and symbol.
- A one-line `TODO(units-contacts-batchget-walk-duplicated)` marker above
  `getDisplaysByIds` in `unitsRepo.ts`, naming its twin.
- `npm run typecheck`: exit 0.

### 8. R2-3 DEFER - half-typed years (8e101714)

- New `docs/issues/tour-list-date-inputs-half-typed-year.md` (bug, low, open,
  PLAUSIBLE, confirm first): the To case (the range alert flashes) and the
  From case (throwaway lists; `0002` / `0020` fail `ymdParts`, `0202` is a
  valid bound), the confirmation step (keyboard typing on a hermetic e2e lane
  in Chromium, counting `/api/tours/list` requests and alert flashes), and
  the two fix options with their trade-offs.
- `npm run issues` (exit 0; the arrow and middle dots transliterated):
  `[issues] 375 open, 196 closed, 571 total -> docs/issues/INDEX.md` and
  `[issues] open by severity: 7 high / 147 med / 221 low` - zero warnings.
  `INDEX.md` is gitignored (`.gitignore:62`) and was not added.

## Results at the end (HEAD 8e101714)

- `npm run typecheck` (root, all five workspaces): exit 0 - after the last
  code commit (b8fb412d) and again at 8e101714.
- `npx eslint` on every touched TS/TSX file (`AllToursView.tsx`,
  `AllToursView.test.tsx`, `useAllTours.ts`, `useAllTours.test.ts`,
  `toursRepo.ts`, `tables.ts`, `unitsRepo.ts`): exit 0, zero findings.
  Baseline on the same seven paths at fcdcf9a5: exit 0, zero findings. New:
  none. The Markdown files are not lintable.
- Dashboard `src/routes/tours/`: 19 files / 552 tests, exit 0 (542 before
  this wave: +9 item 1, +1 item 2). No stderr from the All tab's files (the
  act warnings in that run are RemindersPanel's and TourConversation's,
  pre-existing).
- App `unitsRepoDisplays`, `tables`, `genTables`: 3 / 46, exit 0.

## Divergences from the adjudications, and why

- Item 1, the effect's dependencies are `[data.loader, data.status,
  data.rows, listKey]`, not `[..., data.rows.length, data.complete]`: the
  effect reads `data.rows` (which rows are new) and `listKey` (the hand-off),
  and exhaustive-deps requires what it reads; it does not read `complete`.
- Item 1, `PendingFocus` carries `listKey`, `from` (where focus was left) and
  `started` (settle only after the request was seen in flight, so a press
  the hook ignored can never move focus later, after an automatic page)
  beyond `{ kind, rowsBefore }`.
- Item 1, precisions the ruling did not state: on a FAILED user request,
  focus goes to the action control now shown (Retry, or Start over on a dead
  list) rather than the count line - the count line would leave a keyboard
  user the long walk back through the rows that R2-1 is about; by the same
  rule a page Retry that adds no row hands focus to the Load more then shown.
  The two hand-off guards (another list; focus the user moved). The page
  Retry's failure sentence withdrawn while it runs - keeping the alert's text
  unchanged would have made a second failure silent.
- Item 1 and item 2 also amend spec section 9's restatements of the two
  rules (the precedent: code review r2 R2-4 amended section 9 with 5.5);
  item 2 renames two existing hook cases to say "newer" / "the same age",
  assertions unchanged.
- Item 3's appended line points at the docblock by symbol; the Resolution
  bullets' line cites (`:416-426`, `:203-210`) stay as the record (the ruling
  asked for one line).
- Item 4 keeps both files' line counts: the `toursRepo.ts` header is one
  line naming the three readers, the detail sits in `tables.ts`' GSI note,
  whose four lines were rewritten as four (the hash, range and sparse facts
  kept, compressed).
- Item 7's marker adds one line to `unitsRepo.ts`. The line cites into that
  file below it (`unit-media-dangling-reference-race` :710 / :728, the
  comment at `routes/units.ts:885`) were already off on this branch before
  this wave.

## Open points

- The live keyboard check (the orchestrator's): a busy `aria-disabled`
  button keeping focus in a real browser, the count line's focus ring (no
  CSS was added for `tabindex="-1"`), and what a screen reader says for
  `aria-busy` on the focused control and for the re-inserted alert sentence.
- Safari does not focus a button on a mouse click; there the effect moves
  focus from the page body to the first new row (the guard allows the body).
  Not observable in jsdom.
- R2-3 stays unconfirmed (filed, confirm first).

## Gates (orchestrator)

Run by the orchestrator (Fable 5.1) on 1fc7626f (the wave's last code commit
is 8e101714; 1fc7626f adds only this report), bare, real exit codes, output
redirected to files under `.superpowers/sdd/` and read after:

1. `npm run typecheck` - exit 0.
2. `npm test` - exit 0: app 410 files / 8370 passed + 1 skipped (the by-design
   built-dashboard diagnostic), dashboard 220 / 3909 (+10 over the previous
   wave: the focus cases and the stale-copy case), e2e workspace 22 / 503,
   fake-twilio 34 / 275, fake-twilio-web 13 / 111; zero `[dynamoAdmin]` lines.
3. `npm run smoke` - exit 0 ("1556 import specifier(s) across 272 emitted
   file(s) resolve under plain Node").
5. eslint over the branch's 54 lintable files (the synced run's 53 plus
   `app/src/lib/tables.ts`, comment-only in R2-5) - exit 1 as expected; by
   baseline comparison on the same paths at the merge base a5eabcb3 (rows
   keyed file|severity|rule|first message line): 13 rows = 13 rows, ZERO new,
   zero gone; `tables.ts` has 0 rows at the base and 0 on the branch.
4. (affected specs only - the planner reruns the full battery) on a fresh
   `npm run e2e:session` lane 7 booted at 1fc7626f (`/__dev/ping` appCommit
   1fc7626f), reused by the single-hop runs: `tests/dashboard-next/tours-all.spec.ts`
   exit 0, "5 passed (7.1s)"; `tests/dashboard-next/tours-past.spec.ts` exit
   0, "2 passed (6.5s)".

Live keyboard check of R2-1 (Playwright MCP on the same lane, 76 API-seeded
tours plus the specs' leftovers; every fact read from `document.activeElement`
and a 40 ms page-side sampler; the cursor page slowed by a 1500 ms route delay
so the busy state is observable):

- The count line (`role="status"`) has `tabIndex` -1.
- From the search box, 52 Tabs reached the `Load more` button (50 row links
  between). Enter: ONE `/api/tours/list?...cursor=...` request; while it ran
  the SAME button kept focus with `aria-busy="true"` and
  `aria-disabled="true"` and NO `disabled` attribute (sampler: "BUTTON 'Load
  more' busy=true rows=50" from 491 ms); a second Enter and a Space while busy
  sent NO request (still 1). When the page landed (2020 ms) focus was on the
  row link at index 50 - the first newly added row - inside the viewport;
  "81 tours", Load more gone (the list complete).
- Failure path (the cursor page aborted by a route): Enter on Load more ->
  the `Retry` button replaced it inside the alert "We couldn't load tours.
  Please try again." and HELD focus (rows 50); Enter on Retry (the route now
  passing, 800 ms delay) -> Retry stayed focused with `aria-busy="true"` /
  `aria-disabled="true"`, the failure sentence withdrawn (the alert read
  "Retry" alone); when the page landed focus was on the row link at index 50,
  "61 tours".
- Not exercised live (no fixture reaches them cheaply): Keep checking (a
  capped empty-page follow) and Start over (a second cursor 400); both are
  covered by the new view cases. The browser console held one error, the
  route-aborted request of the failure path.

Lane stopped afterwards: `npm run e2e:stop` exit 0 (tables dropped, lease
released), `e2e/.artifacts/session.pid` gone, no listener on
9701/9711/9721/9731. Main unmoved (0 behind); no second sync.

Orchestrator notes on the diff (read in full): the pressed control is keyed,
so its busy and settled renders are ONE element; `requestMore` returns early
while `loader === 'more'`; the focus effect reads refs only inside the effect,
calls no setState, waits for the request to be seen in flight, hands off when
the list key changed or the user moved focus elsewhere; the rebuild path
focuses the count line before the state change; `mergeRows` keeps the copy
that is not older by `updatedAt`; the `TODO(units-contacts-batchget-walk-duplicated)`
marker sits at `getDisplaysByIds`; the GSI comments name only readers that
exist. The child's one precision (a failed OWN request hands focus to the
Retry / Start over that replaced the control, not to the count line) keeps
the keyboard user one Enter from retrying and is recorded for the re-review.
