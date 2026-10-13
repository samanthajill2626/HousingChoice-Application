# Fix wave 1 report - caseworker integrity (R1 code review)

Implementer: fix-wave implementer (Claude Opus 5.5), 2026-10-12. Worktree
`W:\tmp\caseworker-integrity`, branch `fix/caseworker-integrity`, from
1ad20d30. Work order: `R1-adjudications.md` items FW-1..FW-13, the three
issues to file, `npm run issues`, the fix-wave gate. Findings only; code is
cited by file:line at 45e383ce (the last commit before this report).

Headline: 14 commits - one per item (13) plus one for the three issue files.
Every fix item went RED for the stated reason before its fix (test-only items
were GREEN on the unchanged code and went RED under the item's named mutant),
every GREEN passed, and every revert proof went red and was restored
byte-identically (sha256 checked against a pre-revert baseline each time). The
fix-wave gate is green: app 13 files / 326, dashboard 7 files / 452, typecheck
0, eslint 0 on all 21 touched TS files, ASCII 0 everywhere, `npm run issues`
0. No STOP condition was hit: no fix grew past its item, the one fake/real
pair (FW-1) mirrors exactly, every RED failed for the stated reason, and no
new mutation surface or reader was added.

## Per item

| Item | Commit | RED observed | GREEN | Revert proof |
|---|---|---|---|---|
| FW-1 (B2) | 7e71934b | 5 failed / 28: DynamoDB Local swap and clear on a LIVE unit `promise resolved ... instead of rejecting`; racing plain restore after the read `promise resolved` (landlord of a now-live unit swapped); FakeWorld route x2 `expected 200 to be 409` | 5 files / 74 (the two FW-1 files + unitsRepoRoster.integration, unitsApiRoster, unitsSoftDelete) | (a) read check removed (condition kept): both LIVE cases red on `expected 3 to be +0` - the condition still refuses, but only after three sent writes; (b) write condition removed (check kept): the racing-restore case red, `promise resolved`; (c) FakeWorld check removed: both route cases red, `expected 200 to be 409` |
| FW-2 (B3) | a363448c | docs only | `npm run issues` 0 | n/a |
| FW-3 (B4) | f48f07e9 | test only: GREEN on unchanged code (13/13) | 13/13 | mutant `\|\| unit.primary_contact === old` dropped (`app/src/repos/unitsRepo.ts:1144`): red, `expected 'c-old' to be 'c-new'` |
| FW-4 (B5) | 598d8db5 | test only: GREEN on unchanged code (33/33) | 33/33 | mutant `return 'superseded_by_human_edit'` in the lost-acknowledgement branch (`app/src/repos/suggestionResolutionRepo.ts:941`): red, `expected 'superseded_by_human_edit' to be 'superseded_by_reclassification'` (file sha256 back to 3b1e0f45..., the reviewer's baseline) |
| FW-5 (B6) | e71694c7 | 14 failed / 146: contactKind `'undefined'` / `''` / `'42'` vs `'unknown'` (4); both guards on phone, email and FakeWorld-sentinel pointer rows threw the 409 errors (6); type-less contact `'undefined'` (1); POST /api/tours phone and email pointer `expected 409 to be 404` (2); POST /api/units pointer `expected 409 to be 404` (1) | 4 files / 146; with every other guard caller's suite and the dashboard mirror: 13 app files / 259, mirror 52 | guards' pointer test removed: 9 red (the 6 guard cases + the 3 route cases); contactKind back to `String(c.type)`: 5 red (4 contactKind rows + the guard's type-less case) |
| FW-6 (B7) | 89cc45d8 | test only: GREEN on unchanged code | 40/40 | a temporary unclassified field (`'income'`) in the derived input: red, `expected [ 'income' ] to deeply equal []`; a temporary double classification (`pets` added to the neutral set): red, `expected [ 'pets' ] to deeply equal []`; both reverted |
| FW-7 (B8) | 43c5a62f | comment only | suggestionReclassificationGuard 28/28 (its source pin over the file) | n/a |
| FW-8 (D5) | 0250ad9a | 1 failed / 10: `Unable to find role="alert"` (the failed read was swallowed) | dialog + ListingDetail 2 files / 90 | `setLandlordsFailed(true)` removed: red, `Unable to find role="alert"` |
| FW-9 (D6) | 1849201e | test only: GREEN on unchanged code (2/2) | ContactDetail 127/127 | M1 generation guard (`ContactDetail.tsx:686`) neutralized: case 1 red, `expected <div role="alert" ...> to be null`, case 2 green; M2 reset (`ContactDetail.tsx:292`) removed: case 2 red (same message), case 1 green; file sha256 back to 35d9a13f... (the reviewer's baseline) |
| FW-10 (D7) | ac778a9c | test only: GREEN on unchanged code | ContactEditForm 76/76 | M3 reset (`ContactEditForm.tsx:498`) removed: red, `expected <li>...</li> to be null` (the stale refusal stayed) |
| FW-11 (D8) | ffc1595d | 1 failed: at `ListingDetail.test.tsx:1448`, u2's heading shown and the dialog still open (`expect(element).not.toBeInTheDocument()`) | ListingDetail + dialog 2 files / 91 | render-time reset removed: red at the same assertion |
| FW-12 (D9) | 36192780 | test only: GREEN on unchanged code (PlacementsPage 11/11, TourDetail describe 3/3) | PlacementsPage + TourDetail 2 files / 139 | PlacementsPage mapping (`PlacementsPage.tsx:98`) neutralized: the Closed-view case red (fixed copy shown); TourDetail runDirect mapping (`TourDetail.tsx:383`) dropped: the (DEFENSIVE) case red |
| FW-13 (D1, Q3) | ff28ad70 | the two pins changed FIRST: both red on the old copy, `Unable to find an element with the text: ... until someone on its contact list is made the primary contact or a landlord is added.` | ListingDetail 81/81; `grep "until a contact is added"` over dashboard, e2e and app: no match | old string put back: both pins red |
| issues | 45e383ce | - | `npm run issues` 0 | - |

## Where the code landed (at 45e383ce)

- FW-1: `app/src/repos/unitsRepo.ts:1130` (write() throws RosterWriteConflictError
  on a unit that is not soft-deleted, before any write); `:1181` (the write
  passes `{ requireSoftDeleted: true }`); `updateRosterIfCurrent` gains the
  option at `:554` and adds `attribute_exists(#expectedDeletedAt)` at
  `:593-596` only when it is set, so addContact (`:862`) and removeContact
  send byte-identical commands; the interface doc `:479-498`. FakeWorld:
  `app/test/helpers/twilioWebhookHarness.ts:3106` (same check, same order:
  not found, not deleted, landlordId). Tests:
  `app/test/unitsRepoRestoreWithLandlord.integration.test.ts:221` (LIVE swap
  and clear, zero UpdateCommands sent), `:241` (racing plain restore after the
  first GetCommand, nothing written); `app/test/unitsRestoreLandlord.test.ts:223`
  (the review's interleaving through the route, with and without a chosen
  landlord: 409 `unit_roster_conflict`, the live unit keeps c-old, its roster
  and primary, no `unit_restored` audit).
  Dashboard (read, not changed, as the brief asked): the dialog shows
  `ROSTER_RETRY_COPY` and calls `onConflict` on 409 `unit_roster_conflict`
  (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:82-86`);
  ListingDetail's `onConflict` re-reads, applies, and closes the dialog when
  the re-read is live (`dashboard/src/routes/listing/ListingDetail.tsx:1417-1431`),
  pinned by `ListingDetail.test.tsx:1343` (efcdb4b9) and
  `RestoreLandlordDialog.test.tsx:124`. So FW-1's new 409 ends with the
  dialog closed on the live property.
- FW-2: `RUNBOOK.md:475` (the clause now says the stage write is NOT
  conditioned on the stage read, so a concurrent move between the read and the
  write passes too, not only read lag, and points to the issue); the appended
  paragraph `docs/issues/placement-terminal-stage-exit-unguarded.md:46-60`,
  `updated: 2026-10-12` at `:9`.
- FW-3: `app/test/unitsRepoRestoreWithLandlord.integration.test.ts:154`.
- FW-4: `app/test/suggestionResolutionRepo.integration.test.ts:563` (a doc
  wrapper lets the TransactWriteCommand that carries a ConditionCheck - only
  the mismatch transaction does - commit, then throws; asserts the answer,
  exactly one lost acknowledgement, nothing written, journal superseded).
- FW-5: `app/src/services/contactTypeGuards.ts:71`, `:88` (`contact.phone_ref
  === true || contact.email_ref === true` -> not found: the same inline test
  as the conversion's readSubject, `app/src/services/caseworkerConversion.ts:206-207`,
  and the contacts PATCH, `app/src/routes/contacts.ts:1532`; no new helper);
  `app/src/lib/caseworkers.ts:98-100` (contactKind; its only runtime caller is
  the tenant guard; JSDoc updated). Tests: `app/test/contactTypeGuards.test.ts:114`,
  `:120`, `:161`; `app/test/caseworkers.test.ts:174-177`;
  `app/test/toursCreateContactType.test.ts:109`;
  `app/test/unitsLandlordOfRecord.test.ts:71`.
- FW-6: `app/test/suggestionReclassification.test.ts:258` (the neutral set,
  citing spec section 1 I1), `:263-269` (the derived list), `:271`, `:282`.
- FW-7: `app/src/repos/suggestionResolutionRepo.ts:476-483`.
- FW-8: `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:26` (the
  copy), `:64` (the load-error state, not set for an aborted read), `:130-134`
  (the alert); test `RestoreLandlordDialog.test.tsx:141`.
- FW-9: `dashboard/src/routes/contact/ContactDetail.test.tsx:661`, `:689`.
- FW-10: `dashboard/src/routes/contact/ContactEditForm.test.tsx:1392`.
- FW-11: `dashboard/src/routes/listing/ListingDetail.tsx:224-225` (the state
  records its unitId and is reset during render when the route's unitId
  differs), `:382` (set with `unit.unitId`); test
  `ListingDetail.test.tsx:1407` (Back to u2: dialog gone; Forward to u1: not
  back; `restoreUnit` never called for u2). `confirmingDelete` untouched.
- FW-12: `dashboard/src/routes/placements/PlacementsPage.test.tsx:189`;
  `dashboard/src/routes/tours/TourDetail.test.tsx:2351-2356`.
- FW-13: `dashboard/src/routes/listing/ListingDetail.tsx:513-522` (the doc
  comment), `:530` (the string); pins `ListingDetail.test.tsx:1786`, `:1807`;
  `e2e/support/selectors.md:85`.

## Issues filed (all open, low, created 2026-10-12; refs checked to exist and
## each cited line to be in range)

- `docs/issues/contact-list-checks-outside-roster-write-loop.md` (area app):
  B1's two races with interleavings and durable outcomes, why it is narrower
  than spec L1, the plan's S4 contract issue 1 and ruling S4-1 (ACCEPT, L1
  class), the suggested in-loop fix (`newSeatAllowed` / `claimAllowed`, typed
  errors mapped to the same 409s, FakeWorld mirror) and its `racingRepo`
  regression test.
- `docs/issues/contact-type-refusal-copy-edge-cases.md` (area dashboard): D2,
  D3 + B10, D4 (pre-existing), D10 - each with location, why it was kept
  (spec-approved copy or kept behavior), and a direction.
- `docs/issues/listing-detail-dialogs-survive-property-navigation.md` (area
  dashboard): the pre-existing "Delete property?" confirm survives an in-place
  move and would delete the other property; FW-11 fixed the restore dialog
  only; reset per-property state on a unitId change or key the route element.
- Appended paragraph: `docs/issues/placement-terminal-stage-exit-unguarded.md:46-60`
  (the check's read vs the stage write's `attribute_exists(placementId)` only;
  the fix is a `stage = :from` condition answering 409 like the tours PATCH's
  `expectedStatus`, not made here); its refs gained
  `app/src/repos/placementsRepo.ts:347` and `app/src/routes/tours.ts:1421`.

## Divergences, and why

- FW-1: `updateRosterIfCurrent` takes an options object
  `{ requireSoftDeleted?: boolean }` rather than a free extra-condition
  string - narrower, and callers that pass nothing build the same command.
  Test (a) also asserts that NO UpdateCommand is sent, so the read check and
  the write condition are each pinned on their own (without it, a removed read
  check still ends in RosterWriteConflictError after three failed writes and
  the brief's assertions alone stay green). Test (c) is parametrized with and
  without a chosen landlord.
- FW-5: beyond the three briefed regressions - the guards on a pointer row
  carrying the FakeWorld's sentinel type `unknown` (shows the pointer flag,
  not the type, decides), an email pointer route case, and a guard-level case
  for a type-less non-pointer contact (refused as `unknown`).
- FW-6: the derived list is the extractable fields plus `status` (as briefed)
  PLUS the rest of `DECISION_TARGETS` minus `type` (adds `phone`, `address`),
  so a second check can require both sets to name only acceptable targets
  (a renamed field fails it). Same live-code sources; no literal list.
- FW-8: "Restore with this landlord" keeps its existing disabled rule (no
  pick); with no candidates nothing can be picked, so no new rule was added.
  The test also clicks "Restore without a landlord" to show it still works.
- FW-9: a sibling helper `renderUnknownWithNavToOther` (`renderWithNavToOther`
  is scoped to the kebab describe and hard-wired to k1 -> z99).
- FW-11: reset during render (React's "adjust state when a prop changes"),
  with the state carrying the unitId it opened for, instead of the
  ContactDetail precedent (an effect with an eslint-disable for
  `react-hooks/set-state-in-effect`). It leaves no frame with the dialog over
  the wrong property, and it also drops a `restore_needs_landlord` 409 that
  resolves AFTER the move (an effect keyed on unitId would not re-run and
  would open the dialog on the new property). `eslint --print-config` shows
  `react-hooks/set-state-in-render` at error on this file, and the guarded
  call passes it. The test also pins "reset, not hidden" (Forward to u1 shows
  no dialog).
- FW-2: the issue's refs line gained the two locations the new paragraph
  cites (beyond `updated:`).
- Commits: one per item; FW-1/FW-3 (same integration file) and FW-11/FW-13
  (same ListingDetail files) were kept separate for review.

## Fix-wave gate (bare, from the worktree, at 45e383ce)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1a | app `npx vitest run` the brief's 13 files | 0 | 13 files, 326 passed, 0 skipped; DynamoDB Local suites ran: unitsRepoRestoreWithLandlord.integration 13, unitsRepoRoster.integration 17, suggestionResolutionRepo.integration 33, suggestionReclassification.integration 7 |
| 1b | dashboard `npx vitest run` the brief's 7 files | 0 | 7 files, 452 passed (contactTypeErrors 19, RestoreLandlordDialog 10, PlacementsPage 11, ListingDetail 81, TourDetail 128, ContactDetail 127, ContactEditForm 76) |
| 1c (extra) | app: placementsFromTourContactType, statusTransitionContactType, toursReopenContactType, toursReviveContactType, transitionRoutesContactType, unitsApiRoster, unitsSoftDelete, contactKinds | 0 | 8 files, 100 passed (the other callers of the changed guards and roster write) |
| 1d (extra) | dashboard `src/routes/contact/caseworkerRoleMirror.test.ts` | 0 | 52 passed (it imports `app/src/lib/caseworkers.ts`) |
| 2 | `npm run typecheck` | 0 | all five workspaces |
| 3 | `npx eslint $(git diff --name-only --diff-filter=d 1ad20d30..HEAD -- '*.ts' '*.tsx')` | 0 | 21 files, no output; TourDetail.tsx and ScheduleTourForm.tsx untouched, so no baseline attribution was needed |
| 4 | ASCII | - | 3 new issue files 0 each, no MISSING; 24 edited files, 651 added lines vs 1ad20d30, 0; commit messages 1ad20d30..HEAD 0 (this report re-checked before its commit) |
| 5 | `npm run issues` | 0 | 404 open, 202 closed, 606 total; INDEX.md gitignored, not committed |

Every run's output went to `.superpowers/sdd/logs/fw1-*.log` (61 logs) with
`$?` echoed - never a pipe. No `[dynamoAdmin]` line and no SKIPPED line in any
of them. DynamoDB Local was already up (`hc-dynamodb-local`); it was not
started, restarted or stopped. No `AWS_*` variable was exported. No full
`npm test`, e2e suite or e2e session was run.

## Noticed, not fixed

- (Unverified, by reading) An in-flight property-page write that resolves
  after a move to another property calls the `setUnit` closure of the old
  property (`dashboard/src/routes/listing/useListing.ts:143-167` stamps
  `forId` with the old unitId), which would leave the new property's page on
  its loading spinner until a reload. It applies to any write started on the
  page (status, restore, roster, the restore dialog's `onRestored`); FW-11
  keeps the dialog from opening on the new property but does not cover a
  write already in flight. Pre-existing shape; candidate for
  `listing-detail-dialogs-survive-property-navigation`'s sweep.
- On the Unknown card, `triaging` is not reset by the contact-change effect
  (`ContactDetail.tsx:203`, `:285-313`), so after moving from A (Mark as in
  flight) to B, B's Mark as buttons stay disabled until A's request settles
  (FW-9's first case relies on this to know A settled). Cosmetic, brief.
- The restore dialog can show two `role="alert"` paragraphs at once (the
  landlords load error and a later restore failure). Both are true; noted
  only.
