# S4b build report - properties dashboard: restore dialog, contact-list copy, ownerless properties (U6)

Implementer: U6 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 253fbe94 (S1-S3 and the S4 backend half
done; base 19607658). Plan `docs/superpowers/plans/2026-10-12-caseworker-integrity.md`
Tasks 4.7-4.13 (the DASHBOARD half of slice S4), the planner-ruled copy change
Q2 (research RF2-N1) inside Task 4.13, orchestrator correction C1, the full S4
slice gate (plus the e2e mutation catalog pin) and the required mutant check
(M1-M10). No `app/` file was edited. Findings only; code is cited by file:line
at efcdb4b9 (the last commit before this report).

Headline: 8 commits - one per plan task (7) plus one gap-test commit. Every
RED failed for the reason the plan states (Task 4.9's in the plan's own "may
also error on render" form; Task 4.13's existing pin on the old copy, per Q2),
every GREEN passed as written, and every plan anchor matched exactly once. The
full S4 gate is green: app 208/208, dashboard 168/168, typecheck 0, the
mutation catalog 4/4 with no catalog change, eslint 0 on all 21 S4 paths,
coverage 83 paths all listed, every ASCII check 0. All ten required mutants
were killed by the plan's tests. Three EXTRA mutants survived (X1, X2, X5 -
behavior the plan states but did not pin); five (PIN) cases in their own
commit (efcdb4b9) now kill each. Task 4.13's typecheck broke exactly the one
planned site. No STOP condition was hit: no contract mismatch with plan
section 2 or the S4a HANDOFF, no RED for a wrong reason, no GREEN that needed
changes, no unlisted mutation surface or reader.

## Per task

| Task | Commit | RED observed | GREEN |
|---|---|---|---|
| 4.7 `restoreUnit(unitId, opts?)` | 79a3cc51 | 1 failed, 50 passed (51): the new case failed at its SECOND assertion - `/api/units/u%201/restore` got `{ method: 'POST' }` with no body | endpoints + ListingDetail 2 files / 120; `npm run typecheck` 0 |
| 4.8 Add contact picker hides caseworkers | f23462e0 | 1 failed, 69 passed (70): the last assertion - the caseworker "Renee Casey" was offered | 70/70 |
| 4.9 `runRosterWrite` maps the new codes first | 208b374d | 2 failed, 70 passed (72): both cases "Unable to find role=alert". The catch-all 409 path ran its `getUnit` refetch (mock reset, so it resolved undefined) and applying that crashed the render at `ListingDetail.tsx:286` (`rosterUnit.unitId`) - the plan's anticipated "may also error on render - still red for the same reason", confirmed from the stack | 72/72 |
| 4.10 RestoreLandlordDialog + rosterCopy.ts | 412a0fe9 | the file failed to load: `Failed to resolve import "./RestoreLandlordDialog.js"`; no tests ran | dialog + ListingDetail 2 files / 81; typecheck 0; the plan's `git grep` printed exactly one line, `rosterCopy.ts:7` |
| 4.11 ListingDetail opens the dialog | ca7ecda0 | 2 failed, 72 passed (74): both new cases timed out on `findByRole('dialog', { name: 'Restore property' })`; the edited existing case passed | ListingDetail + dialog + ListingActionsMenu 3 files / 89; typecheck 0 |
| 4.12 UnitCreateForm landlord refusals | dae99dc1 | 2 failed, 20 passed (22): both alerts read the generic "Couldn't create the property ... please try again." | 22/22 |
| 4.13 ownerless properties + Q2 | 7edc15be | 2 failed, 73 passed (75): the new ownerless case `TypeError: Cannot read properties of undefined (reading 'length')` in `promotionNotice` (then :508); the existing `landlordId: ''` case red on the OLD copy (its Q2 pin). Step 3b compile RED: `npx tsc -p tsconfig.json --noEmit` exit 2, exactly one error, `src/routes/listing/ListingDetail.tsx(508,7): error TS18048: 'landlordOfRecord' is possibly 'undefined'.` After the guard: both cases red on the old copy only (crash gone). After the copy change: green | ListingDetail + buildListingFile + dialog 3 files / 93; typecheck 0 |
| gap pins (extra) | efcdb4b9 | (PIN) cases, green on unchanged code (ListingDetail 80/80) | each kills its mutant (see the mutant check) |

