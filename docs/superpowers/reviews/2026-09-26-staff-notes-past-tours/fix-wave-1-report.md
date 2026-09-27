# Fix wave 1 report - feat/staff-notes-past-tours

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Wave base: `94f89929` (the R1 review records commit). Wave head: `dd06c7f1`,
plus this report's own commit.
Implementer: fix-wave child, Claude Opus 5.5 (1M context).
Work order: `review-r1-adjudications.md`, "Fix-wave findings list" F-1..F-11.

Status: DONE. All eleven items landed in the listed order (F-7 first, F-11
last). Every test the list specifies was shown RED before its fix and GREEN
after. F-8 was also shown red with its guard reverted locally, then green once
restored. The pure pins (F-3..F-6) were green on arrival, and three of them
were shown to fail under a one-line mutation of the code they pin. The F-1 e2e
pin was shown red in the real browser with the fix reverted.

Byte-exact output behind every quote below (failure blocks, probe numbers,
stop output, grep counts) is in the ignored run state
`.superpowers/sdd/fix-wave-1-reference.md`; raw logs are
`.superpowers/sdd/logs/fw1-*.log`; screenshots are `.superpowers/sdd/fw1-shots/`.
Line numbers inside a quoted failure are as of that run; the file:line
citations elsewhere are at `dd06c7f1`.

## Commits

| hash | one-liner |
|---|---|
| `5598be78` | fix(dashboard/tours): one Past batch per browser tab - module store for the busy flag, guard and mounted-view reload (F-7; A-1, C-7) |
| `f3d8ca0b` | fix(dashboard/tours): Past rows keep the checkbox beside its card at 360px and share fixed slots so cards align (F-1, F-2; C-1, C-9/OD-7) |
| `7f7d39c3` | test(dashboard): pin sequential PATCHes, a failed reload keeping results, the back-arrow fallbacks and four unpinned behaviors (F-3..F-6; C-2, C-3, C-4) |
| `2560dbaf` | fix(dashboard/contact): useContact's setContact commits only for the contact it was handed out for (F-8; A-3) |
| `547b9299` | fix(dashboard/contact): Staff notes editor state never crosses tenants, and an untouched Save never sends (F-9, F-10; X-1, A-4) |
| `dd06c7f1` | docs(perf): refresh the Tours citations in the route ledger to the lines that now hold the cited code (F-11; C-6) |

Before every commit:

- a bare `git status --porcelain` listed only that commit's paths;
- the MERGE_HEAD probe printed nothing;
- the added-lines ASCII command printed 0 for every staged file (the new
  `useContact.test.tsx` was checked whole-file: 0 bytes, 0 CR).

Paths were staged explicitly. Every commit carries the
`Co-Authored-By: Claude Opus 5.5 (1M context)` trailer.

## Per finding

### F-7 (A-1, C-7) - the Past batch state moves to a module store

What changed, all in `dashboard/src/routes/tours/ToursPage.tsx`:

- The store section is `:285-328`:
  - the busy flag, which is also the in-flight guard (`:299`);
  - the listener set (`:300`);
  - `subscribeBatch` (`:302`), `readBatch` (`:309`) and `setBatchRunning`
    (`:315`, which notifies listeners only on a change);
  - the mounted-view reload slot (`:322`);
  - the test-only `resetBulkBatchStoreForTests` (`:325`).
- `PastToursView` (`:343`) takes only `contacts` and `units`:
  - it reads the flag through `useSyncExternalStore` (`:348`);
  - it registers its reload in an effect whose cleanup clears the slot only
    while the slot still holds that view's own function (`:354-359`).
- The runner:
  - guards on the module flag (`:425`);
  - sets it only on its event-handler path (`:429`, `:459`);
  - refreshes through the slot (`:458`).
- The page's `useState` / `useRef` trio and the three props are gone. The call
  site is `:783`, and `useRef` left the react import (`:42`).
