# S4a slice report - dashboard, open-group dialog half (S4.1-S4.5)

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base 437218e6 (S3 report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S4.1-S4.5 (plan lines 14029-15514; sections 0-3 and the 3.2 rulings
binding; R21 applied - of the eight accepted S4 decisions, P-1, P-2 and P-8
land in these tasks, P-3..P-7 belong to S4.6-S4.13). The "S4 additions" of
`research/worklist-deltas.md` that apply here were applied: the S4.1
`RosterSource` comment (S4-F7), the S4.2 test comment (S4-F2), and the gate-5
baseline note (S4-F8). Implementer: Claude Opus 5.5, alone in the worktree.
Date: 2026-10-13.

No `npm test`, `npm run e2e`, `npm run e2e:session` or `npm run dev` was run.
No background command was left running. Dashboard tests need no Docker.
Tasks S4.6-S4.13 were NOT started.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S4.1 | 56a94b1e | feat(dashboard): primary-contact wire types; People card suggestions skip deleted property contacts |
| S4.2 | 33eb61ca | feat(dashboard): open-group dialog explains the general intro fallback, with Check again |
| S4.3 | 2905b44c | feat(dashboard): open-group dialog keeps an edited intro when the preview changes |
| S4.4 | e47c2274 | feat(dashboard): tour open-group dialog wires the intro heading and Check again |
| S4.5 | 48b0d780 | feat(dashboard): placement open-group dialog wires the intro heading and Check again |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent
(`git rev-parse -q --verify MERGE_HEAD || echo no-merge-in-progress`),
explicit paths only, the plan's subject, the `Co-Authored-By: Claude Opus
5.5` trailer. S4.1 and S4.2 each carry one extra body line naming the
worklist addition folded into them (D1). Before each commit: `git diff -U0`
added lines ASCII-clean, and every touched file has zero CR bytes (LF kept).
`npm run typecheck` after each task's commit: `EXIT:0`, 0 `error TS` lines
(logs `.superpowers/sdd/S4a-typecheck-S4.<n>.log`).

## 2. Files touched (10)

`git diff --stat 437218e6..HEAD` before this report: 10 files, 879+ / 18-.

- `dashboard/src/api/types.ts` (S4.1)
- `dashboard/src/routes/shared/rosterPeople.ts`, `rosterPeople.test.ts` (S4.1)
- `dashboard/src/routes/shared/RosterConfirmDialog.tsx`,
  `RosterConfirmDialog.test.tsx` (S4.2, S4.3)
- `dashboard/src/routes/shared/RosterConfirmDialog.module.css` (S4.3)
- `dashboard/src/routes/tours/TourDetail.tsx`, `TourDetail.test.tsx` (S4.4)
- `dashboard/src/routes/placements/PlacementDetail.tsx`,
  `PlacementDetail.test.tsx` (S4.5)

All inside the brief's file list. Nothing outside it was needed.

Byte-exactness: a read-only script extracted every `new_string:` fenced
block of plan lines 14102-15514 and counted it in the edited files. All 27
blocks are present exactly once (S4.1 8, S4.2 8, S4.3 5, S4.4 3, S4.5 3). The
S4 blocks are flush-left in the raw plan (only the fences are list-indented),
as the research reference says.

## 3. Tests and RED/GREEN evidence

Logs: `.superpowers/sdd/S4a-S4.<n>-{red,green}.log` (+ `-tsc.log`). vitest
prints a Unicode ellipsis in truncated values; quoted here as `...`.

Baseline before any edit (`S4a-baseline-vitest.log`, `EXIT:0`):
rosterPeople 4, RosterConfirmDialog 33, TourDetail 128, PlacementDetail 42,
PeopleCard 58, CreateRelayGroupModal 48 - the counts the plan's arithmetic
assumes.

### S4.1 - `rosterPeople.test.ts` (+1)

describe `rosterSuggestions`: "never suggests a row whose contact is deleted,
primary or not".

- RED: `FAIL  src/routes/shared/rosterPeople.test.ts > rosterSuggestions >
  never suggests a row whose contact is deleted, primary or not`,
  `AssertionError: expected [ { contactId: 'c-pm', ...(4) }, ...(2) ] to
  deeply equal [ { contactId: 'c-own', ...(3) } ]`, `Tests  1 failed | 4
  passed (5)`. `npx tsc -p tsconfig.json --noEmit` -> `EXIT:2` with
  `rosterPeople.test.ts(95,51): error TS2353: ... 'deleted' does not exist in
  type 'UnitContact'.` and the same at `(101,7)` (one per literal).
- GREEN: `Tests  5 passed (5)`; tsc `EXIT:0`, no output.

### S4.2 - `RosterConfirmDialog.test.tsx` (+21)

describe "RosterConfirmDialog - the intro fallback box
(primary-contact-integrity spec 7.1)": "renders ABOVE the message with the
tour heading and one line per reason, in reason order"; "lists the reasons
in reason order even when they arrive out of order"; "uses the placement
heading on a placement"; `it.each` "%s renders its line and its link (%o)"
x10 (no_property_contact with and without a street, property_contact_deleted
with and without, property_contact_is_tenant, property_contact_no_first_name,
no_street_address, tour_not_scheduled, tour_started, lookup_failed); "omits a
link whose id is absent"; "Check again runs the caller, is disabled while it
runs, and comes back"; "a failed Check again renders in the error line and
the dialog stays open"; "a failed Check again shows the server's own sentence
when it sent one"; "offers no Check again without an onCheckAgain"; "renders
no box when the preview carries no introFallback (standalone and add-member
previews)" (pin); "renders no box when the caller names no owner (there is no
heading to give)" (pin); "sits beside the duplicate warning: two status
blocks, the duplicate one unchanged".

- RED: 18 x `TestingLibraryElementError: Unable to find an accessible element
  with the role "status"` and 1 x `AssertionError: expected [ <div ...(2)>...(3)
  </div> ] to have a length of 2 but got 1`; the two pins passed;
  `Tests  19 failed | 35 passed (54)` - exactly the plan's split.
- GREEN: `Tests  54 passed (54)`; tsc `EXIT:0`.

### S4.3 - `RosterConfirmDialog.test.tsx` (+5)

describe "RosterConfirmDialog - the edited-draft rule
(primary-contact-integrity spec 7.2)": "an UNEDITED draft takes the new body,
with no notice" (pin); "an EDITED draft is KEPT on a new preview, and the
dialog says the intro changed"; "\"Use the updated intro\" takes the new body
and clears the notice; sent untouched, it posts no introBody"; "a KEPT edit is
what is sent - it differs from the CURRENT preview body"; "after \"Use the
updated intro\" the draft is unedited again: the next preview replaces it".

- RED: `Error: expect(element).toHaveValue(My own words for Keisha and Mark.)`
  receiving SECOND ("Hey Keisha! It's Sam. Putting you in a group text with
  Mark to tour 470 Bolton Rd NW on Fri Oct 16."); 2 x `TestingLibraryElementError:
  Unable to find an accessible element with the role "button" and name "Use
  the updated intro"`; `AssertionError: expected "spy" to be called with
  arguments: [ false, ...(1) ]` (received `[ false, undefined ]`); the
  UNEDITED pin passed; `Tests  4 failed | 55 passed (59)`.
- GREEN (with the two unchanged dialog callers the plan names):
  `Test Files  3 passed (3)`, `Tests  165 passed (165)` - RosterConfirmDialog
  59, PeopleCard 58, CreateRelayGroupModal 48. tsc `EXIT:0`. eslint on the
  dialog + its test right after: `EXIT:0` (the `set-state-in-effect` error is
  gone).

### S4.4 - `TourDetail.test.tsx` (+3)

describe "TourDetail - the intro fallback box and Check again
(primary-contact-integrity spec 7.1)": "the open dialog explains the general
intro with the TOUR heading and links to the property"; "Check again re-runs
the preview and swaps the unedited draft for the tour intro"; "Check again
answered 409 relay_already_provisioned closes the dialog and refetches the
roster".

- RED: first test `Unable to find an accessible element with the role
  "status"`, the other two `Unable to find an accessible element with the
  role "button" and name "Check again"`; `Tests  3 failed | 128 passed (131)`.
- GREEN: `Tests  131 passed (131)`; tsc `EXIT:0`.

### S4.5 - `PlacementDetail.test.tsx` (+3)

describe "PlacementDetail - the intro fallback box and Check again
(primary-contact-integrity spec 7.1)": "the open dialog explains the general
intro with the PLACEMENT heading and links to the property"; "Check again
re-runs the preview and swaps the unedited draft for the placement intro";
"Check again answered 409 relay_already_provisioned closes the dialog and
refetches the roster".

- RED: same two messages as S4.4; `Tests  3 failed | 42 passed (45)`.
- GREEN: `Tests  45 passed (45)`; tsc `EXIT:0`.

No GREEN log carries a `not wrapped in act` or `Warning:` line.

## 4. What the new UI exposes (for the e2e slice)

All inside the open-group dialog: `role="dialog"`, name `Open the relay
group?` (tour and placement OPEN surfaces only).

The fallback box - rendered ONLY when `preview.introFallback` is present AND
the caller passed `introOwner` (so never on the standalone
CreateRelayGroupModal or the PeopleCard add-member dialog):

- A `<div role="status">` with the duplicate warning's class
  (`.duplicateWarning`: `--c-warning` border). It sits ABOVE the `region`
  named `Message preview`. When the duplicate warning also shows, the dialog
  holds TWO `role="status"` nodes: the fallback box FIRST in DOM order, the
  duplicate warning after the message. Filter by text.
- Heading: a `<strong>` in the first `<p>`: `Using the general intro, not the
  tour intro.` or `Using the general intro, not the placement intro.`
- One `<p>` per reason, in spec 5.1 order (the client re-sorts; unknown
  reasons are dropped), text exactly the spec 7.1 table. `<Street>` is
  `introFallback.street`, else `this property` / sentence-initial `This
  property`.
- Links (role `link`, inside their line's `<p>`, after a single space; every
  one `target="_blank" rel="noreferrer"`; omitted when the id is absent):
  - `Set a primary contact` -> `/listings/<encodeURIComponent(unitId)>`
    (no_property_contact, property_contact_deleted, property_contact_is_tenant)
  - `Add a first name` -> `/contacts/<encodeURIComponent(propertyContactId)>`
    (property_contact_no_first_name)
  - `Add the address` -> `/listings/<encodeURIComponent(unitId)>`
    (no_street_address)
  - tour_not_scheduled, tour_started, lookup_failed: no link.
- Button `Check again` (role `button`, secondary, small), in the box's last
  `<p>`, only when the caller passed `onCheckAgain` (both callers do). It is
  `disabled` (never `loading`, so no Spinner `role="status"` appears) while the
  re-fetch runs and while a confirm is in flight.
- A failed Check again: the dialog's existing `<p role="alert">` reads the
  server body's `message` when present, else `Couldn't check again - please
  try again.` A 409 `relay_already_provisioned` closes the dialog and
  refetches the roster (no alert).
- e2e matching note: each reason `<p>`'s full text content is the sentence
  PLUS ` <link label>` when a link renders, so an EXACT whole-text match on the
  sentence will not hit the `<p>`; use the default substring match or a regex.

The edited-draft note (editable dialogs only), inside the `Message preview`
region, under the character count: a `<p>` reading `The intro changed.`
followed by button `Use the updated intro` (secondary, small; disabled while a
confirm is in flight). Shown only when the operator's edited draft was kept
over a newer preview body.

## 5. `RosterConfirmDialogProps` added (exact)

```ts
  introOwner?: 'tour' | 'placement';
  onCheckAgain?: () => Promise<void>;
```

Callers: `TourDetail.tsx` passes `introOwner="tour"
onCheckAgain={checkOpenPreviewAgain}`; `PlacementDetail.tsx` passes
`introOwner="placement" onCheckAgain={checkOpenPreviewAgain}` (a
`useCallback` on `[placementId, roster]`). Both re-fetches use a functional
`setOpenPreview((prev) => (prev === null ? null : next))`, so a dialog that
closed meanwhile stays closed.

Wire types added to `dashboard/src/api/types.ts` (mirrors of S3's shipped
shapes, cross-checked against `app/src/jobs/relayFanOut.ts` and
`app/src/routes/units.ts`): `IntroFallbackReason`, `IntroFallback`,
`RosterPreview.introFallback?`, `UnitContact.deleted?: true` /
`caseworker?: true`, `UnitPropertyContact`, `UnitItem.propertyContact?`,
`UnitActivityEvent.reason?: string`, and `unit_primary_contact_assigned` in
the activity event-type docblock. No contract mismatch with the shipped wire.

## 6. Divergences from the plan text

- D1 (brief: worklist S4 additions). Two comment-only edits the plan's task
  text does not carry, each folded into its task's commit with a body line:
  S4.1 rewrites the `RosterSource` docblock in `api/types.ts` (the `default`
  roster is the tenant plus the PROPERTY CONTACT - flagged primary, else the
  landlord of record, skipping a deleted or missing contact; spec 4.1)
  (S4-F7); S4.2 rewrites the duplicate-warning test comment in
  `RosterConfirmDialog.test.tsx` ("renders nothing when there is no
  duplicate") that called that block the dialog's only `role=status` (S4-F2).
  The assertion itself is unchanged.
- D2 (RED shape, cosmetic). S4.1's tsc RED prints TWO TS2353 lines (one per
  object literal carrying `deleted`), where the plan quotes one shape. S4.3's
  KEPT-edit failure prints `[ false, ...(1) ]` (vitest truncation) where the
  plan spells the argument out. Counts match the plan everywhere.
- D3 (brief). The plan's per-task "Run GREEN" steps run `npx tsc -p
  tsconfig.json --noEmit` in `dashboard/`; the brief also asks for `npm run
  typecheck` after each task's commit - both ran, all exit 0.

No code divergence: every plan code block landed byte-identical (section 2),
every predicted RED matched, every GREEN matched its expected count.

## 7. Worries for the orchestrator (non-blocking)

- W1. While Check again runs, only the Check again button is disabled; the
  footer (Cancel / Open relay group / Send now anyway) stays enabled (`busy`
  is the confirm's flag only, as the plan wrote it). A confirm clicked
  mid-check posts the draft the operator sees at that moment; if the check
  then resolves while the confirm is in flight, the dialog re-renders the new
  preview under it. Harmless (the send is the server's composition or the
  operator's visible text), but the two can overlap.
- W2. P-8 drops unknown reasons. A newer server sending ONLY unknown reasons
  would show the heading (and Check again) with no explanatory line.
- W3. The edited-draft rule counts a CLEARED box as edited (`draft !==
  seed`): a new preview then keeps the empty box and shows "The intro
  changed." `run` still treats a cleared box as untouched (posts no
  `introBody`), so nothing wrong is sent.
- W4. Check again clears the error line before re-fetching, so a prior
  confirm refusal sentence disappears when the operator clicks it.
- W5 (for S5). Every timeless tour opened in the existing e2e walks
  (`tour-roster.spec.ts`, `roster-quiet-hours.spec.ts`, `scenarios/steps.ts`
  `teamOpensTourGroup`) now shows the box with `This tour has no date and
  time yet.` (worklist S3-F9 / S4 point 4); the research found no selector
  collision. The e2e matching note in section 4 applies to new specs.
- W6. The CSS file is not linted (the ESLint config covers `.ts` / `.tsx`
  only), so gate 5 says nothing about `RosterConfirmDialog.module.css`.

## 8. Interim gate (bare, output under `.superpowers/sdd/`, real exit codes)

1. `cd W:/tmp/primary-contact-integrity && npm run typecheck` -> `EXIT:0`; 0
   `error TS` lines; all five workspaces ran (app, dashboard, e2e,
   fake-twilio, fake-twilio-web). Log `S4a-gate-typecheck.log`.
2. `cd dashboard && npx vitest run` on the four test files this dispatch
   edited -> `EXIT:0`; `Test Files  4 passed (4)`, `Tests  240 passed (240)`:
   rosterPeople 5, RosterConfirmDialog 59, TourDetail 131, PlacementDetail
   45. Log `S4a-gate-vitest.log`.
3. `npx eslint $(git diff --name-only --diff-filter=d 437218e6..HEAD -- '*.ts'
   '*.tsx')` (the 9 touched ts/tsx files, from the worktree root) -> `EXIT:1`,
   `1 problem (1 error, 0 warnings)`:
   `dashboard/src/routes/tours/TourDetail.tsx 342:85 error ...
   react-hooks/purity` (`Date.now` during render). Attribution by baseline:
   the same command on the same 9 paths at 437218e6 (before any edit; the
   dashboard tree there equals the merge base's) -> `EXIT:1`, `2 problems (2
   errors, 0 warnings)`: `RosterConfirmDialog.tsx 113:5
   react-hooks/set-state-in-effect` and `TourDetail.tsx 342:85
   react-hooks/purity`. Present now and absent at baseline: NOTHING. The
   remaining `TourDetail.tsx:342:85` is PRE-EXISTING (named per worklist
   S4-F8); `RosterConfirmDialog.tsx:113:5` is REMOVED by S4.3. Logs
   `S4a-baseline-eslint.log`, `S4a-gate-eslint.log`.
4. ASCII: `git diff 437218e6..HEAD | grep -nP '^\+.*[^\x00-\x7F]' || echo
   ascii-clean` -> `ascii-clean`. Log `S4a-gate-ascii.log`.

Extra evidence (not gate steps): the 13 other dashboard test files that
consume the touched surfaces (endpoints, recipientLabel, ContactCommsTab,
CreateRelayGroupModal, ContactDetail, ListingDetail, listingFormat,
buildListingFile, useListing, PlacementConversation, usePlacementChannels,
PeopleCard, TourConversation) -> `EXIT:0`, `Test Files  13 passed (13)`,
`Tests  535 passed (535)`. Log `S4a-extra-neighbors.log`.

`git status` after the gate: clean on `feat/primary-contact-integrity`, five
S4a commits on top of 437218e6 (this report is the sixth).

Next step: Task S4.6 (plan line 15515, "Roster rows carry the server flags;
useListing keeps the load-time block"), then S4.7-S4.13 including S4.10b.
The S4 addition owned by that later dispatch: the `dashboard/src/api/endpoints.ts`
docblocks (`getUnit`, `restoreUnit`, `addUnitContact`, `removeUnitContact`).
