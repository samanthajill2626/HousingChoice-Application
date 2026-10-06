# Slice report - S8a (dashboard: api, tourReopen, kebab item, Reopen dialog, 409 copy)

- Date: 2026-10-02. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD 65442533 (S6-S7 report commit).
- Scope: the first half of S8 - Tasks 8.1, 8.2, 8.3, 8.4, 8.4b. The second half
  (8.5 tour page wiring, 8.6 Tours page, 8.7 Today, 8.8 labels) is a separate
  dispatch; TourDetail.tsx got ONLY the 8.1 retype + import swap.
- Sources followed: plan sections 0, 1 and S8 Tasks 8.1-8.4b; spec 9.1, 9.2,
  14 (D7, D14); the reopen route contract in `slices/s6-s7-report.md` section
  6; the binding corrections in `research/drift-s8-dashboard.md` (1-11,
  section 2, section 5) and ruling D-i in `research/worklist.md`, as amended by
  the dispatch brief (8.4's cases in a NEW TourModals.test.tsx rendering the
  dialog directly; 8.4b's cases page-level in TourDetail.test.tsx); the
  reference quotes in `.superpowers/sdd/research/ref-s8-dashboard.md`.
- No STOP condition was hit: no unexpected importer (the only `TourOutcome`
  users were the three files the plan names, plus `TOUR_OUTCOME_LABELS`; e2e
  imports none of these types), no contract mismatch with the S6-S7 report or
  the reference quotes, no unpredicted red in an existing test (the one the
  plan predicted, TourDetail.test.tsx "a failed PATCH keeps the dialog open",
  was switched to a 500 as instructed).

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| d4ffffef | 8.1 | feat(tours): dashboard api - no_outcome, StaffTourOutcome, reopenTour |
| de119593 | 8.2 | feat(tours): tourReopen - the dashboard mirror of reopenTargetFor |
| 01531a50 | 8.3 | feat(tours): kebab "Reopen tour" item behind optional canReopen |
| 28ca84f7 | 8.4 | feat(tours): ReopenTourModal - confirm a reopen, say where it goes |
| 90393eca | 8.4b | feat(tours): every writing tour dialog maps a 409 to "reload" |
| 02c92a56 | pin | test(tours): pin that no person can record no_outcome (compile time) |
| (this) | records | docs(records): tour auto-close S8a slice report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD checked
absent (`git rev-parse --git-path MERGE_HEAD` - `.git` is a file in a
worktree), explicit paths staged, ASCII message, `Co-Authored-By: Claude Opus
5.5` trailer, committed through Bash with a heredoc.

Files: `dashboard/src/api/types.ts`, `dashboard/src/api/endpoints.ts`,
`e2e/performance/mutationCatalog.ts`, `e2e/performance/mutationCatalog.test.ts`,
new `dashboard/src/routes/tours/tourReopen.ts` + `tourReopen.test.ts`,
`TourActionsMenu.tsx` + `TourActionsMenu.test.tsx`, `TourModals.tsx`, new
`TourModals.test.tsx`, `TourDetail.tsx` (two lines: the import swap :42 and
`confirmOutcome`'s type :532), `TourDetail.test.tsx` (the import :85, the
switched test :556, its 409 twin :573, the new describe :815-921). Nothing
else.

## 2. Per task: RED reason, GREEN result

Baseline before any edit: catalog test 4 passed; `npx eslint` on the nine
existing files of the brief's list: ONE pre-existing error,
`TourDetail.tsx:311:85 react-hooks/purity` ("Cannot call impure function
during render" - `Date.now()` in the `startPassed` guard). It is still there,
same position, on a line this slice never touched.

| task | RED (run, confirmed reason) | GREEN |
|---|---|---|
| 8.1 | catalog entry + pin 111 written first: 1 failed / 3 passed - `expected [ Array(110) ] to have a length of 111 but got 110` (the scanner found no `reopenTour` yet) | catalog 4 passed; sanity TourDetail 93 + TourActionsMenu 7 (the retype touched both files' modules) |
| 8.2 | suite failed to load: `Failed to resolve import "./tourReopen.js"` (module absent) | tourReopen 7 passed |
| 8.3 | 3 failed / 10 passed (13): "shows a Reopen tour item" and "counts toward the nothing-qualifies check" - `Unable to find ... button ... /more actions/i` (canReopen ignored, kebab null); "is the LAST item" - `expected [ 'Reschedule', 'Cancel tour' ] to deeply equal [ ..., 'Reopen tour' ]`. The 3 hide-cases (props omitted; canReopen false with a handler; canReopen without a handler) passed on unchanged code - PINs | TourActionsMenu 13 passed; sanity TourDetail 93 |
| 8.4 | 6 failed (6): five `Element type is invalid ... got: undefined` (ReopenTourModal not exported) and `expected undefined to be 'This tour changed since the page load...'` (TOUR_CHANGED_COPY not exported) | TourModals 6 passed; sanity TourDetail 93 |
| 8.4b | 5 failed / 97 passed (102): each 409 case received its dialog's GENERIC copy - "Couldn't mark the tour as toured / schedule the tour / reschedule the tour / record the outcome / cancel the tour - please try again." The 4 new non-409 cases and the switched Mark-already-toured test (now a 500) passed on unchanged code - PINs | the four files: 128 passed (tourReopen 7, TourActionsMenu 13, TourModals 6, TourDetail 102) |
| pin | with mutant j1 live: dashboard typecheck exit 2, `TourModals.test.tsx(136,40): error TS2344 ... Actual: literal string: no_outcome` | after the revert: typecheck exit 0; TourModals 7 passed |

Final run on the committed tree: `npx vitest run` of the four dashboard files
- 4 files, 129 passed, exit 0 (tourReopen 7, TourActionsMenu 13, TourModals 7,
TourDetail 102). Catalog test 4 passed, exit 0.

## 3. Gates run (scope: touched files + typecheck, per the brief)

- `npm run typecheck`: exit 0 after 8.1, 8.2, 8.3, 8.4, 8.4b, after the pin,
  and on the final committed state.
- `npx eslint` on the brief's full 12-file list: exit 1, and the ONLY problem
  is the baseline error above (`TourDetail.tsx:311:85`, react-hooks/purity) -
  no new error on any touched line. Each task's own files linted exit 0
  (TourDetail.tsx aside, which carries the baseline error).
- Catalog test (`npm run test -w @housingchoice/e2e --
  performance/mutationCatalog.test.ts`): 4 passed, exit 0.
- ASCII: after every edit the added lines of `git diff -U0` were checked; the
  three new files have 0 non-ASCII bytes (`tr` check); a final scan of every
  added line of `git diff -U0 65442533..HEAD` printed nothing. Untouched
  non-ASCII lines remain where they were (TourModals.tsx :7, the curly quotes
  in the date dialog's warning, endpoints.ts tours-section header, the
  `Tour` doc arrows / em dashes in types.ts) - the ratchet allows them; every
  line this slice edited is ASCII (endpoints.ts's `patchTour` doc, which had an
  em dash, was rewritten in full).
- NOT run (outside this brief): `npm test`, `npm run smoke`, `npm run e2e`.

## 4. Divergences from the plan, and why

Binding corrections applied: drift #2 (`reopenTour` mirrors createTour's
`request` + `{ method: 'POST', body }`; parameter named `tourId` - the scanner
reads `:tourId`), #3 (no `api/index.ts` edit - `export *`), #4 (each of the
three files swapped `TourOutcome` for `StaffTourOutcome` in the same edit), #5
(the `patchTour` doc rewritten ASCII), #6 (`autoClosedFrom: 'canceled'` and
`'closed'` rows built `as unknown as Tour`), #7 / #8 (see 3 below), #10
(`ApiError` VALUE import; `catch (err)` in all four catches; the Book /
Reschedule 409 cases submit `localDatetime(2 * DAY)`), #11 (header: six
dialogs, the Reopen bullet, the shared 409 rule; :7 not edited, so it keeps
its em dash).

