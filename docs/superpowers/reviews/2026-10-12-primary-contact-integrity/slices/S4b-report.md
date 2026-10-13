# S4b slice report - dashboard, property-page half (S4.6-S4.13)

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base de7b208e (S4a report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S4.6, S4.7, S4.8, S4.9, S4.10, S4.10b, S4.11, S4.12 and the S4.13 slice
gate (plan lines 15515-17523; sections 0-3 and the 3.2 rulings binding; R12,
R18, R20 and R21 applied - of the eight accepted S4 decisions P-3..P-7 land
here). The "S4 additions" of `research/worklist-deltas.md` that apply to these
tasks were applied: the S4.9 retitle of the stale "sole landlord-typed"
restore test (S4-F6), the `dashboard/src/api/endpoints.ts` docblocks (S3-F5,
S4-F1), the S4.10b indent strip and blank-line deletion (S4-F11), and the
gate-5 baseline note (S4-F8). Implementer: Claude Opus 5.5, alone in the
worktree. Date: 2026-10-13.

No `npm test`, `npm run e2e`, `npm run e2e:session` or `npm run dev` was run.
Dashboard tests need no Docker; nothing was started or stopped. No background
command was left running. `env | grep '^AWS_'` printed nothing.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S4.6 | 84c52d51 | feat(dashboard): property roster rows carry deleted and caseworker flags; useListing keeps the propertyContact block |
| S4.7 | 90af0532 | feat(dashboard): property page marks deleted contacts and skips them for Make primary and the facts line |
| S4.8 | a566c3e3 | feat(dashboard): property page no-primary-contact box |
| S4.9 | 26a8dba6 | feat(dashboard): remove-the-primary notice reads the server heir; primary_contact_deleted and roster_read_failed copy |
| S4.10 | 9a3242e7 | feat(dashboard): property page re-reads the roster source after either restore |
| S4.10b | 8190ce81 | feat(dashboard): restore dialog shows the shared could-not-check sentence on 503 roster_read_failed |
| S4.11 | ba944a79 | feat(dashboard): property Activity line for an automatic primary contact |
| S4.12 | 2d5daa99 | feat(dashboard): contact Delete dialog names the primary-contact handoff |
| S4.13 | (none) | slice gate - no code change, nothing forced a fix |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent
(`git rev-parse -q --verify MERGE_HEAD` printed nothing, exit 1), explicit
paths only, the plan's subject, the `Co-Authored-By: Claude Opus 5.5` trailer
(8 of 8). S4.9 carries one extra body line naming the two worklist additions
folded into it (D1). Before each commit: `git diff -U0` added lines
ASCII-clean (grep exit 1) and every touched file has zero CR bytes (LF kept).
`npm run typecheck` after each task's commit: `EXIT:0`, 0 `error TS` lines
(logs `.superpowers/sdd/S4b-typecheck-S4.<n>.log`).

## 2. Files touched (15)

`git diff --stat de7b208e..HEAD` before this report: 15 files, 955+ / 91-.

- `dashboard/src/routes/listing/buildListingFile.ts`, `buildListingFile.test.ts` (S4.6)
- `dashboard/src/routes/listing/useListing.ts`, `useListing.test.tsx` (S4.6)
- `dashboard/src/routes/listing/ListingDetail.tsx` (S4.7, S4.8, S4.9, S4.10, S4.10b)
- `dashboard/src/routes/listing/ListingDetail.module.css` (S4.7, S4.8)
- `dashboard/src/routes/listing/ListingDetail.test.tsx` (S4.7, S4.8, S4.9, S4.10)
- `dashboard/src/routes/listing/rosterCopy.ts` (S4.10b)
- `dashboard/src/routes/listing/RestoreLandlordDialog.tsx`, `RestoreLandlordDialog.test.tsx` (S4.10b)
- `dashboard/src/routes/listing/listingFormat.ts`, `listingFormat.test.ts` (S4.11)
- `dashboard/src/routes/contact/ContactDetail.tsx`, `ContactDetail.test.tsx` (S4.12)
- `dashboard/src/api/endpoints.ts` (docblocks only, folded into S4.9 - D1)

All inside the brief's file list. `dashboard/src/api/types.ts` was not
touched (S4a already carries every wire type these tasks render). Nothing
outside the list was needed.

Byte-exactness: a read-only script extracted every `new_string` fenced block
of plan lines 15515-17440 (S4.10b's blocks with their 3-space list indent
stripped, every other block as written) and counted it in the touched files
(log `S4b-extra-blockcheck.log`): 52 of 53 blocks present. The 53rd is S4.9
3a's constants block, whose local `ROSTER_READ_FAILED_COPY` lines S4.10b 3b
deletes by design; the block minus exactly those lines is present once (log
`S4b-extra-blockcheck-s49-3a.log`). S4.9 1e's `replace_all` replaced exactly
2 occurrences (`grep -c` 2 before S4.10; S4.10 1e's new test adds a third use
of the same sentence).

## 3. Tests and RED/GREEN evidence

Logs: `.superpowers/sdd/S4b-S4.<n>-{red,green,tsc}.log`. vitest prints a
Unicode ellipsis in truncated values; quoted here as `...`.

Baseline before any edit (`S4b-baseline-vitest.log`, `EXIT:0`): ContactDetail
128, ListingDetail 90, RestoreLandlordDialog 13, buildListingFile 9,
listingFormat 34, useListing 11 (`Tests 285 passed (285)`); pre-existing act
warnings: 316 ContactDetail, 2 RestoreLandlordDialog. Baseline eslint on the
14 files this half would touch: `EXIT:0` (`S4b-baseline-eslint.log`).

### S4.6 - `buildListingFile.test.ts` (+1), `useListing.test.tsx` (+2)

describe `listingRoster`: "carries the server row flags deleted and caseworker
through (primary-contact-integrity spec 7.5), and nothing when absent".
describe `useListing`: "exposes the load-time propertyContact block
(primary-contact-integrity spec 7.5), and setUnit keeps it"; "leaves
propertyContact absent when the GET carried no block (the server could not
tell)" (pin).

- RED: `Test Files  2 failed (2)`, `Tests  2 failed | 21 passed (23)`;
  `expected { contactId: 'pm1', ...(5) } to match object { contactId: 'pm1',
  deleted: true }` and `expected undefined to deeply equal { contactId: null,
  ...(2) }`; the absent-block pin passed - exactly the plan's split.
- GREEN: `Test Files  2 passed (2)`, `Tests  23 passed (23)` (buildListingFile
  10, useListing 13); dashboard tsc `EXIT:0`.

### S4.7 - `ListingDetail.test.tsx` (+4)

describe "ListingDetail - deleted contact rows (primary-contact-integrity spec
7.4)": "marks a deleted row \"(deleted)\" in view mode"; "in edit mode a
deleted row says \"(deleted)\" and offers no Make primary - its role select
and Remove stay"; "the header facts subline skips a deleted row when naming
the company"; "the empty state says tours need a primary contact". Plus the
module-level fixtures `MARK`, `GINA_DELETED`, `integrityState()` and
`contactsCard()` S4.8/S4.10 reuse.