Before every commit: C1's ASCII checks (0, no MISSING line), eslint on the
task's files (0), and a separate bare `git status` read plus a MERGE_HEAD
check (absent every time). Logs: `.superpowers/sdd/logs/s4b-*.log` (run
state).

Where the code landed (at efcdb4b9):
- `dashboard/src/api/endpoints.ts:1029-1046` - `restoreUnit(unitId, opts?)`;
  the body spread `:1043` (no body without `opts`).
- `dashboard/src/api/types.ts:2444-2447` - `UnitItem.landlordId?: string` and
  its doc comment.
- `dashboard/src/routes/listing/ListingDetail.tsx`: imports `:48`
  (`isCaseworkerContact`), `:52` (`ROSTER_RETRY_COPY` from `rosterCopy.js`),
  `:58` (`RestoreLandlordDialog`), `:73` (`contactTypeErrorMessage`);
  `restoreLandlordName` `:188-193`; `restoreNeeds` state `:218`; the ownerless
  guard `:308`; `onRestore` `:364`, its `restore_needs_landlord` branch
  `:373-377`; the Add contact candidates `:395-397`; `runRosterWrite` `:418`,
  the type mapping before the catch-all `:436-440` (the catch-all `:441`);
  `promotionNotice` comment `:506-512`, the Q2 sentence `:520`; the dialog
  `:1399-1424` (`onRestored` -> `applyRosterUnit` `:1403-1406`; `onConflict`
  -> `getUnit` + `applyRosterUnit` `:1407-1421`, close when the re-read is
  live `:1414-1416`).
- `dashboard/src/routes/listing/RestoreLandlordDialog.tsx` (new): source
  `:52`; `run` `:61`, the helper first `:68`, then 409 `unit_roster_conflict`
  `:73-76`, then `RESTORE_FAILED_COPY` (`:22`); title `:87`; buttons `:97`,
  `:108` (disabled rule `:106`); sentence `:113`; picker `:118`; alert `:122`.
- `dashboard/src/routes/listing/rosterCopy.ts:7` (new) - `ROSTER_RETRY_COPY`,
  moved unchanged out of `ListingDetail.tsx` (no second literal anywhere in
  source).
- `dashboard/src/routes/listing/UnitCreateForm.tsx`: import `:26`; the early
  return `:258-266`, after the org-list 422 and before the untouched non-ASCII
  fallback line `:267`.
- `e2e/support/selectors.md:85` - the remove-the-primary row's ownerless
  sentence (Q2).
- Tests: `endpoints.test.ts:800`; `ListingDetail.test.tsx:1206` (edited
  existing restore case), `:1210`, `:1249`, gap pins `:1297-1400` (`:1300`,
  `:1343`, the W7 it.each `:1376`), `:1548` (it.each), `:1589`, `:1713`
  (re-pinned, Q2), `:1733`; `RestoreLandlordDialog.test.tsx:53-144` (9 cases);
  `UnitCreateForm.test.tsx:312-332` (it.each).

## Q2 - planner-ruled change, Q2/RF2-N1

- The ownerless branch of `promotionNotice` (`ListingDetail.tsx:520`) now
  reads, exactly: "This property will have no primary contact and has no
  landlord of record, so calls and new relay groups for it will reach no one
  until a contact is added." The promoted branch ("<name> becomes the primary
  contact - ...") is unchanged.
- Why it was false: that branch renders only when there is no landlord of
  record. Verified read-only: every property-contact resolver walks "primary
  row, else landlord of record" with no further fallback -
  `app/src/lib/rosterResolution.ts:292-296` (neither -> no property member),
  `app/src/lib/tourContacts.ts:122-129`, `app/src/services/rosterProvision.ts:232-236`
  (neither -> unresolvable "unit has no landlord").
- TDD as ruled: both pins moved to the new sentence FIRST - the existing case
  `names the NO-primary outcome ...` (`ListingDetail.test.tsx:1713`,
  `landlordId: ''`) and Task 4.13's new ownerless case (`:1733`) - and both
  were red on the old copy before the copy changed.
- `e2e/support/selectors.md:85` quotes the new sentence.
- The stale comment above `promotionNotice` (it claimed tour/placement
  resolution falls back to the landlord of record) now says there is no
  further fallback and what follows (`ListingDetail.tsx:506-512`).