Within the brief's latitude - each a deliberate choice:

1. TOUR_CHANGED_COPY and the `ApiError` import landed in 8.4, not 8.4b: the
   Reopen dialog (8.4) is the constant's first user and its 8.4 test asserts
   it. 8.4b then wired the four existing catches.
2. 8.4b routes all five catches (four existing + Reopen) through ONE
   module-private helper, `failureCopy(err, retryCopy)` (TourModals.tsx:44),
   so the `err instanceof ApiError && err.status === 409` branch exists once.
   Each catch still binds `err` and passes its own retry copy, so "drop the
   409 branch in one dialog" is still one edit (mutant a).
3. TourActionsMenu, drift #7: one derived value,
   `const reopen = canReopen ? onReopen : undefined` (:93), read by BOTH the
   item and the "nothing qualifies" check (`reopen === undefined` rather than
   a literal `!canReopen`). Equivalent to `!canReopen` whenever the parent
   passes the handler (8.5 always does); when a caller passes `canReopen`
   without `onReopen` it renders neither a dead item nor an EMPTY kebab
   (pinned: "canReopen without an onReopen is no item and no kebab"). Drift
   #8: the header now lists every item in menu order (incl. Send no-show
   check-in and Reopen); the null-check comment was reworded; the
   `'\u22EF'` escape (now :127) was never in an Edit string and is intact.
