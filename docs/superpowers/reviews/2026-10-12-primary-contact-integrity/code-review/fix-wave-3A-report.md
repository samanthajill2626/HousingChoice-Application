# Fix wave 3 - implementer A report: F1 + F3 (the property box's one-click rule and its copy)

Branch `feat/primary-contact-integrity`, worktree `W:\tmp\primary-contact-integrity`,
base `cabb4e06` (= `ebdd025d` + the drift-check record). Contract: findings F1
and F3 of `planner-review/fix-wave-findings.md`; brief
`.superpowers/sdd/fixwave3-brief-A.md`. Implementer: Claude Opus 5.5.
Strict TDD per item (red log, then green log); explicit-path commits.
F2 / F5a / F5b and their files were not touched (implementer B). F4: no change.

## Commits

| # | Hash | Item | One-liner |
|---|---|---|---|
| 1 | `7aea785a` | F1 server | feat(units): response-only autoEligible roster row flag |
| 2 | `4d4f4a41` | F3 dashboard | fix(listing): the no-eligible line asks for a property manager or owner |
| 3 | `2b133dab` | F1 dashboard | fix(listing): the no-primary box's one-click names a landlord-typed contact only |
| 4 | `30005052` | F1 script | fix(scripts): assign-primary-contacts noEligible copy asks for a property manager or owner |
| 5 | `0ae9096a` | F1 + F3 docs | docs: the box's one-click rule and the no-eligible line in spec, RUNBOOK and selectors |
| 6 | (this file) | records | docs(records): this report |

## F1 server - the `autoEligible` row flag

- `app/src/routes/units.ts:378-393` - `UnitContactView` gains `autoEligible?: true`;
  its docblock now names THREE response-only flags, the rule
  (`isAutoRoutingEligible`: typed landlord, live, not a phone/email routing
  pointer), the box's one-click as its purpose, and "all three absent when
  the read was incomplete".
- `app/src/routes/units.ts:661` - `enrichRosterView` sets the flag from the
  complete read it already does (`:653`, `readRosterContacts` with
  `requireComplete`); no new read, nothing stored. Docblock `:633-649` updated
  (the incomplete-read fallback - `enrichRoster` - carries no flag at all).
- Served by GET `/api/units/:id` (`:850`) and both contact-list writes
  (`:1830` POST, `:1906` DELETE). The restore routes still answer through
  `enrichRoster` (no flags, unchanged); the page re-reads through GET after a
  restore (spec 7.5).

Tests (FakeWorld):
- `app/test/unitsApiPropertyContact.test.ts:276-334` - new describe: the flag on a
  live typed-landlord row and NOT on a tenant, a caseworker, a deleted
  landlord-typed contact, a `phone_ref` record or an `email_ref` record (both
  seeded typed landlord, so the pointer test alone excludes them) (`:277`);
  a soft-deleted landlord of record's derived row (`:309`); a live landlord of
  record typed TENANT - the flag reads the type, not the role (`:322`).
- Absent on an incomplete read, both failure shapes: explicit pins at
  `unitsApiPropertyContact.test.ts:357` (GET) and
  `unitsApiPropertyContactWrites.test.ts:170` (POST); the existing exact-row
  pins of those cases already held it.
- Write responses: `unitsApiPropertyContactWrites.test.ts:86` (POST add of a
  tenant on a no-primary property - only the typed-landlord row is flagged,
  block `none`), plus the DELETE non-primary case now pins its rows.
- Existing exact-row pins now carry the flag where the row is a live typed
  landlord: `unitsApiPropertyContact.test.ts` (4 cases),
  `unitsApiPropertyContactWrites.test.ts` (2 cases),
  `app/test/unitsApiRoster.test.ts:59-62`, `:90` (2 cases).

Evidence: red 9 failed / 15 passed (24) - every diff line a missing
`"autoEligible": true` - `.superpowers/sdd/fixwave3-A-server-red.log`; green
24/24 `.superpowers/sdd/fixwave3-A-server-green.log`. Every app test that
hits the units router (23 files): baseline 427/427
(`fixwave3-A-baseline-units-routes.log`), after the change 2 failed / 429
passed (`fixwave3-A-server-neighbors.log` - the two `unitsApiRoster` exact
pins), after updating them 431/431 (`fixwave3-A-server-neighbors-green.log`).

## F1 dashboard - the box's four cases

- `dashboard/src/api/types.ts:3171-3176` - `UnitContact.autoEligible?: true`
  beside `deleted` / `caseworker`, same response-only comment contract.
- `dashboard/src/routes/listing/buildListingFile.ts:40-44`, `:74` - `RosterRow`
  gains the flag and `listingRoster` carries it through (see Divergences 1).