- Comments now say what holds: one batch per browser tab, across tab switches
  AND route changes, ended by a full page reload. They are the file header
  (`:16-24`), the store block (`:289-298`), the `PastToursViewProps` doc
  (`:330-334`), the runner's closing note (`:460-468`) and the JSX comment
  above the call site.
- Tests (`ToursPage.test.tsx`):
  - new route-change round trip, `:1006`;
  - `LocationProbe` now also renders a "Back to tours" link to `state.back`
    (`:230-247`);
  - `beforeEach` calls the reset (`:296-299`).

RED - the new test only, on the page-owned code (`npx vitest run
src/routes/tours/ToursPage.test.tsx`) - exit 1:

- "Tests  1 failed | 33 passed (34)";
- "Error: expect(element).toBeDisabled() / Received element is not disabled:";
- the element was the select-all checkbox of the page mounted after the round
  trip (`ToursPage.test.tsx:958:77` in that run).

GREEN (same command) - exit 0, "Tests  34 passed (34)". No act warning and no
stderr. Dashboard typecheck exit 0. Tours + contact dirs: exit 0, "Test Files
80 passed (80)", "Tests  1638 passed (1638)".

### F-1 (C-1) - the checkbox shares the first line at 360px

What changed:

- `ToursPage.module.css:267-270`: `.pastRow > .row` takes a zero basis. The
  comment above it is `:263-266`.
- The comment above the 560px query now says the checkbox's slot shares the
  first line with the link and only the actions wrap (`:370-373`).
- E2E pin in the pre-batch 360px block of
  `e2e/tests/dashboard-next/tours-past.spec.ts:135-146`. The Not-marked row's
  checkbox box must lie within its card's vertical span; both expects carry a
  message. The header gained one clause (`:18-19`).

RED (e2e run 3, CSS reverted to `flex: 1 1 auto` uncommitted, the spec at its
committed bytes) - exit 1:

- "Error: the checkbox top is not above its card top at 360px";
- "Expected: >= 311.390625", "Received:    285.796875";
- at `tours-past.spec.ts:142`, "1 failed".

That is S7's O-1 geometry: the checkbox alone on line 1, the card on line 2.

GREEN (runs 1 and 4, committed bytes) - exit 0, "3 passed". The unit suite
is untouched by this change: "Tests  34 passed (34)", exit 0.

### F-2 (C-9, OD-7) - fixed row slots

What changed:

- `ToursPage.tsx`: every Past row renders a leading `.lead` span holding the
  checkbox or nothing (`:218-229`). It ALWAYS renders the trailing
  `.rowActions` span, with conditional content (`:245-268`).
- CSS: `.lead` is `:273-278`. `.rowActions` is `:290-296`: one fixed 8.5rem
  width, `justify-content: flex-end`.
- Inside the 560px query, the actions keep a 100% basis and an empty
  `.rowActions` is `display: none` (`:382-384`).
- No role was added: every pre-existing unit test passed unchanged
  ("Tests  34 passed (34)" on the unedited test file).

Real-browser evidence (e2e run 2: a TEMPORARY probe added to the spec and
removed afterwards; the spec blob is back to `a82b40b0` = HEAD):

- Desktop, 1280px: all three cards have left 289.59375 and right 1112, and
  every state chip ends at 1095. Screenshot `fw1-shots/1-past-desktop.png`.
- 360px:
  - every card is at x 49.59375, width 286.40625;
  - the checkbox is at x 24, y 338.75 inside the Not-marked card's span
    (285.8 to 409.3);
  - "Mark toured" wraps to its own right-aligned line (x 236.6, y 417.3);
  - "Record outcome" wraps likewise (x 239.1);
  - the No-show row's li height equals its card height (123.5 / 123.5), so
    the empty action slot adds no blank line.
  - Screenshot `fw1-shots/2-past-360-before-batch.png`.