4. The TourModals header's "five" -> "six" and the Reopen bullet landed WITH
   the dialog (8.4) so that commit's header is true; the shared 409 rule
   paragraph landed in 8.4b.
5. Test homes: 8.4's Reopen cases all live in the new TourModals.test.tsx
   (orchestrator decision; one dialog, one file). 8.4b: the Mark-already-
   toured 409 case sits beside the switched test in its own describe (it
   reuses that describe's opener and beforeEach); Book, Reschedule, Record
   outcome and Cancel share one new table-driven describe with a 409 case AND
   a non-409 case each. The non-409 cases are PINs (green before GREEN); they
   are what kills a "any ApiError says reload" mutant (f). The 409 cases use
   the realistic codes (illegal_status_transition, tour_changed with detail,
   illegal_exit_gate); the non-409 ones vary (400, 500, a plain Error, 404).
6. Tests beyond the plan (additive, none dropped): tourReopen - a
   `'closed'` off-union autoClosedFrom, the move_forward + convertible row
   (the kebab's case), a guard that NOT_CLOSED has 5 statuses; TourActionsMenu
   - the item is last, canReopen false with a handler, canReopen without a
   handler; TourModals - the confirm is the primary (non-danger) variant, the
   busy label and BOTH buttons disabled in flight, all four reopen 409 codes,
   four non-409 failure kinds.
7. Survivor pin (section 5, j1): a compile-time `expectTypeOf` test in
   TourModals.test.tsx (the S5 precedent, `tourAutoClose.test.ts:373`) pins
   the Record outcome dialog's decided outcome and `patchTour`'s sent outcome
   to exactly `'move_forward' | 'not_a_fit'` - the brief's binding "no_outcome
   must not become recordable anywhere" had no other guard.
8. Copy not given by the spec: the Reopen confirm's busy label is
   `'Reopening...'` (mirrors Cancel's `'Canceling...'`). Docs added beyond the
   plan's: `reopenTour` names 404 tour_not_found and "none carries a detail";
   `patchTour` names its 409 codes as reload-not-retry; `Tour.outcome` now says
   the sweep writes `no_outcome` and reopen removes it (drift section 4's
   stale-comment list); RecordOutcomeModal's onConfirm doc gained one line.
9. Placement: the three new `Tour` fields sit after `convertedPlacementId`
   (before `createdAt` / `updatedAt`, whose em-dash docs stayed untouched);
   `reopenTour` sits directly after `patchTour`; the catalog entry beside
   `createTour` (order-free comparison - cosmetic).

## 5. Mutant check (applied with Edit, reverted with Edit; `git diff --quiet` clean after each)

| id | mutant | result |
|---|---|---|
| a | Cancel dialog catch: `setError("Couldn't cancel ...")` (409 branch dropped) | KILLED by "Cancel tour?: a 409 shows the reload copy" |
| b | `reopenTargetOf`: autoClosedFrom `no_show` -> `'toured'` | KILLED by 2 ("returns an auto-closed tour to the status it closed from", "autoClosedFrom wins") |
| c | kebab: `reopen = onReopen` regardless of canReopen | KILLED by "canReopen false hides the item even with a handler" |
| d | catalog: the reopenTour entry removed | KILLED: `expected [ ...(111) ] to deeply equal [ ...(112) ]`, diff names the reopenTour fingerprint |
| e | Reopen confirm renamed "Reopen tour" | KILLED by 4 TourModals cases |
| f (extra) | `failureCopy`: any ApiError -> TOUR_CHANGED_COPY (status ignored) | KILLED by 5 non-409 pins (Reopen generic, Mark already toured 500, Schedule 400, Reschedule 500, Cancel 404) |
| g (extra) | Reopen confirm `variant="danger"` | KILLED by the non-danger case (`toHaveClass("_primary_60b723")` - the CSS-module assertion is real under vitest) |
| h (extra) | Reopen: `onClose()` BEFORE `await onConfirm()` | KILLED by 3 (confirm-then-close, both error cases) |
| i (extra) | `reopenTargetOf`: converted check dropped | KILLED by the converted case |
| j1 (extra) | `patchTour` outcome `StaffTourOutcome \| 'no_outcome'` (type only) | SURVIVED typecheck + 128 tests -> PINNED in 02c92a56 (typecheck RED with it live, GREEN after revert) |
| j2 (extra) | RecordOutcomeModal decision `StaffTourOutcome \| 'no_outcome'` (type only) | KILLED by typecheck even before the pin: `TourDetail.tsx(831,60) TS2322` (confirmOutcome stays StaffTourOutcome); the pin now also covers it directly |

Totals: 11 mutants (5 required + 6 extra), 10 killed outright, 1 survivor
pinned. After the last revert: tree clean, the four dashboard files 129
passed, typecheck exit 0, lint = baseline only.

## 6. Contracts the second S8 half consumes (final, as committed)

### From `./TourModals.js` (TourDetail.tsx imports it at :64-70)

```ts
export const TOUR_CHANGED_COPY = 'This tour changed since the page loaded - reload and try again.'; // :39
export function ReopenTourModal(props: {
  target: ReopenTarget;            // the page's SNAPSHOT (reopenFor), not live state
  onClose: () => void;
  onConfirm: () => Promise<void>;  // POST + apply; resolve = success, throw = stay open
}): React.JSX.Element;             // :439
```

Behavior: dialog title "Reopen tour"; body `REOPEN_BODY[target]`; buttons
"Cancel" (calls onClose only) / "Yes, reopen" (primary variant; busy label
"Reopening...", both buttons disabled in flight). The confirm AWAITS
onConfirm, THEN calls onClose - so the page must pass the guarded close
`setModal((m) => (m === 'reopen' ? null : m))` or a toured target's hand-off
to Record outcome is shut at once (spec 9.2). A thrown `ApiError` with status
409 shows TOUR_CHANGED_COPY; anything else "Couldn't reopen the tour - please
try again."; the dialog stays open and re-enables. The Modal's X and Escape
also call onClose (the guard covers them).

### From `./tourReopen.js`

```ts
export type ReopenTarget = 'scheduled' | 'toured' | 'no_show';
export function reopenTargetOf(tour: Tour): ReopenTarget | null; // null where POST /reopen refuses
export const REOPEN_BODY: Readonly<Record<ReopenTarget, string>>; // the three spec 9.2 bodies
```

### `TourActionsMenu` (new optional props)

`canReopen?: boolean` (default false) and `onReopen?: () => void`. The
"Reopen tour" item (`<button role="menuitem">`) is LAST and shows only when
`canReopen === true` AND `onReopen` is given; that alone makes the kebab
render (8.5's convertible closed tour has no other branch action). 8.5 passes
`canReopen={reopenTarget !== null && tour.convertible === true}` and
`onReopen={openReopen}` - add them beside `busy={busy}` (:666).

### From `../../api/index.js`

```ts
export async function reopenTour(tourId: string): Promise<Tour>; // endpoints.ts:2694
// POST /api/tours/:tourId/reopen, body {}, unwraps { tour }; throws ApiError (404 / 409 x4 / 500)
export type StaffTourOutcome = Exclude<TourOutcome, 'no_outcome'>; // types.ts:916
// TourOutcome now includes 'no_outcome'; TOUR_OUTCOME_LABELS.no_outcome = 'No outcome recorded'
// Tour gains autoClosedAt?: string, autoClosedFrom?: 'scheduled' | 'toured' | 'no_show', lastMarkedAt?: string
```

TourDetail.test.tsx's barrel mock (:50-76) spreads `...actual`, so 8.5 must
add `const reopenTour = vi.fn();` beside `patchTour` (:41) and
`reopenTour: (...a: unknown[]) => reopenTour(...a),` to the factory, or the
real fetch runs (drift #13).

### TourDetail.tsx anchors (S8a changed only :42 and :532, in place - no line moved)

| anchor | lines |
|---|---|
| api barrel import (add `reopenTour`; `type StaffTourOutcome` at :42) | :29-46 |
| `shortDate` import (Outcome card date) | :57 |
| TourModals import (add `ReopenTourModal`) | :64-70 |
| modal union - the inline `useState` generic (add `'reopen'`) | :273-275 |
| guards (`isConverted` :334) | :300-334 |
| confirm handlers (`confirmOutcome` :531-562, `confirmCancel` :563-567 - `confirmReopen` goes after it) | :504-567 |
| primary CTA ladder (`let primaryCta` :570; the toured-without-outcome rung :595-601 - the Reopen `else if` follows it) | :569-601 |
| literal `'\u2190'` escape - keep it out of every Edit string | :638 |
| header actions: `{primaryCta}` :649, `<TourActionsMenu` :650-667 (`busy` :666) | :648-668 |
| Outcome card (`KV Outcome` :795, `KV Moving forward` :796) | :789-806 |
| modal renders (guarded already-toured precedent :820-829; outcome :830-832; cancel :833-835 - render Reopen after it) | :814-835 |

TourDetail.test.tsx after S8a: `TOUR_CHANGED_COPY` imported at :85; the
"no kebab" pin "a closed tour with a group has no kebab at all" at :450 (its
closed + not_a_fit fixture will show the Reopen CTA after 8.5, still no
kebab); the 409 describe at :815-921.

## 7. Observations for the orchestrator (no action taken)

- The brief says worktree files are CRLF; they are LF. `.gitattributes`
  forces `* text=auto eol=lf` and `git ls-files --eol` shows `i/lf w/lf`; no
  file in scope had a CR. The new files were written LF.
- Spec 9.1's `TimelineMilestoneType` entries (`tour_auto_closed`,
  `tour_reopened`) already landed in S3 (377a67e8; now types.ts :2528-2529)
  - nothing was owed here.
- For 8.5's tests: with the Reopen dialog open, a REGEX `/reopen/i` button
  query matches both the header CTA "Reopen tour" and the confirm "Yes,
  reopen"; use exact names (the spec's reason for the label split).
- F7 still stands (header-alert direct actions - Mark toured CTA, Mark
  no-show kebab - show the raw `ApiError.message` on a 409; spec 8.3 accepts;
  D14 covers dialogs only).
- The pre-existing lint error `TourDetail.tsx:311:85` (react-hooks/purity) is
  not this branch's; 8.5 edits TourDetail.tsx, so its gate-5 run will show it
  again - attribute it by baseline, as here.
- The TourActionsMenu header now states the 8.5 contract ("anywhere else
  Reopen IS the primary CTA") one commit ahead of 8.5's wiring.