- Ruling vs plan text: Task 4.13 Step 1 pinned the OLD sentence in both
  places; the ruling wins (both pins carry the new sentence). After the
  change, `git grep "tours fall back to the landlord of record" -- dashboard e2e`
  prints nothing (only the historical contact-rosters plan and this mission's
  own records still mention it).

## C1 - ASCII checks

Every check ran from the worktree with an explicit `cd`, a `test -f || echo
MISSING` per file, `tr -d '\11\12\15\40-\176' < f | wc -c` per new file and
`git diff -U0 19607658 -- <edited files> | grep '^+'` through the same `tr`
for edited files - in every task and at the gate. All printed 0; no MISSING
line. Final: 3 new files 0 each; 8 edited files (`e2e/support/selectors.md`
included), 437 added lines vs 19607658, 0 non-ASCII bytes; the plan's
slice-gate new-file line (S4a's four app files and this half's three) 0 each;
commit messages 253fbe94..HEAD 0. The untouched non-ASCII lines
(`UnitCreateForm.tsx:267`'s fallback, the em dashes elsewhere in
`ListingDetail.tsx`) are byte-unchanged: this half's 16 removed lines
(253fbe94..HEAD) hold 0 non-ASCII bytes.

## Task 4.13 typecheck - dashboard sites touched

Exactly one, as the plan measured: `ListingDetail.tsx` `landlordOfRecord`
(`:308`; the TS18048 at `(508,7)` was the `promotionNotice` read it feeds).
No other dashboard site broke, and `npm run typecheck` over all five
workspaces is 0 with `landlordId` optional. Well under the five-site STOP
threshold; no extra file joined the lint list.

## Divergences from the plan

- Q2 (planner-ruled, above): the copy, both pins, the selectors row and the
  comment. Task 4.13's commit carries one extra body paragraph naming Q2; its
  subject is the plan's.
- Task 4.13's RED sequence: the plan expected only the ownerless TypeError;
  with Q2 the existing pin is red too (old copy). I ran one extra mid-step run
  after the guard to show the crash gone (both cases then red on the copy
  only).
- Extra commit efcdb4b9 (test-only): five (PIN) cases closing the three
  surviving extra mutants (X1, X2, X5) - the brief's rule for an unkilled
  mutant applied to my extras.
- Task 4.13 Step 3b: my first `tsc` run happened before the `types.ts` edit
  landed (the Edit tool refused the file because it had only been grepped,
  not Read); it ran on the unchanged type (exit 0) and is discarded. The
  recorded compile RED is the re-run after the edit.
- Gate form: each run redirected to `.superpowers/sdd/logs/s4b-*.log` and
  echoed `$?` (a redirect, never a pipe); command lines exactly the plan's /
  the brief's. The gate ran at 7edc15be and was re-run at efcdb4b9 after the
  gap commit; the table shows the final run.
- Extra, for the record: per-task eslint, an eslint `--print-config` on the
  new dialog file, and a check that the mutation catalog scan really runs
  (it does, in the collect phase).
- Code: none. Every old_string matched exactly once; every new_string is the
  plan's text (Task 4.13's copy per Q2). No good divergence found (nowhere was
  the live code better than the plan).

