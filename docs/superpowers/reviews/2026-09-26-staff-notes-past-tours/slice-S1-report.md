# Slice S1 report - app side of staff notes (plan Task 1)

Date: 2026-09-27
Branch: `feat/staff-notes-past-tours` (worktree `W:\tmp\staff-notes-past-tours`)
Slice base: `722deae7` (the drift-worklist commit)
Implementer: S1 child, Claude Opus 5.5 (1M context)
Status: DONE - red-then-green under strict TDD, typecheck clean, committed.

## What shipped (the contract)

Record type - `app/src/repos/contactsRepo.ts` (type only, no repo logic touched):

- `staff_notes?: string` declared at `contactsRepo.ts:143`, doc comment
  `:135-142`, placed directly after `park_reason` (`:134`) as spec 3.1 requires.
- `staff_notes_updated_at?: string` (ISO 8601) declared at `contactsRepo.ts:149`,
  doc comment `:144-148`.
- Neither name was added to `PROVENANCE_FIELDS`; no `staff_notes_source` exists.

PATCH allowlist - `app/src/routes/contacts.ts`, `parseTriageBody`:

- New block at `contacts.ts:574-583`, directly after the `notes` block (`:568-573`).
- `staff_notes` present and a string: copied into the patch and `'staff_notes'`
  pushed onto `changedFields` (`:578-583`). `''` is accepted and clears.
- `staff_notes` present and not a string: 400, body error exactly
  `staff_notes must be a string` (`:580`).
- `staff_notes_updated_at` is NOT parsed, so a client value is dropped like any
  unknown key; sent alone it produces the existing 400
  `no updatable fields supplied` (`:723-724`).
- Header comment `contacts.ts:7` now documents `staff_notes?` in the PATCH body.

Server stamp - `app/src/routes/contacts.ts`, `router.patch('/:contactId', ...)`:

- Block at `contacts.ts:1518-1523`, directly after the consent-stamp block
  (`:1510-1516`). Whenever `staff_notes` is in the parsed patch, the route sets
  `staff_notes_updated_at` to `new Date().toISOString()` (millisecond ISO, `Z`).
  It is the only writer of that key.
- The stamp is written into the patch BEFORE the provenance loop (`:1537-1541`)
  and the single `contacts.update` call (`:1573`). It is not pushed onto
  `changedFields`, so the audit `contact_updated` payload (`:1817-1821`) names
  `fields: ['staff_notes']` only.
- Response: `contacts.ts:1866` returns the repo's `ALL_NEW` item
  (`contactsRepo.ts:1352`), so the 200 body's `contact` carries both
  `staff_notes` and the fresh `staff_notes_updated_at`.
- Clear on the real repo: `''` is SET as a value, not removed - `update()`
  special-cases `''` only for index-key attributes (`contactsRepo.ts:1297`, set
  defined at `:456`) and removes only on `null` (`:1311-1312`). After a clear
  the item reads `staff_notes: ''` (key present) with a new stamp.

Test file - `app/test/contactStaffNotes.test.ts` (new, 8 tests): the five PATCH
tests (`:45`, `:68`, `:83`, `:94`, `:114`), the POST-ignores-it test (`:128`),
and the two AI pins - `toProfile` omits it (`:149`) and `applyExtraction` makes
no update carrying either key across ALL update calls (`:162`). Byte-identical
to the plan's Task 1 Step 1 block (diffed against plan lines 157-371).

## Commits

- `8c428d79` feat(contacts): staff_notes field - PATCH allowlist + server-stamped
  staff_notes_updated_at (item 22, spec 3.1-3.4). Three explicit paths: the two
  app source files and the new test.
- This report, as its own docs commit: `docs(staff-notes-past-tours): slice S1 report`.

## Verification (quoted)