- RED: `Tests  4 failed | 90 passed (94)` - view mode `Expected ... Gina Gone
  (deleted) Received: Gina GoneProperty manager`; edit mode `Expected ... Gina
  Gone (deleted) Received: Gina GoneRemove` (see D4); facts `Unable to find an
  element with the text: (t) => t.includes("2 BR") &&
  t.includes("BNS Property Management")`; empty state `Unable to find an
  element with the text: No contacts on this property yet. Tours need a
  primary contact.`.
- GREEN: `Tests  94 passed (94)`; tsc `EXIT:0`.

### S4.8 - `ListingDetail.test.tsx` (+10)

describe "ListingDetail - the no-primary box (primary-contact-integrity spec
7.4)": "exactly one eligible row: \"Make <Name> primary\" above the rows - the
same write as Make primary"; "counts only ELIGIBLE rows: a deleted row and a
caseworker row do not count"; "two or more eligible rows: \"Choose a
primary\" opens the edit mode"; "no eligible row: no button, and the line says
an added landlord or property manager becomes primary"; "a deleted property
contact leads with \"This property's contact was deleted.\""; "no box when the
block is absent (the server could not tell)" (pin); "no box when the block
names a property contact" (pin); "no box on a soft-deleted property (the card
is read-only there)" (pin); "no box with zero roster rows - the empty state
speaks instead" (pin); "a failed write from the box shows its error inside the
box".

- RED: `Tests  6 failed | 98 passed (104)`, all six `TestingLibraryElementError:
  Unable to find an accessible element with the role "status"`; the four pins
  passed - exactly the plan's split.
- GREEN: `Tests  104 passed (104)`; tsc `EXIT:0`.

### S4.9 - `ListingDetail.test.tsx` (3 changed, +5, 1 retitled)