## Slice gate (bare commands, from the worktree, final run at efcdb4b9)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app vitest, plan line 12587 exactly (11 files) | 0 | 11 files, 208 passed, 0 skipped; `unitsRepoRestoreWithLandlord.integration` (9) and `unitsRepoRoster.integration` (17) ran against DynamoDB Local (at 7edc15be; no app file changed after) |
| 2 | dashboard vitest, plan line 12593 exactly (5 files) | 0 | 5 files, 168 passed: 145 before this half + 23 new (endpoints 1, dialog 9, UnitCreateForm 2, ListingDetail 11 = 6 plan cases + 5 gap cases). At 7edc15be: 163 |
| 3 | `npm run typecheck` | 0 | all five workspaces, no TS error |
| 4 | `cd e2e; npx vitest run performance/mutationCatalog.test.ts` | 0 | 1 file, 4 passed. The catalog entry `mutationCatalog.ts:81` (`restoreUnit`, `request:POST`) needed no change: the opts spread carries no method, and the both-directions catalog match passes |
| 5 | `npx eslint` on the full S4 list, plan line 12614 (21 paths) | 0 | no output; `--print-config` on `RestoreLandlordDialog.tsx`: 63 rules, `@typescript-eslint/no-unused-vars` at error (`varsIgnorePattern ^_`, so the plan's `_dropped` is clean) |
| 6 | coverage: `git diff --name-only --diff-filter=d 19607658...HEAD -- '*.ts' '*.tsx'` | 0 | 83 paths, each in the S1 (plan line 3253 + `app/test/aiRunVerdicts.test.ts`), S2 (5558), S3 (9188) or S4 (12614) list; none missing |
| 7 | C1 ASCII over every file this half created or edited | - | 0 everywhere, no MISSING (see C1) |

Lint: clean, so no attribution run was needed; there is no pre-existing error
in any S4 path (the plan measured them clean at base).

DynamoDB Local: no `[dynamoAdmin]` line and no SKIPPED line in the app gate
log. The container was already up; it was not started, restarted or stopped.
No `AWS_*` variable was exported. No e2e suite or session was run.

## Mutant check

Each mutant was applied and reverted with the Edit tool; after every revert
the sha256 of the four mutable source files (`endpoints.ts`,
`ListingDetail.tsx`, `RestoreLandlordDialog.tsx`, `UnitCreateForm.tsx`) matched
the pre-mutant baseline (`.superpowers/sdd/s4b-mutant-baseline.sha256`, all
OK). Every mutant ran the full 5-file dashboard gate list (163 tests; 168 for
the re-runs after efcdb4b9). After the last revert `git status` was clean and
`git diff --stat` empty, and the final gate re-run passed 168/168.

| Mutant | Where | Tests that went red |
|---|---|---|
| M1 restoreUnit always sends a body | `endpoints.ts:1043` -> `body: { landlordId: opts?.landlordId ?? null }` | 1: `restoreUnit POSTs no body by default ...` (the ListingDetail tests mock `restoreUnit`, so only the endpoint test can see the wire) |
| M2 the Add contact picker offers caseworkers | `ListingDetail.tsx:396` drops `&& !isCaseworkerContact(c)` | 1: `the Add contact picker never offers a caseworker (I4) ...` |
| M3 type mapping after the 409 catch-all | `ListingDetail.tsx:436-441`: `conflict` first, the helper asked only for a non-409 | 2: both `a %s refusal names its own reason ...` cases |
| M4 "Restore with this landlord" enabled before a pick | `RestoreLandlordDialog.tsx:106` -> `disabled={busy}` | 1: `Restore with this landlord is disabled until one is picked ...` |
| M5 the picker offers non-landlords | `RestoreLandlordDialog.tsx:52` loses its type filter (every contact) | 1: `reads its candidates from the landlords-only source ...` |
| M6 restore_needs_landlord shows a generic error instead | `ListingDetail.tsx:375` `setRestoreNeeds(...)` -> `setDeleteError("Couldn't restore ...")` | 2: both Task 4.11 dialog cases |
| M7 the dialog conflict refreshes only the unit | `ListingDetail.tsx:1413` `applyRosterUnit(fresh)` -> `setUnit(fresh)` | 1: `a conflict inside the landlord dialog re-reads the property into the page AND the Contacts card ...` |
| M8 UnitCreateForm mapping dropped | `UnitCreateForm.tsx:261` -> `null` (branch never taken) | 2: both `shows the server landlord refusal %s ...` cases |
| M9 the old false sentence | `ListingDetail.tsx:520` | 2: both Q2 pins (`names the NO-primary outcome ...`, `an OWNERLESS property ...`) |
| M10 ownerless guard removed | `ListingDetail.tsx:308` -> `(contactsUnit?.landlordId ?? unit.landlordId) as string` | 1: `an OWNERLESS property ...` (`reading 'length'` - the crash returns). The `landlordId: ''` case survives by design (`''` is not undefined) |
| X1 (extra) a dialog restore applied with `setUnit` alone | `ListingDetail.tsx:1405` | 0 - SURVIVED (test gap, CONTRACT ISSUE 9). After efcdb4b9: 1, `(PIN) restoring through the landlord dialog puts the restored roster on the Contacts card ...` |
| X2 (extra) a live re-read never closes the dialog | `ListingDetail.tsx:1414` condition never true | 0 - SURVIVED (test gap, Task 4.11 Goal). After efcdb4b9: 1, `(PIN) a conflict whose re-read shows the property already restored closes the landlord dialog` |
| X3 (extra) the dialog conflict skips `onConflict` | `RestoreLandlordDialog.tsx:75` dropped | 2: dialog `a concurrent change asks for a retry ...` and ListingDetail's conflict case |
| X4 (extra) the dialog drops the helper | `RestoreLandlordDialog.tsx:68` -> `null` | 1: `shows the landlord refusal sentence and stays open` |
| X5 (extra) every restore ApiError opens the dialog | `ListingDetail.tsx:373` -> `err instanceof ApiError` | 0 - SURVIVED (test gap, W7). After efcdb4b9: 3, every `(PIN, W7) a plain restore refused ...` case (404 `unit_not_found`, 409 `unit_roster_conflict`, 500) |
| X5b (extra, after efcdb4b9) any 409 opens the dialog | `:373` code check dropped | 1: the `409 unit_roster_conflict` W7 case |
| X6 (extra) the 409 body's `landlordName` ignored | `ListingDetail.tsx:192` | 1: `a restore that needs a landlord opens the landlord dialog ...` (the "James Porter ..." sentence) |

All of M1-M10 were killed by the plan's own tests, so no gap test was needed
for them; efcdb4b9 exists only for X1, X2 and X5.

## Surprising, or sub-threshold worries

- A dialog restore can be answered on the PLAIN path (S4a HANDOFF: the body
  is ignored when the stored landlord became a landlord again meanwhile), so
  the 200 carries the RAW stored unit. The dialog's `onRestored` applies it
  with `applyRosterUnit` (`ListingDetail.tsx:1403-1406`), and `listingRoster`
  shows a row's `name` only when the server enriched it
  (`buildListingFile.ts:55`): on that race the Contacts card can show contact
  ids instead of names until a reload, and the staff member's pick is (by
  spec) ignored in favor of the restored stored landlord. Rare (needs a
  concurrent re-type of the stored landlord back to `landlord` while the
  dialog is open); cosmetic; record only.