- `dashboard/src/routes/listing/ListingDetail.tsx:528-544` - the comment above
  `showNoPrimaryBox` rewritten to the new rule (no more "broader than the
  server's AUTOMATIC rule ... on purpose"); the counts are now the
  `autoEligible` rows (`:542-543`) and whether any live non-caseworker row is
  left to pick by hand (`:544`).
- `ListingDetail.tsx:1098-1130` - the box action, Cameron's four cases: one
  `autoEligible` row -> "Make <Name> primary" (unchanged write,
  `onMakePrimaryContact(row, NO_PRIMARY_BOX_KEY)`); two or more -> "Choose a
  primary"; none with a live non-caseworker row -> the no-eligible line AND
  "Choose a primary"; none and no such row -> the line only. Edit mode's
  per-row Make primary is unchanged (type-agnostic).
- `ListingDetail.tsx:151-158` - the `NO_ELIGIBLE_LINE` docblock names the new
  trigger (no live contact typed landlord).

Tests (`dashboard/src/routes/listing/ListingDetail.test.tsx`, integrity block):
- Fixtures: `MARK` (`:2547-2553`) and the box block's `DANA` (`:2647-2653`)
  carry `autoEligible: true` (they mean landlord-typed rows); new
  `TIA_TENANT` (`:2556`); the line as `NO_ELIGIBLE` (`:2646`).
- New: one autoEligible row next to a tenant -> "Make Mark Passmore primary",
  no tenant one-click, no line (`:2704`); tenant the only live row -> no
  one-click, the line AND "Choose a primary", whose edit mode still offers
  "Make Tia Tenant the primary contact" (`:2714`); caseworkers only -> line,
  no button (`:2752`); every row deleted -> line, no button (`:2760`).
- Updated: two or more autoEligible rows (now with a tenant between them) ->
  "Choose a primary", no line (`:2728`); the deleted + caseworker case
  retitled to the rule (`:2741`).
- `dashboard/src/routes/listing/buildListingFile.test.ts:49-60` - the flag is
  carried through, and absent when the server did not send it.

Evidence: red 3 failed / 135 passed (138) across the two files - today's
box offered `Make Tia Tenant primary`, offered "Choose a primary" for
Mark + Tia, and `listingRoster` dropped the flag -
`.superpowers/sdd/fixwave3-A-dashboard-red.log`; green 138/138
`.superpowers/sdd/fixwave3-A-dashboard-green.log`. Neighbor sweep
(`src/routes/listing`, `shared`, `tours`, `placement`): 57 files, 1324/1324
(`fixwave3-A-dashboard-neighbors.log`).

## F1 script - the noEligible copy

- `app/scripts/assign-primary-contacts.ts:330` (per-unit log, keeps the
  `${SCRIPT_NAME} - ` prefix), `:453` (summary count), `:467` (list line) -
  exactly the three strings F1 gives. Header comment `:28-33` updated.
- `app/test/assignPrimaryContacts.run.test.ts:368-381` - pins all three (it
  pinned only the list line before): the count line, the list line, and the
  per-unit log line for `u-only-tenant` from the captured log.

Evidence: red 1 failed / 9 passed (10)
`.superpowers/sdd/fixwave3-A-script-red.log` (the run stops at the first of
the three pins); green 10/10 `.superpowers/sdd/fixwave3-A-script-green.log`.

## F1 docs - spec, RUNBOOK, selectors

- Spec `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`:
  7.4 Action bullets `:552-576` (the "DELIBERATE click, broader than the
  automatic rule" sentence is gone; counts `autoEligible` rows; the four
  cases; the line's truth and its F3 wording; edit mode type-agnostic);
  7.5 per-row flags `:602-608` (`autoEligible`, complete read only, never
  stored); 8 noEligible bullet `:674-678` ("listed by unit id so Sam can add
  a property manager or owner (the property box says so)").
- `RUNBOOK.md` "Primary contacts backfill": `:506` noEligible description,
  `:511` summary string, `:512` list string, `:516` step 4 rewritten (the
  one-click only for a contact typed landlord; tenants or caseworkers -> the
  box asks for a property manager or owner, who becomes primary
  automatically; "Choose a primary" remains for a hand pick while a live
  non-caseworker row is left; caseworkers only -> no button).
- `e2e/support/selectors.md:88` - the no-primary box row: counts the
  `autoEligible` rows, the four cases, the new line.
- `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts:275-276` -
  comment only (see Divergences 3).

## F3 - the no-eligible line

Old `Add the landlord or property manager - ...` -> new `Add a property
manager or owner - they become the primary automatically.` everywhere it is
live copy or a live doc:
- `dashboard/src/routes/listing/ListingDetail.tsx:156` (`NO_ELIGIBLE_LINE`;
  its docblock `:151-158` records why: builder Q1's 409
  `landlord_reassignment_required` while a deleted contact is still the
  landlord of record).
- `ListingDetail.test.tsx:2646`, `:2747` (the only test that pinned it).
- Spec 7.4 `:567-568`; `e2e/support/selectors.md:88`; RUNBOOK step 4 `:516`.
- No e2e spec pins the line (grep). The plan and the review records were not
  edited.

Evidence: red 1 failed / 122 passed (123)
`.superpowers/sdd/fixwave3-A-f3copy-red.log`; green 123/123
`.superpowers/sdd/fixwave3-A-f3copy-green.log`. A sweep of live files
(`*.ts`, `*.tsx`, `*.md` outside the plan, the review records and
`.superpowers/`) finds none of the old strings.

## Verify commands (bare, redirected)

| Command | Exit | Result | Log |
|---|---|---|---|
| app vitest (the brief's 5 files) | 0 | 5 files, 58/58 | `.superpowers/sdd/fixwave3-A-verify-app.log` |
| dashboard vitest `ListingDetail.test.tsx` | 0 | 127/127 | `.superpowers/sdd/fixwave3-A-verify-dashboard.log` |
| `npm run typecheck` | 0 | all workspaces clean | `.superpowers/sdd/fixwave3-A-typecheck.log` |
| `npx eslint` on the 12 touched code files | 0 | no output | `.superpowers/sdd/fixwave3-A-eslint.log` |

Touched code files (the eslint list): `.superpowers/sdd/fixwave3-A-touched-files.txt`.
The branch's one pre-existing lint error (`TourDetail.tsx:342`) is not in it.
Baselines before any edit: app 5 files 54/54, dashboard 2 files 133/133
(`fixwave3-A-baseline-app.log`, `fixwave3-A-baseline-dashboard.log`).

## e2e subset

`timeout 900 npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/primary-contact-integrity.spec.ts`,
foreground, lane 13 checked free first (stale `session.pid` only, no
process, no listener): exit 0, 3 passed ((a), (b), (c); 14.2s of tests),
lane ports released afterwards. Log `.superpowers/sdd/fixwave3-A-e2e-pci.log`.
(a) and (b) drive the one-click on a landlord-typed Mark end to end (the
server's flag reaching the box); (c) seats a tenant plus two landlord-typed
contacts -> "Choose a primary". No other spec drives the box: `caseworkers.spec.ts`
has no box interaction and `property-roster.spec.ts` uses only the edit-mode
"Make <Name> the primary contact".

## Divergences from the findings / brief (with rationale)

1. `dashboard/src/routes/listing/buildListingFile.ts` (+ its test) is not named
   in the brief, but the box reads `RosterRow`, which `listingRoster` builds
   field by field: without the pass-through the dashboard never sees the
   flag. It mirrors the `deleted` / `caseworker` pass-through exactly.
2. `app/test/unitsApiRoster.test.ts` - two pre-existing exact-row pins gained
   `autoEligible: true` (live typed-landlord rows); not named in the brief,
   found by running every units-router test file.
3. `primary-contact-integrity.spec.ts` (c) - the comment "Three live,
   non-caseworker rows" described the old count; now "Two rows typed
   landlord". Comment only; no expectation changed.
4. Extra pins beyond the brief's list: the tenant-typed landlord of record,
   the deleted landlord of record's derived row, and the DELETE response's
   rows.
5. The F3 docblock and the spec 7.4 bullet state WHY the line says "a property
   manager or owner" (builder Q1's 409), so the next reader does not
   "fix" it back.

## Noticed, not touched (the orchestrator's eye; nothing blocking)

- Spec 4.4 `:288` - "if Mark is not typed landlord, nothing is automatic and
  the property box offers the click": under F1 that property gets the line +
  "Choose a primary", not a one-click. Outside the 7.4 / 7.5 / 8 amendment
  scope.
- Spec 10 `:825-826` - "The 7.4 box's eligible-row count (live, not a
  caseworker) is pinned separately from the heir function's automatic rule":
  now stale - the one-click counts `autoEligible` (the automatic rule's own
  flag); live-non-caseworker only gates the hand-pick button. Outside scope.
- `docs/issues/restore-without-landlord-can-leave-nobody-reachable.md:112-114`
  (status resolved) quotes the old box rule and the old line in its
  resolution narrative; `docs/issues/*` is implementer B's area, and that
  block is a dated record.
- `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md:67-70` says the
  box "offers its one-click fix" when "an eligible row exists" - B resolves
  this issue in F2 (flagged in the reference note).
- By design, the one-click rule is a UI rule: POST `/api/units/:id/contacts`
  with `primaryContact: true` still accepts a tenant (the edit mode's
  deliberate, type-agnostic pick). Nothing server-side was asked for.
- The findings' "Done means" live self-QA (tenant-only box shows the line +
  "Choose a primary" and no one-click; landlord-typed sole contact shows
  "Make <Name> primary", screenshots under `self-qa`) was not part of brief A
  and was not run; the tenant-only case is covered by dashboard unit tests,
  the landlord-typed one-click by the e2e subset.

Reference notes for implementer B (post-A `units.ts` anchors, the wire change
their tests will see, exact copy): `.superpowers/sdd/fixwave3-A-reference.md`
(gitignored).