Changed (describe "ListingDetail - Contacts card edit mode"): "removing the
CURRENT primary confirms first and NAMES the heir the server reports" (was
"... NAMES the promotion"; now reads the block); "names the NO-primary outcome
when the server reports no heir" (was "... when there is no landlord of record
to promote"); "an OWNERLESS property (no landlordId at all, e.g. restored
without a landlord) names the NO-primary outcome without crashing" (block
added; old sentence replaced by `replace_all`, 2 hits). New: "an heir with no
name on record: \"Another contact on this property becomes the primary
contact.\""; "no propertyContact block (the server could not tell): another
contact MAY take over"; "the notice reads the LATEST roster write's block, not
the load-time one"; "a 409 primary_contact_deleted on Make primary names its
own reason, and the re-read marks the row deleted"; "a 503 roster_read_failed
on removing the primary says the other contacts could not be checked, and
re-reads nothing". Retitled (worklist, D1): "Restore without a landlord that
promotes the sole landlord-typed contact shows that contact as the primary
contact" -> "Restore without a landlord that promotes the earliest-added
eligible contact shows that contact as the primary contact" (comment above it
rewritten to spec 4.6; assertions unchanged).

- RED: `Tests  8 failed | 101 passed (109)` - the three updated tests and the
  unnamed-heir / no-block / latest-write tests `Unable to find an element with
  the text: ...` (their new sentences); the 409 test `Expected ... That contact
  was deleted - restore them first or choose someone else. Received: That
  contact is the landlord of record now - reassign the property's landlord
  first.`; the 503 test `Expected ... Couldn't check the other contacts - try
  again. Received: Couldn't save that change - please try again.` - exactly
  the plan's eight.
- GREEN: `Tests  109 passed (109)`; tsc `EXIT:0`;
  `grep -n "calls and new relay groups\|masked call" ListingDetail.tsx` -> no
  output (exit 1).

### S4.10 - `ListingDetail.test.tsx` (4 edited, +2)

Edited (each now mocks the re-read; assertions unchanged): "shows the Deleted
banner + Restore for a deleted property and restores in place"; "a restore
that needs a landlord opens the landlord dialog; restoring through it applies
the unit and closes it"; "(PIN) restoring through the landlord dialog puts the
restored roster on the Contacts card, not just the page unit"; "Restore
without a landlord that promotes the earliest-added eligible contact shows
that contact as the primary contact". New, describe "ListingDetail - a restore
re-reads the roster source (primary-contact-integrity spec 7.5)": "a plain
restore re-reads the property, and the re-read becomes the Contacts card
roster"; "a restore through the landlord dialog re-reads the property; the
re-read REPLACES the restore answer as the roster source".

- RED: `Tests  2 failed | 109 passed (111)`, both `AssertionError: expected
  "spy" to be called with arguments: [ 'u1' ]` / `Number of calls: 0`; the four
  edited tests passed - exactly the plan's split.