- After "Restore with this landlord", the page and the Contacts card show
  the new landlord, but `useListing`'s other landlord-derived state
  (`state.landlord`, the "Related properties - same landlord" card) still
  reflects the old landlord until a reload (`setUnit` replaces the unit only,
  `useListing.ts:143-164`). The same holds for every roster write today;
  record only.
- `RestoreLandlordDialog.test.tsx:53` and `:63` (the plan's two synchronous
  cases) print React "not wrapped in act(...)" warnings on stderr: the mount
  fetch resolves after the test returns. Not a failure; kept as the plan wrote
  them.
- The dialog's landlords-only guarantee rests on its source call
  (`getAllContacts({ type: 'landlord' })`, filtered by the server); the picker
  does no client-side type check, and M5 is killed only by the call-shape test
  (the mock answers landlords whatever the arguments). The server refuses a
  non-landlord pick anyway (409 `landlord_not_landlord`, shown in the dialog),
  so the worst case is a refused click.
- `contact_list_caseworker` is no longer reachable through the property page
  picker (Task 4.8 hides caseworkers); `runRosterWrite`'s mapping covers a
  race (a contact converted between the list load and the add) and API paths.
  `landlord_not_landlord` IS reachable in the UI: Add contact with role
  Landlord on an ownerless property (for example after "Restore without a
  landlord") by a contact not typed `landlord`.
- `ListingActionsMenu`'s menuitem text "Restore property"
  (`ListingActionsMenu.tsx:143`) equals the dialog's title. Harmless by role,
  but `getByText('Restore property')` is ambiguous while the menu is open.
- No ScheduleTourForm-style flake and no `[dynamoAdmin]` line appeared in any
  run.

## HANDOFF for the S5 implementer (e2e, accessible names as shipped)

Restore entry points (a soft-deleted property's page, `/listings/:unitId`):
- Two buttons are named exactly "Restore": the header button
  (`ListingDetail.tsx:710`) and the Deleted banner's (`:733`; the banner is
  `role="status"`, `:728`). Use `getByRole('button', { name: 'Restore', exact: true }).first()`
  or scope to the banner. The More actions menu item is
  `getByRole('menuitem', { name: 'Restore property' })`. All three call one
  handler, `onRestore`.
- Playwright's default name match is a substring: while the dialog is open,
  a non-exact `getByRole('button', { name: 'Restore' })` matches FOUR buttons.
  Scope the dialog's buttons to the dialog locator.
- The normal case (the stored landlord is still typed `landlord`, or the
  property is ownerless): Restore restores at once; no dialog opens.
- Reaching the dialog in e2e: a soft-deleted property whose landlord of
  record is no longer typed `landlord`. The generic type change refuses
  re-typing the landlord of record of a LIVE unit only (spec section 3), so:
  create landlord X and a property owned by X, delete the property, PATCH X's
  type (for example to `partner`), then Restore -> 409
  `restore_needs_landlord` with `landlordName` = X's first + last name. A
  missing landlord contact also triggers it, with no name.

The dialog (`RestoreLandlordDialog.tsx`):
- `getByRole('dialog', { name: 'Restore property' })`.
- Sentence: `<landlordName> is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:`
  - with `This property's landlord` when the server named no one.
- Picker: `getByRole('combobox', { name: 'Landlord' })` (the shared
  `ContactSearchField`, landlords only). Its options are PORTALED to
  `document.body` - query `page.getByRole('option', { name: /<Full Name>/ })`,
  NOT scoped to the dialog; an option's name is `<display name> <kind>` (for
  example `Nora Lane Landlord`), so match by substring.