- RED, before Steps 3-5:
  `cd /w/tmp/staff-notes-past-tours/app && npx vitest run test/contactStaffNotes.test.ts`
  -> exit 1, "Tests  4 failed | 4 passed (8)". The four failures are exactly
  the four PATCH tests the plan predicted, for the predicted reasons:
  "stores the text..." (expected 400 to be 200), "an empty string clears..."
  (expected 400 to be 200), "400s a non-string" (expected 'no updatable fields
  supplied' to be 'staff_notes must be a string'), "ignores a client-supplied
  staff_notes_updated_at..." (expected 400 to be 200 on the `beside` call). The
  notes-only PATCH, POST, `toProfile` and `applyExtraction` tests passed, as the
  plan says they must (regression pins of by-construction behavior).
- GREEN, after: same command -> exit 0, "Test Files  1 passed (1)",
  "Tests  8 passed (8)".
- Neighbors:
  `npx vitest run test/contactTriage.test.ts test/contactsCrud.test.ts test/extractionApply.test.ts test/extractionJob.test.ts`
  -> exit 0, "Test Files  4 passed (4)", "Tests  219 passed (219)"
  (extractionApply 79, extractionJob 77, contactsCrud 29, contactTriage 34).
  No `[dynamoAdmin]` line in the output.
- Typecheck: `cd /w/tmp/staff-notes-past-tours/app && npm run typecheck` -> exit 0.
  The script runs `tsconfig.json`, `tsconfig.scripts.json` and
  `tsconfig.test.json`; the last includes `app/test`, so the new test file is
  type-checked, not just transpiled.
- All three were re-run after the commit, at HEAD `8c428d79`: identical results
  (8 passed; 219 passed; typecheck exit 0).
- ASCII: added-lines check on `app/src/routes/contacts.ts` -> 0; on
  `app/src/repos/contactsRepo.ts` -> 0; whole-file check on
  `app/test/contactStaffNotes.test.ts` -> 0. The new file is LF-only.
- Not run, per the mission (orchestrator gates): full `npm test`, `npm run smoke`,
  `npm run e2e`, lint. No server or e2e session was started.

## Divergences from the plan

None. Code, placement, comments, test and commit message are the plan's text;
the commit trailer names the real authoring model in place of the plan's
placeholder. The plan's `pets` fallback advice (Task 1 note after Step 1) was
not needed - the direct write landed on the first run, as worklist N3 said. One
feat commit carries code and test together, as Step 7 prescribes (no separately
committed red test, which would leave a red commit on the branch).

## For the next slices

S2 (dashboard types + StaffNotesCard):

- Hand the PATCH 200 `contact` up as-is: it is the full stored item and already
  carries `staff_notes_updated_at` for the "Last edited" line.
- After a clear the wire carries `staff_notes: ''` (present, not absent) plus a
  stamp. Decide empty vs filled on the TRIMMED value, never on key presence, and
  show no "Last edited" for `''` - which is what the plan's card does.
- The route stamps on EVERY PATCH carrying `staff_notes`, even with unchanged
  text. The card's no-op check (worklist OD-2, trimmed compare) is the only
  thing that prevents a re-stamp with no text change. The stored value is
  trimmed by the body middleware (`trimJsonBody`, mounted at `app/src/app.ts:142`;
  worklist N4).
- The client never needs to send `staff_notes_updated_at`; if it does, it is
  ignored beside `staff_notes`, but sent alone it is a 400.
- The non-string 400 cannot arise from the card (it always sends a string), so
  its fixed alert covers network and 5xx failures only.

S3 (e2e):

- A staff-notes save is an ordinary triage PATCH. Like every PATCH it re-runs
  the name denormalization onto the contact's linked threads and emits one
  `conversation.updated` per linked thread (`contacts.ts:1779-1792`), appends
  one `contact_updated` audit event (`:1817-1821`), and makes one best-effort
  `extraction.getSuggestion` read for the field (`:1560-1569`) that finds
  nothing. It sends no message, and it schedules no extraction run (the triage
  re-extraction at `:1802` fires only when the PATCH itself sets
  `type: 'tenant'`).
- The seeded tenant carries no `staff_notes` key after a reseed (no create path
  or seed writes it), so the card starts in the "+ Add" state; the spec's
  cleanup step leaves the tenant with `staff_notes: ''`, as the worklist's S3
  run-order note already says.
- The stamp comes from the server clock in UTC ISO; the card formats it in the
  browser's local zone, so in the hermetic lane "Last edited" reads today's
  local date.