- GREEN (the plan's three files): `Test Files  3 passed (3)`,
  `Tests  137 passed (137)` - ListingDetail 111, useListing 13 (incl. the
  FW2-5 move-to-B restore case), RestoreLandlordDialog 13; tsc `EXIT:0`. Act
  warnings: only the 2 pre-existing RestoreLandlordDialog ones.

### S4.10b - `RestoreLandlordDialog.test.tsx` (+1)

"a 503 roster_read_failed says the other contacts could not be checked, and
stays open".

- RED: `Tests  1 failed | 13 passed (14)`; `Expected ... Couldn't check the
  other contacts - try again. Received: Couldn't restore - please try again.`
  - exactly the plan's.
- GREEN (with ListingDetail): `Test Files  2 passed (2)`,
  `Tests  125 passed (125)` (RestoreLandlordDialog 14, ListingDetail 111); tsc
  `EXIT:0`. `ROSTER_READ_FAILED_COPY` is defined once, in `rosterCopy.ts`, and
  imported by both `ListingDetail.tsx` and `RestoreLandlordDialog.tsx`.

### S4.11 - `listingFormat.test.ts` (+1)

describe `describeUnitActivity`: "describes an automatic primary-contact pick
with who, why, and a contact link (primary-contact-integrity spec 8)".

- RED: `Tests  1 failed | 34 passed (35)`; `AssertionError: expected { Object
  (label) } to deeply equal { ...(3) }` with the diff `+ "label": "Unit primary
  contact assigned"` (see D4).
- GREEN: `Tests  35 passed (35)`; tsc `EXIT:0`.

### S4.12 - `ContactDetail.test.tsx` (+3)

describe "ContactDetail - the Delete dialog names the primary-contact handoff
(primary-contact-integrity spec 7.6)": `it.each` "%s gets the handoff
sentence" x2 (a landlord, a partner); "a tenant does not" (pin).

- RED: `Tests  2 failed | 129 passed (131)`, both `Unable to find an element
  with the text: If they're a property's primary contact, ...`; the tenant pin
  passed - exactly the plan's split.
- GREEN: `Tests  131 passed (131)`; tsc `EXIT:0`; act warnings 316, the same
  count as the baseline.

## 4. What the new UI exposes (for the e2e slice)

Property page, Contacts card (a `<section>` whose heading is `Contacts`):

- The no-primary box: a `<div role="status">` (no accessible name), ABOVE the
  rows, in view AND edit mode. Shown only when the roster source's
  `propertyContact` block is PRESENT with `contactId: null`, the roster has at
  least one row, and the property is not soft-deleted. It never coexists with
  the deleted banner, the page's only other `role="status"` once loaded (the
  load spinner is the third, and renders alone). Locate it as
  `page.getByRole('status').filter({ hasText: 'No primary contact.' })` (or the
  deleted lead).
  - First `<p>`: `<strong>No primary contact.</strong>` - or, when the block's
    reason is `deleted`, `<strong>This property's contact was deleted.</strong>`
    - then ` New tours won't include the landlord, and tour group texts use the
    general intro.`
  - Action, counting ELIGIBLE rows (no `deleted`, no `caseworker` flag):
    exactly one -> `button` named `Make <Name> primary` (e.g. `Make Mark
    Passmore primary`; the row's id stands in when it has no name); it posts
    `{ contactId, role: <row role>, primaryContact: true }` (the edit-mode
    Make primary write). Two or more -> `button` `Choose a primary` (turns edit
    mode ON, never off). None -> no button; a `<p>` `Add the landlord or
    property manager - they become the primary automatically.`
  - A failed box write: a `<p role="alert">` INSIDE the box (generic `Couldn't
    save that change - please try again.`, or the mapped 409 sentence).
  - The box button `Make <Name> primary` and the edit-row button `Make <Name>
    the primary contact` are distinct accessible names (neither is a
    substring of the other).
- Deleted rows: ` (deleted)` (span `.deletedMark`) right after the name, in
  view mode (inside the row `link`, e.g. `Gina Gone (deleted)`, accessible
  name contains it) and in edit mode (the name line, beside `Remove <Name>
  from this property`); a flagged deleted row reads `Gina Gone (deleted)
  (primary)` (P-5). Edit mode offers NO `Make <Name> the primary contact`
  button on such a row; its `combobox` `Role for <Name>` and its `button`
  `Remove <Name> from this property` stay.
- Empty state (zero rows): `No contacts on this property yet. Tours need a
  primary contact.` (no box).
- Facts subline (header): the company comes from the first LIVE row (primary
  first); a deleted row's company is never shown.
- Remove-the-primary confirm, `dialog` named `Remove the primary contact?`,
  one `<p>` with exactly one of:
  - `<Heir name> becomes the primary contact - new tours and relay groups for
    this property will use them.`
  - `This property will have no primary contact. New tours won't include a
    landlord, and tour group texts will use the general intro.`
  - `Another contact on this property becomes the primary contact.` (heir
    with no name on record)
  - `Another contact on this property may become the primary contact.` (no
    block on the roster source)
- 409 `primary_contact_deleted` (Make primary): the row's (or the box's)
  `alert` reads `That contact was deleted - restore them first or choose
  someone else.`; the page re-reads the property (the row then shows
  `(deleted)` and loses Make primary).
- 503 `roster_read_failed` (Remove of the primary): the confirm dialog's
  `alert` reads `Couldn't check the other contacts - try again.`; the dialog
  stays open; nothing is re-read.
- After EITHER restore the page re-reads the property (`GET
  /api/units/:id`), and the re-read becomes the Contacts card's roster source
  (rows, block and the remove notice).

Restore dialog (`dialog` named `Restore property`): a 503
`roster_read_failed` shows the `alert` `Couldn't check the other contacts -
try again.` and the dialog stays open (no onConflict, no onRestored).

Contact page Delete dialog (`dialog` named `Delete contact?`), for every
contact whose type is not `tenant`: a second `<p>` `If they're a property's
primary contact, the landlord or another contact on that property takes over,
and restoring them won't change that back.` A tenant gets no such line.