- Buttons (scope to the dialog): `Restore with this landlord` (disabled until
  a pick), `Restore without a landlord`, `Cancel`. The Modal also has an icon
  button named `Close`.
- Errors: one `role="alert"` paragraph inside the dialog - "Only a landlord
  can be a property's landlord of record." (409 `landlord_not_landlord`),
  "That landlord no longer exists." (404 `landlord_not_found`), "The property
  contacts changed - try that change again." (409 `unit_roster_conflict`; the
  page re-reads the property and the dialog stays open unless the re-read is
  already live), "Couldn't restore - please try again." (anything else).
- Success: the dialog closes; the page and the Contacts card show the
  restored property (the body path's enriched roster); the Deleted banner
  goes away. "Restore without a landlord" leaves an ownerless property whose
  old landlord row is gone.
- Wire: `restoreUnit(unitId)` still sends no body (the mutation catalog is
  unchanged); the dialog sends `{ landlordId: '<contactId>' }` or
  `{ landlordId: null }`.

The Add contact picker (property page, Contacts card): `getByRole('button', { name: 'Edit contacts' })`
-> `getByRole('button', { name: '+ Add contact' })` ->
`getByRole('combobox', { name: 'Add contact' })`. Options (portaled; names
`<name> <kind>`) are every live contact not already on the list EXCEPT a
caseworker (a `partner` whose role is Caseworker / case worker,
`isCaseworkerContact`); other partners, landlords and tenants still show. For
spec section 8's "Add contact hides a caseworker": type part of the
caseworker's name and expect zero options with that name, beside a control
contact whose option does show.

Where the roster refusal copy renders: `runRosterWrite` writes it to the
`role="alert"` paragraph of the row the write was for - under the "+ Add
contact" form for an add (`ListingDetail.tsx:1049-1053`), on the row itself
for a re-role or Make primary (`:976`). Sentences: "Caseworkers can't be on a
property's contact list." (409 `contact_list_caseworker`) and "Only a
landlord can be a property's landlord of record." (409
`landlord_not_landlord`). No refetch; the pick stays in the combobox. The
UI-reachable one is `landlord_not_landlord` (see the worries above).

New property (`UnitCreateForm`): the `New property` dialog's `role="alert"`
shows "Only a landlord can be a property's landlord of record." or "That
landlord no longer exists."; the dialog stays open and Create re-enables.
The form's picker loads landlords only, so this is API- or race-reachable.

Remove the primary contact (ownerless, Q2):
`getByRole('dialog', { name: 'Remove the primary contact?' })` body: "This
property will have no primary contact and has no landlord of record, so calls
and new relay groups for it will reach no one until a contact is added."
(`e2e/support/selectors.md:85` already says so.)