Both screenshots were read and match the numbers.

### F-3 (C-2a) - a second PATCH waits for the first (pure pin)

`ToursPage.test.tsx:870`: two ids still scheduled at the SAME time.

- With PATCH 1 held and after a 50 ms settle there is exactly one `patchTour`
  call and one re-read.
- Released: calls `['p1', 'p4']`, and both rows read "Marked toured" with no
  alert.

Green on arrival. Control (the runner's `await patchTour` changed to
`void patchTour`, restored and `git diff --quiet` afterwards) - exit 1, "expected
"spy" to be called 1 times, but got 2 times", "Tests  1 failed | 38 skipped (39)".

### F-4 (C-2b) - a failed reload keeps rows AND results (pure pin)

`ToursPage.test.tsx:1126`: a batch whose reload fails (`reloadPast` sets
`reloadFailed: true` on the same rows).

- Both rows remain.
- The p1 row keeps "Marked toured" (status); the p4 row keeps "Could not mark
  toured: Changed since the list loaded" (alert).
- Exactly one refresh alert exists, and it precedes the select-all checkbox
  (the toolbar) in document order.

Green on arrival.

### F-5 (C-3) - back-arrow fallbacks (pure pins)

`TourDetail.test.tsx`:

- no router state at all -> `/tours` (`:1899`);
- `{ back: '/tours/closed' }` -> `/tours/closed` (`:1906`).

Green on arrival. No control was run: `TourDetail.tsx` is outside this wave's
file scope, so it was not touched even temporarily.

### F-6 (C-4) - four pins (pure)

- Tab order Active, Past, Closed (`ToursPage.test.tsx:507`).
- The exact Record-outcome name `Record outcome: <tenant> at <property> on
  <date-time>` (`:793`). It is checked by exact role name and by the
  `aria-label` attribute; `U2` and `P2_LABEL` were added at `:698`, `:700`.
- Select-all INDETERMINATE with one of two rows ticked, and checked with both
  (`:803`). Control: the ref never setting `indeterminate` gives exit 1,
  "Error: expect(element).toBePartiallyChecked()".
- The card's in-flight state (`StaffNotesCard.test.tsx:189`): with
  `updateContact` held, Save and Cancel are disabled and the textarea is
  `readonly`; released, it returns to read mode. Control: `readOnly={false}`
  gives exit 1, `expect(element).toHaveAttribute("readonly")`.

All green on arrival. The three suites together (verbose): exit 0, "Tests
142 passed (142)", with every new test listed as passed.

### F-8 (A-3) - `useContact`'s setter is bound to its contact

What changed: `dashboard/src/routes/contact/useContact.ts:47-53`. The setter
commits only when `prev.forId === contactId`, else it keeps `prev`. There is a
4-line why-comment. The suggestion.updated refetch at `:65` was already
guarded this way.

New test file `dashboard/src/routes/contact/useContact.test.tsx` (no hook test
existed; it sits beside `ContactDetail.test.tsx`):

- The harness is shaped like the reviewer's P3 (`:32`): the hook, a spinner
  while loading, then StaffNotesCard with `onContactUpdated={setContact}`.
- `:55`: Save on A with the PATCH held, rerender with B, B loads, release A
  inside `act`. Then B is still on screen with its own note, and `getContact`
  ran twice.
- `:88`: a setContact for the contact on screen still applies in place, with
  no refetch.

Runs of `npx vitest run src/routes/contact/useContact.test.tsx`:

- RED, before the guard - exit 1:
  - "Tests  1 failed | 1 passed (2)";
  - "Unable to find an accessible element with the role "heading" and name
    "Ben"" (`useContact.test.tsx:82:19`);
  - the DOM held only `<p role="status">page loading</p>`.
- GREEN, with the guard - exit 0, "Tests  2 passed (2)".
- Guard REVERTED locally (`git diff` showed only the comment lines against
  HEAD) - exit 1, the same failure, "Tests  1 failed | 1 passed (2)".