Property Activity card: an event `unit_primary_contact_assigned` renders as a
row linked to `/contacts/<contactId>` with label `Primary contact set
automatically` and sub-line `<Name> - <why>` (the contact id stands in for an
unresolved name; no reason -> just `<Name>`): `auto_on_add` -> `the property
had no primary contact`; `handoff_on_remove` -> `the previous primary contact
was removed`; `handoff_on_delete` -> `the previous primary contact was
deleted`; `handoff_on_restore` -> `the property's landlord changed when it was
restored`; `backfill` -> `set by a one-time data repair`; any other reason
humanizes (`manual_fix` -> `Manual fix`). `from` is not rendered. A promoting
"Restore without a landlord" still shows two rows (`Property restored` and
this one) - S3 W3 / S2b W2.

## 5. Divergences from the plan text

- D1 (worklist S4 additions, applied as instructed; folded into the S4.9
  commit with a body line). (a) `dashboard/src/api/endpoints.ts` docblocks,
  comment only: `getUnit` (the row flags and the `propertyContact` block, both
  only on a complete read; still 200 otherwise), `restoreUnit` (the
  sole-landlord promotion paragraph replaced by the heir-function hand-off on a
  `{ landlordId }` restore whose old landlord was primary, the 503
  `roster_read_failed`, "a plain restore never hands off and never answers
  503", and that no restore answer carries the flags or the block, so the
  page re-reads), `addUnitContact` (spec 4.4's widened auto-primary, the
  answer's flags and block, 409 `primary_contact_deleted` in the route's order
  after 409 contact_list_caseworker and 409 landlord_not_landlord),
  `removeUnitContact` (the heir hand-off, the flags and block, 503
  `roster_read_failed`). The wording is mine (the worklist gives no text);
  checked against `app/src/routes/units.ts` (add, remove and restore handlers)
  and the S2a / S2b / S3 reports. (b) `ListingDetail.test.tsx`: the restore
  test titled for the sole landlord-typed promotion is retitled and its
  comment rewritten to the earliest-added eligible rule (S4-F6).
- D2 (method, S4.10b). Its fenced blocks were used with the 3-space list
  indent stripped (S4-F11). The "delete those lines and the blank line after
  them" step was applied as an Edit whose old_string runs from the preceding
  `PRIMARY_CONTACT_DELETED_COPY` line through the next docblock's first line;
  the resulting bytes equal deleting the three lines plus one blank line (one
  blank line remains between the two neighbors).
- D3 (brief). The S4.13 gate ran on the 11 named test files (every file S4a
  or this half created or edited, plus PeopleCard). The plan's literal step 2
  (the whole dashboard suite) also ran, as extra evidence (section 7).
- D4 (RED shapes, cosmetic; counts exactly as planned everywhere). S4.7's
  edit-mode test failed first on its `(deleted)` text assertion (`Received:
  Gina GoneRemove`) rather than on the Make-primary query the plan names - same
  test, same cause. S4.11's assertion header printed `expected { Object
  (label) } to deeply equal { ...(3) }`; its diff shows the plan's received
  label `Unit primary contact assigned`.
- D5 (process note). The first S4.11 test Edit was refused by the tool (the
  file had not been opened with the Read tool yet), so the first "RED" run
  executed the unedited file (`34 passed`). The file was read, the Edit
  re-applied, and the real RED run (quoted above) replaced that log.

No code divergence: every plan code block landed byte-identical (section 2).

## 6. Worries for the orchestrator (non-blocking)

- W1. Between a restore's answer and its re-read the card shows the previous
  roster source: after a plain restore, the load-time rows and block; after a
  dialog restore, the restore answer (rows, no block - so a remove in that
  instant would say "may become"). The re-read replaces both. On a failed
  re-read that state stays (P-7, accepted).
- W2. Every plain restore now costs one extra `GET /api/units/:id`, although a
  plain restore never hands off - spec 7.5 asks for the re-read after EITHER
  restore.
- W3. The remove notice names the heir from the latest roster source; another
  operator's roster change after that read is not seen until the write
  answers (the server decides at write time, and its answer becomes the
  source). Same posture as the old client-side notice.
- W4. The box offers `Make <Name> primary` for ANY live non-caseworker row,
  including a tenant-typed contact on the roster (spec 7.4: a deliberate
  click, broader than automatic routing). Expected, but a reviewer may ask.
- W5. `Choose a primary` has no `disabled` while a roster write is in flight
  (the plan's code gives it none); a click only turns edit mode on.
- W6. Two stale-ish comments left untouched (not in the plan): the
  `rosterCopy.ts` header still says the shared literals cover "the same 409"
  (it now also holds the 503 sentence), and `useListing.ts` near its end
  still says an updated unit is applied "e.g. after restore ... without a
  refetch" (true of setUnit itself; the page now re-reads after a restore).
- W7. The no-primary box's `role="status"` has no accessible name; e2e should
  filter it by text (section 4).
- W8 (S5 hand-off, S4.13 step 6 and ruling R20). The remove-the-primary
  sentences changed: S5.7 must update
  `e2e/tests/dashboard-next/property-roster.spec.ts:251` and S5.8
  `e2e/support/selectors.md:87` before the e2e gate; S5.8 also adds the
  restore dialog's 503 sentence to `selectors.md` around :138 (worklist).
- W9. The CSS module is not linted (the ESLint config covers `.ts` / `.tsx`
  only), so gate 5 says nothing about `ListingDetail.module.css`.

## 7. S4.13 slice gate (bare, output under `.superpowers/sdd/`, real exit codes)

1. `cd W:/tmp/primary-contact-integrity && npm run typecheck` -> `EXIT:0`; 0
   `error TS` lines; all five workspaces ran (app: src, scripts and tests;
   dashboard; e2e; fake-twilio; fake-twilio-web). Log `S4b-gate-typecheck.log`.
2. `cd dashboard && npx vitest run` on the 11 named files -> `EXIT:0`;
   `Test Files  11 passed (11)`, `Tests  612 passed (612)`: rosterPeople 5,
   RosterConfirmDialog 59, PeopleCard 58, TourDetail 131, PlacementDetail 45,
   buildListingFile 10, useListing 13, ListingDetail 111,
   RestoreLandlordDialog 14, listingFormat 35, ContactDetail 131. Log
   `S4b-gate-vitest.log`.
3. (step 2b) `npx eslint $(git diff --name-only --diff-filter=d
   f204106f..HEAD -- 'dashboard/*.ts' 'dashboard/*.tsx')` from the worktree
   root (23 files, list `S4b-gate-eslint-files.txt`) -> `EXIT:1`, `1 problem
   (1 error, 0 warnings)`: `dashboard/src/routes/tours/TourDetail.tsx 342:85
   error ... Cannot call impure function during render ... react-hooks/purity`
   (`Date.now`). Attribution by BASELINE: each of the same 23 paths linted at
   f204106f through `--stdin` (input redirected from a file, no pipe) -> 21
   clean, 2 errors: `RosterConfirmDialog.tsx 113:5 react-hooks/set-state-in-effect`
   (removed by S4.3) and `TourDetail.tsx 342:85 react-hooks/purity` (the same
   one). Present now and absent at baseline: NOTHING. `TourDetail.tsx:342:85`
   is PRE-EXISTING (worklist S4-F8). Logs `S4b-gate-eslint.log`,
   `S4b-gate-eslint-baseline.log`.
4. ASCII: `git diff -U0 f204106f..HEAD -- dashboard/src` written to a file,
   then `grep -nP '^\+(?!\+\+).*[^\x00-\x7F]'` on it -> no output, grep
   `EXIT:1` (the pass). Log `S4b-gate-ascii.log`.
5. Copy: `grep -rn "calls and new relay groups\|who calls route to\|reach by
   masked call" dashboard/src` -> no output, `EXIT:1` (the pass). Log
   `S4b-gate-copy.log`.
6. `git status` -> `nothing to commit, working tree clean`; `MERGE_HEAD`
   absent.

Extra evidence (not gate steps):

- The plan's literal S4.13 step 2, the whole dashboard unit suite: `cd
  dashboard && npx vitest run` -> `EXIT:0`, `Test Files  242 passed (242)`,
  `Tests  4610 passed (4610)`; 0 unhandled errors; act-warning counts on this
  half's surfaces equal the baseline (ContactDetail 316, RestoreLandlordDialog
  2; none from ListingDetail). Log `S4b-extra-dashboard-suite.log`.
- The plan-block byte check (section 2). Logs `S4b-extra-blockcheck.log`,
  `S4b-extra-blockcheck-s49-3a.log`.

`git status` after the gate: clean on `feat/primary-contact-integrity`, eight
S4b commits on top of de7b208e (this report is the ninth).

Next step: slice S5 (plan line 17524), starting with its contract issues; its
S5.7 / S5.8 owe the e2e copy updates in W8.