- Restored - exit 0, "Tests  2 passed (2)".

A first revert attempt did not apply: the Edit tool refused the string as
ambiguous, because it also occurs at `:65`. That run was still guarded and
passed. It is not counted; the reverted run above came after `git diff`
confirmed the revert.

Tours + contact dirs after F-8: exit 0, "Test Files  81 passed (81)", "Tests
1648 passed (1648)". The 96 ContactDetail tests are included.

### F-9 (X-1) - the card is keyed by the contact

What changed: `dashboard/src/routes/contact/TenantFile.tsx:261` renders the card
with `key={contact.contactId}`. The comment above it (`:253-258`) says why.

Test: `TenantFile.test.tsx:76`. A `fileFor(contact)` helper was extracted
(`:27`); `renderFile` keeps its API. The test opens the editor on A, types,
then rerenders with B. After that there is no textarea, no A draft, B's
stored text shows, and the "Edit staff notes" aside is back.

- RED, before the key - exit 1:
  - "Tests  1 failed | 2 passed (3)";
  - "expected document not to contain element, found <textarea ...> Has a
    service dog - draft for A </textarea>" (`TenantFile.test.tsx:92:56`).
- GREEN - exit 0, "Tests  3 passed (3)".

### F-10 (A-4) - the no-op compare uses the baseline

What changed: `dashboard/src/routes/contact/StaffNotesCard.tsx`:

- `baseline` state (`:53`), set in `startEdit` (`:67`);
- `save()` compares `draft.trim() === baseline.trim()` (`:79`), with one
  added comment line (`:78`);
- the request still sends the raw draft.

Tests:

- `StaffNotesCard.test.tsx:156`: value X, Edit, rerender with Y, Save
  untouched -> no request, read mode showing Y.
- `:173`: an edited draft still saves (`('c1', { staff_notes: 'X2' })`).

Runs:

- RED - exit 1:
  - "Tests  1 failed | 13 passed (14)";
  - "expected "spy" to not be called at all, but actually been called 1
    times", 1st call `["c1", {"staff_notes": "X"}]`
    (`StaffNotesCard.test.tsx:168:31`);
  - the edited-draft test passed before as well, as it should.
- GREEN - exit 0, "Tests  14 passed (14)".

### F-11 (C-6) - Tours citations in the perf ledger

What changed, numbers only, nine lines of `e2e/performance/routes.ts`:
`:131`, `:686`, `:687`, `:716`, `:740`, `:741`, `:759`, `:768`, `:1077`.

Each range was read at main `0dafe3c1`. The extracted lines were then diffed
against the new range at HEAD:

| cited at base | now | check |
|---|---|---|
| `useTours.ts:37-123` | `46-132` | identical |
| `useTours.ts:37-72` | `46-81` | identical |
| `useTours.ts:37-42` | `46-51` | identical |
| `ToursPage.tsx:181-185` | `618-622` | identical |
| `ToursPage.tsx:181-198` | `618-635` | identical |
| `ToursPage.tsx:250-346` | `695-793` | anchors match (the h1; the Closed tours list) |
| `useTours.ts:112-149` | `121-150` | see the deviation below |
| `TourDetail.tsx:551` | `630` | see the deviation below |

For the `ToursPage.tsx:250-346` row: the h1's expression changed in S5; the
anchors are the same elements.

`cd e2e && npx vitest run performance/routes.test.ts`: exit 0, "Tests  24
passed (24)". Root typecheck: exit 0.

## Verification summary (final, clean tree at `dd06c7f1`)

Commands, run bare:

- `npx vitest run src/routes/tours src/routes/contact` (dashboard) - exit 0,
  "Test Files  81 passed (81)", "Tests  1651 passed (1651)".
- Progression of the same command: baseline 80/1637; after F-7 80/1638;
  after F-3..F-6 80/1646; after F-8 81/1648; after F-9/F-10 81/1651.
- act warnings: 258 lines at baseline and 258 at the end, naming the same
  components both times (ContactDetail 244, RemindersPanel 12,
  ContactCommsTab 2). All pre-existing; none from a file this wave touched.
- `npm run typecheck` in dashboard: exit 0. Root `npm run typecheck` (all
  workspaces, e2e included): exit 0.
- `e2e`: `npx vitest run performance/routes.test.ts` - exit 0, "Tests  24
  passed (24)".

E2E, all `timeout 900 npm run e2e -w @housingchoice/e2e -- --grep ...` from
the worktree root. Logs are `.superpowers/sdd/logs/fw1-e2e-run<N>*.log`.

| run | bytes | grep | exit | result line |
|---|---|---|---|---|
| 1 | committed (HEAD `dd06c7f1`) | trio | 0 | "3 passed (26.3s)" |
| 2 | + temporary geometry probe | Past tab | 0 | "1 passed (8.5s)" |
| 3 | F-1 CSS reverted (control) | Past tab | 1 | "1 failed" (the F-1 pin, quoted above) |
| 4 | committed, tree clean | trio | 0 | "3 passed (14.3s)" |

The trio grep is "Past tab|Staff notes card|editing a contact PATCHes". Run
4 lists `contact-detail.spec.ts:51`, `tenant-staff-notes.spec.ts:36` and
`tours-past.spec.ts:76` as ok.

Session lifecycle:

- Pre-start `npm run e2e:stop`: exit 0, "[e2e-stop] no running session
  found; retained state is stale or absent - nothing to stop". The stale
  `session.pid` / `lane.json` were then gone, and ports 10301/10311/10321/10331
  were free before and after.
- `npm run e2e:session` ran as a background Bash command. The ping answered
  `"dev":true`, `"lane":13`, `"appCommit":"dd06c7f1"`. Every run printed
  "reusing the live e2e:session on lane 13".
- No commit was made between session start and the last run.
- Process note: my first readiness poller exited early. Its error regex
  matched a benign Vite proxy ECONNREFUSED caused by my own ping arriving
  before the app bound :10301. A narrower poller confirmed readiness; the
  session itself never failed.
- Stop: `lane.json` was read first (launcherPid 67808, lane 13). Then
  `npm run e2e:stop` exited 0 with "stopped session launcher 67808 (+
  children)", "dropped lane 13 tables (hc-local-13-*)", "released lane 13
  lease" and "stale owned session state cleanup complete".
- Proof: `Get-NetTCPConnection -State Listen` found nothing on 10301, 10311,
  10321 or 10331. Launcher 67808 is not running; `session.pid` and
  `lane.json` are gone. The background session task reported exit 1 when the
  stop tree-killed its launcher (expected; S3 and S7 recorded the same).
- The only processes still naming this worktree are the planner's transcript
  mirror and a ledger watchdog. They are not mine and were left untouched. No
  shared container was touched.
- Session and run logs: 0 `[dynamoAdmin]` lines, 0 error-level app lines,
  0 5xx.

## Deviations from the list (and why)

1. F-7 reset name: `resetBulkBatchStoreForTests`, not
   `__resetBulkBatchStoreForTests`. It follows the repo's one test-only export
   precedent, `resetServerClockForTests` (`dashboard/src/api/serverClock.ts:52`).
2. F-7 test comments: the existing tab-round-trip test's code is unchanged.
   Two of its comments, and one in the dropped-rows test, said "page's
   pointer / flag"; they now say "module's slot / flag".
3. F-3 placement: added as a SIBLING of the bulk test (`:870`) rather than by
   editing the bulk test in place. Making the bulk test's second id re-read
   as scheduled would have deleted its canceled-skip and
   failed-row-stays-selected assertions. Those are the only pin of spec 4.5
   step 3 ("keep it for the ones that failed"). The sibling is otherwise the
   adjudicated design, plus a 50 ms settle so a wrongly concurrent runner is
   caught (shown by the control).
4. F-6: all four pins are new tests; no existing test was edited.
5. F-8: the test file is new. It adds a second, positive test (the on-screen
   contact's setter still applies, no refetch) so the guard cannot silently
   disable the normal path.
6. F-11, `TourDetail.tsx:551` -> `630`, mapped by meaning:
   - The literal method (read the base line, find it at HEAD) would have
     pointed the terminal at the Mark-toured button.
   - When written (`db68fee8`), line 551 was the "Back to tours" link, which
     is exactly what the ledger's terminal names (`TOUR_DETAIL_TERMINAL`,
     `e2e/performance/routes.ts:471`, `locator('link', 'Back to tours')`).
   - On main it had drifted to the Mark-toured CTA before this branch; the
     link was at base `:595`.
7. F-11, `useTours.ts:112-149` -> `121-150`: the old end overran the file
   (141 lines when written at `084df55d` and at base). The new range is what
   the old one actually covered: the `useClosedTours` effect through the
   hook's end. A blind +9 would have ended inside the Past-tab code.
8. Extra evidence, never committed: e2e run 2's geometry probe and the three
   unit mutations. Each was restored and verified with `git diff --quiet` /
   `git hash-object`.

## For the re-reviewer - look at these cold

- The module store's lifetime is the browser tab.
  - A batch whose last PATCH never settles would keep every Past control
    disabled until a full reload. Before, it held until the page unmounted.
  - `getTour` / `patchTour` failures are caught, and `reload` is a state
    setter, so no throw path skips `setBatchRunning(false)`. But a hung
    request, with no timeout, now pins the tab rather than one page instance.
  - I believe this is the intended trade (spec 4.5, "one batch"). It is the
    change I am least sure is wanted at scale.
- Lint was not run (the mission says so). By reading, the store respects
  `react-hooks`:
  - the module writes sit in the runner (an event handler) and in an effect
    callback;
  - `react-hooks/globals` is emitted for a nested function only when that
    function is rendered or mutated (plugin 7.1.1 source; `useEffect`
    freezes its argument);
  - no `useState` setter runs in an effect.
  - Gate 5 should confirm.
- `ToursPage.tsx` now exports a non-component (`resetBulkBatchStoreForTests`).
  No lint rule in this repo objects. Vite Fast Refresh will full-reload this
  module on edit in dev; a production build is unaffected.
- F-2's 8.5rem trailing slot is sized by measurement: "Mark toured" is 99.4px
  and "Record outcome" is 96.9px, at the default font size. A future longer
  action label would need the slot widened.
- The `:empty` rule depends on React rendering no whitespace nodes in the
  action span. That holds today (two conditional expressions) and was
  measured at 360px (the No-show row gains no line). A future edit that adds
  literal text or whitespace inside the span would silently re-open a blank
  line.
- The F-8 harness is a hook-level stand-in shaped like ContactDetail, not
  ContactDetail itself. The real page also unmounts the file pane while
  `useContact` derives loading; F-9's key covers the case where it does not.

## Found, not changed (outside F-11's explicit list)

Two more ledger citations in `e2e/performance/routes.ts` point at files this
branch shifted. Both were ALREADY stale on main at `0dafe3c1`, and this branch
moved them further:

- `:126` and `:765` cite `dashboard/src/App.tsx:117-249`. When written this
  was `function AuthedApp()` onward; that function is at `:129` at both base
  and HEAD, and the range end drifted too.
- `:757` cites `dashboard/src/routes/contact/TenantFile.tsx:152`. When written
  this was the Details card's `title="Details"`, which is base `:169` and
  HEAD `:175`.

Both belong with a repo-wide ledger refresh (the OD-1 issue
`perf-pages-tours-past-surface` already asks for one) rather than this wave.
