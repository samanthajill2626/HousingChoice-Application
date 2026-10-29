# S1 slice report - The Notes box (WP1 B2a)

- Slice: plan section 5, S1 (tasks S1.1-S1.11); spec D14 (all three parts)
  and D15; watch items WI3, WI4 (S1 half), WI5, WI10 (S1 half); WORKLIST
  section G and WL-S1-1..WL-S1-3.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`,
  base main @404e039d. Implementer: Claude Opus 5.5, 2026-10-29.
- Verdict: every task built test-first as written; every RED was red for the
  stated reason; no behavior change, no ruling change, no QUESTION. No
  one-value test fix was needed.

## 1. Tasks and commits

| Task | Commit | What landed |
|---|---|---|
| S1.1 | 657e7e7b | `app/src/lib/singleLine.ts` `toOneLine` (leaf) + `app/test/singleLine.test.ts` |
| S1.2 | 7822273f | `prompt.ts` transcript folds through `toOneLine`; 3 transcript cases appended to `extractionSchema.test.ts` |
| S1.3 | f3972b8f | `filterNoteLines` collapses breaks before the clamp and the guard, returns `duplicate`; `extractionNoteLines.test.ts` replaced whole; "both callers" pin |
| S1.4 | 2895ed6a | `ApplyOutcome.notesDuplicate`, `RunDraft` / `recordRun` in `jobs/extraction.ts`, `AiRunRecord.notesDuplicate?` |
| S1.5 | 6a555e4a | dashboard `AiRunRecordView.notesDuplicate?`; AiRunDetail "N already in the notes", counted |
| S1.6 | 9c1c13c7 | `ContactItem.notes_updated_at`; joins `SERVER_OWNED_CONTACT_FIELDS`; PATCH and manual create stamp it; `contactNotesGuard.test.ts` (new) |
| S1.7 | ae260c0e | extraction append and importer upsert stamp it in the same write; `seedNotesStamp.test.ts` (new) |
| S1.8 | 62bf80c0 | PATCH `notes_expected_updated_at` guard and 409 `notes_stale` (D14.3 rule, staff_notes_stale wins) |
| S1.9 | 55e292c5 | D15 staff_notes comments; propertyLabel comments name `toOneLine` (PR27). Comment-only, no RED |
| S1.10 | ed0a8fb9 | edit form: stamp sent with `notes`, trimmed compare, conflict panel, re-base on refusal and on a PATCH that stored notes (FB8) |
| S1.11 | (this report's commit) | gates, sweeps, this report |

## 2. Test commands and counts (every run, in order)

All app runs from `W:/tmp/wp1-b2-ranking-engine/app`, dashboard runs from
`W:/tmp/wp1-b2-ranking-engine/dashboard`. DynamoDB Local (`hc-dynamodb-local`
:8000) was up throughout; no `AWS_*` variable is exported; no skip was seen.

| Task | Step | Command (vitest run ...) | Result |
|---|---|---|---|
| S1.1 | RED | `test/singleLine.test.ts` | file failed to load: "Cannot find module '../src/lib/singleLine.js' ... Failed to load url ... Does the file exist?" (module missing - the stated reason; wording per G4 / D1-4) |
| S1.1 | GREEN | `test/singleLine.test.ts` | 1 file, 5 passed |
| S1.2 | RED | `test/extractionSchema.test.ts` | 2 failed / 65 passed (67): exactly the first and third new cases; the (PIN) and every older case pass |
| S1.2 | GREEN | `test/extractionSchema.test.ts test/extractionRunWindow.test.ts test/extractionAdapter.test.ts test/singleLine.test.ts` | 4 files, 122 passed |
| S1.3 | RED | `test/extractionNoteLines.test.ts test/singleLine.test.ts` | 23 failed / 18 passed (41): extractionNoteLines 22 fail / 13 pass, singleLine 1 fail ("both callers") / 5 pass - the stated list; the (PIN) "strips a copied prefix" passes |
| S1.3 | GREEN | `test/extractionNoteLines.test.ts test/singleLine.test.ts test/extractionApply.test.ts test/extractionPromptProbe.test.ts` | 4 files, 300 passed (the two whole-`ApplyOutcome` cases still green: S1.3 did not change `ApplyOutcome`) |
| S1.4 | RED | `test/extractionApply.test.ts test/extractionJob.test.ts` | 4 failed / 233 passed (237): the two whole-outcome `toEqual`s, "reports the lines the retry guard dropped", "records notesDuplicate" |
| S1.4 | GREEN | `test/extractionApply.test.ts test/extractionJob.test.ts test/extractionNoteLines.test.ts test/contactStaffNotes.test.ts test/aiRunsRepo.test.ts test/aiRunsApi.test.ts` | 6 files, 366 passed |
| S1.5 | RED | `src/routes/settings/aiRuns/AiRunsSection.test.tsx` | 2 failed / 43 passed (45): the two stated cases; the (PIN) passes |
| S1.5 | GREEN | same | 1 file, 45 passed |
| S1.6 | RED | `test/contactNotesGuard.test.ts test/contactsCrud.test.ts` | 5 failed / 50 passed (55): the two `notes_updated_at` OWNED cases and contactNotesGuard cases 1, 2 and 4; the (PIN) passes |
| S1.6 | GREEN | `test/contactNotesGuard.test.ts test/contactsCrud.test.ts test/contactStaffNotes.test.ts test/contactTriage.test.ts test/trimStrings.test.ts test/landlordRequirementsPatch.test.ts` | 6 files, 227 passed |
| S1.7 | RED | `test/extractionApply.test.ts test/extractionJob.test.ts test/importApply.integration.test.ts test/seedNotesStamp.test.ts` | 3 failed / 277 passed (280): the extraction stamp case, the extractionJob `toHaveBeenCalledWith` case, the importer case; both seed pins and the (PIN)s pass |
| S1.7 | GREEN | `test/extractionApply.test.ts test/extractionJob.test.ts test/importApply.integration.test.ts test/seedNotesStamp.test.ts test/contactStaffNotes.test.ts test/importOrgNames.test.ts` | 6 files, 315 passed (importer suite ran against DynamoDB Local, no skip) |
| S1.8 | RED | `test/contactNotesGuard.test.ts` | 9 failed / 15 passed (24): stale stamp, null case, cleared box, the 400s, both "notes alone changed", both "both changed" (answered contact_changed), both-boxes "Notes alone moved" - the exact stated list |
| S1.8 | GREEN | `test/contactNotesGuard.test.ts test/contactStaffNotes.test.ts test/landlordRequirementsPatch.test.ts test/contactsCrud.test.ts test/contactTriage.test.ts` | 5 files, 241 passed |
| S1.9 | GREEN | `npm run typecheck` (root, bare) then `test/propertyLabel.test.ts` | typecheck exit 0; 1 file, 18 passed |
| S1.10 | RED | `src/routes/contact/ContactEditForm.test.tsx` | 10 failed / 132 passed (142): the whole new describe except "sends no stamp when the save does not touch the Notes box"; all 131 older cases pass |
| S1.10 | GREEN | `src/routes/contact/ContactEditForm.test.tsx src/routes/contact/StaffNotesCard.test.tsx src/routes/contact/ContactDetail.test.tsx` | 3 files, 318 passed; `npx tsc -p tsconfig.json --noEmit` (dashboard) exit 0 |
| S1.11 | Step 3 | `npm run typecheck` (root, bare) | exit 0, 0 `error TS` lines |
| S1.11 | Step 4 | `npx eslint` on the 25 slice files (the plan's list; equals `git diff --name-only --diff-filter=d 404e039d...HEAD` over ts/tsx) | exit 0 - no error, so no baseline comparison was needed and no pre-existing error is named |
| S1.11 | Step 5 | app `npx vitest run` (whole workspace, at ed0a8fb9) | exit 0: 548 files passed; 11854 tests passed, 1 skipped (11855) - the skip is the diagnostic "built dashboard identity tags" (PASS or SKIP, never FAIL; no built dashboard/dist in the worktree); 117.5 s. No red file, so no re-run. Zero `[dynamoAdmin]` lines in the output (the ProvisionedThroughputExceededException log lines come from the tests' own throwing stubs, e.g. importConvertGroups.test.ts:122, groupConvert.test.ts:119) |
| S1.11 | Step 5 | dashboard `npx vitest run` (whole workspace, at ed0a8fb9) | exit 0: 273 files passed; 5672 tests passed; 61.8 s |
| S1.11 | Step 6 | ASCII sweep `git diff -U0 404e039d -- app dashboard` added lines | 0 non-ASCII bytes; the perl raw-separator check over singleLine.ts, singleLine.test.ts, extractionSchema.test.ts and extractionNoteLines.test.ts printed nothing |

## 3. Contradictions C1-C11 (plan S1 head)

- C1 (spec section 2 pointers): resolved by quoted anchors, as planned.
  After S1: `SERVER_OWNED_CONTACT_FIELDS` app/src/routes/contacts.ts:319-326,
  the Staff notes stamp :1981, the Notes stamp :1988, the guard list
  :2047-2062, the conflict re-read :2081-2101. `filterNoteLines`
  app/src/services/extraction/apply.ts:335, the append write :992,
  `renderUtteranceLine`'s call app/src/services/extraction/prompt.ts:245.
- C2 (three PIN cases pinned multi-line behavior): app/test/extractionNoteLines.test.ts
  replaced whole from the plan (338 lines). The same-run retry is rebuilt on
  the collapsed line (:151); the later-day case keeps bare and copied-prefix
  lines (:176); the multi-line side effect has its own case (:286); the
  run-of-lines case is gone, replaced by the D14.1 describe.
- C3 (collapse after `withoutAutoPrefix`, before the cut): apply.ts:353
  `toOneLine(withoutAutoPrefix(text)).slice(0, MAX_NOTE_CHARS).trim()`;
  system lines apply.ts:367 `toOneLine(raw.trim())`. Pinned by "collapses
  BEFORE the clamp" (extractionNoteLines.test.ts:249) and the (PIN) "strips a
  copied prefix and the ends first".
- C4 (refuse, not ignore): `notes_updated_at` is refused 400 on POST and
  PATCH (contacts.ts:325 in the list; `refuseServerOwnedFields` :328, called
  by both parsers :592 and :909); `staff_notes_updated_at` keeps its ignore
  behavior (contacts.ts:664 comment; contactStaffNotes.test.ts "ignores a
  client-supplied staff_notes_updated_at" green).
- C5 (trimmed compare): dashboard/src/routes/contact/ContactEditForm.tsx:442
  `notes.trim() !== notesBaseline.text.trim()`, as StaffNotesCard.tsx:116
  does; pinned by "a whitespace-only Notes edit is no change".
- C6 (panel copy order): `NOTES_STALE_COPY` ContactEditForm.tsx:137-138 =
  "Nothing was saved." then the D14.3 text verbatim, plain ASCII.
- C7 / plan review FB11 (importer stamp): app/src/lib/import/apply.ts:1196-1203
  sets `notes = :notes, notes_updated_at = :notesUpdatedAt` (`importedAt`) in
  the ONE upsert `UpdateCommand` that serves a new and a re-imported contact.
  Consequence, recorded as the plan asks: a re-import whose notes text is
  UNCHANGED still re-stamps `notes_updated_at`, so a contact edit form open
  across an import meets `notes_stale` over identical text. Consistent with
  D14.3 and accepted; S8 records it in `import-overwrites-notes-box` (the
  overwrite itself stays unguarded).
- C8 (run-detail hash): accepted with D14.1, no code. app/src/routes/aiRuns.ts:259-261
  recomputes each window message's hash through `hashRenderedMessage`
  (services/extraction/runWindow.ts, which renders with
  `renderUtteranceLine`), so an extraction run recorded BEFORE B2a whose
  window holds U+2028 / U+2029 now shows hash status "mismatch" (PR28 lists
  it for Cameron).
- C9 (a demoted run counts duplicates): the guard runs before demotion;
  apply.ts returns `duplicate` on the demoted branch too; pinned by "a demoted
  run still counts its duplicates" (extractionNoteLines.test.ts:325). Floor,
  blank and postal drops never count ("never counts a floor, blank or postal
  drop as a duplicate").
- C10 (WI5 fingerprint test cannot see a text change): FP recorded before and
  after S1.2 (section 5, WI5) and the prompt.ts diff read in S1.11 Step 1.
- C11 (merges): no contact merge exists in app/src - a grep for
  `mergeContact(s)` / `contact(s)Merge` finds nothing; the "merge" hits are
  the importer's people merge (lib/import) and unrelated message/group code.

## 4. WI3 - every writer of a contact's `notes`

Sweep: the plan's S1.11 Step 2 grep over app/src and app/scripts (97 hits,
every hit classified), plus every `contacts.create` / `createIfAbsent` caller
and every module naming the contacts table, plus root `scripts/`, the seed
layers, the webhooks and dev.ts (no `notes` hit outside comments). No writer
outside the table was found.

| Writer | Writes a contact's `notes` | Stamp (file:line of the write) |
|---|---|---|
| contacts PATCH (routes/contacts.ts `parseTriageBody` :655-660) | yes | stamped in the same write, contacts.ts:1987-1989; guarded by `notes_expected_updated_at` (parse :687-696, guard :2051-2054, rule :2087-2095) |
| manual create (routes/contacts.ts `parseCreateBody` :945-948 + POST) | yes | stamped, contacts.ts:1268-1270 (then `contacts.create(parsed.item)` :1272) |
| extraction apply (services/extraction/apply.ts, the append) | yes | stamped with the run instant `at`, apply.ts:992; unguarded by design |
| importer (lib/import/apply.ts `upsertContact`, create and re-import) | yes, create and re-import | stamped with `importedAt`, lib/import/apply.ts:1200-1202; unguarded (import-overwrites-notes-box) |
| importer unit facts (lib/import/apply.ts:1562-1565 `fact('notes', ...)` in `upsertUnit`) | no - a unit's notes | n/a |
| importer review rows (lib/import/reviewNotes.ts:79, :155; lib/import/workbook.ts) | no - workbook rows in memory | n/a |
| public sign-up (routes/public.ts create :617 and update) | no | n/a |
| unmatched email create (routes/unmatchedEmail.ts:465-471) | no | n/a |
| caseworker conversion (services/caseworkerConversion.ts) | no | n/a |
| contact capture, group convert, group members stubs (services/contactCapture.ts:111, services/groupConvert.ts:347, services/groupMembers.ts:155) | no | n/a |
| consent stamps (routes/webhooks/twilio.ts, routes/webhooks/voice.ts) | no | n/a |
| extraction field writes (apply.ts `writePatch`, :748; `notes` is not an extractable field) | no | n/a |
| extraction / suggestion repos touching the contacts table (repos/extractionRepo.ts, repos/suggestionResolutionRepo.ts) | no | n/a |
| contact merges | none exist in app/src (C11) | n/a |
| seeds (lib/seed/*, seedData.ts, performanceSeed.ts) | no (S1.7 pins `seedNotesStamp.test.ts`) | n/a |
| dev routes (routes/dev.ts) | no | n/a |
| org list notes (services/orgNames.ts, routes/organizations.ts, lib/orgStartingList.ts), placements (routes/placements.ts:264, repos/placementsRepo.ts:170), units (repos/unitsRepo.ts:457) | not a contact | n/a |

Readers seen by the sweep (no change needed): `jobs/extraction.ts:198-199`
toProfile (the stamp never reaches the prompt: explicit picks),
`lib/caseworkers.ts:75-77` and `services/possibleCaseworkers.ts:84`
(`hasAiCaseworkerNote`), `scripts/extraction-prompt-probe.ts:926`.

## 5. Watch items

- WI3: section 4. The four writers stamp in the same write; nothing else
  writes a contact's `notes`.
- WI4 (S1 half): `notes_updated_at` is in `SERVER_OWNED_CONTACT_FIELDS`
  (app/src/routes/contacts.ts:325); the contactsCrud cases "POST refuses a
  client-sent notes_updated_at with 400 and creates nothing" and "PATCH
  refuses a client-sent notes_updated_at with 400 and writes nothing" are
  green. The tenant-card exclusion is S3's (WL-S3-2).
- WI5: FP-before `915df487ad47` (S1.2 Step 0) = FP-after `915df487ad47`
  (S1.2 Step 4) - equal. The prompt.ts diff against 404e039d has exactly 3
  hunks: the `toOneLine` import (prompt.ts:12), the removed `toSingleLine`
  (its docblock now the `//` comment at :222-231), and the one call in
  `renderUtteranceLine` (:245). Nothing inside `buildExtractionSystemPrompt`
  or the schema changed; `app/src/services/extraction/schema.ts` diff is
  empty. The prompt-fingerprint case (extractionSchema.test.ts:421) is green
  unchanged. C8 (pre-B2a runs with U+2028 / U+2029 now read "mismatch") is
  accepted with D14.1.
- WI10 (S1 half): `git diff --stat 404e039d -- app/src/lib/seed
  app/src/lib/seedData.ts app/src/lib/performanceSeed.ts app/src/routes/public.ts
  app/src/routes/unmatchedEmail.ts app/src/routes/dev.ts
  app/src/services/caseworkerConversion.ts app/src/services/contactCapture.ts
  app/src/services/groupConvert.ts app/src/services/groupMembers.ts
  app/src/services/extraction/schema.ts` printed nothing. Both
  `seedNotesStamp.test.ts` pins (lean world; full world = lean + cast +
  matrix + live at a fixed instant) are green: no seed contact carries
  `notes` or `notes_updated_at`.

## 6. WORKLIST items

- G1: no `npm ci`, `npm install` or `npm run db:start` was run; node_modules
  and DynamoDB Local were used as found.
- G2 / WL-S1-1: every file or block holding a backslash escape was copied
  BYTE-EXACT from the plan with `sed -n '<first>,<last>p'` (boundaries
  checked first), never typed: singleLine.test.ts (plan 834-882, 49 lines),
  singleLine.ts (903-924, 22 lines), the extractionSchema append (971-999),
  extractionNoteLines.test.ts (1104-1441, 338 lines, last line `});`), and
  the S1.3(b) append (1454-1463). The test blocks without `\u` (S1.4, S1.6,
  S1.7, S1.8, S1.10 test appends, the new test files and the CSS block) were
  copied the same way. After each: non-ASCII byte count 0 and the perl
  raw-separator check printed nothing. Because nothing was typed, the plan's
  doubled backslash in `toContain('\\u2028')` survived intact (checked with
  `od -c`), so D1 reference R1 (the `fromCharCode(92)` form) was NOT needed
  and the test text is exactly the plan's. S1.1 GREEN: 5 passed, as the
  WORKLIST expects.
- G3: S1 writes no comment about `failedBatches`, `putMatches`,
  `promptFingerprint` (ranking) or `capOf` - nothing to correct.
- G4: every RED was red for its stated reason; the only wording difference
  is S1.1's missing-module message (section 2).
- G5: not applicable to S1 (no ranking constants).
- G6: no `ANTHROPIC_*` value was read or printed; no test or command
  constructed a sending client (the S1.2 fingerprint command calls no model).
- G7: the two workspace suites ran to completion inside this turn.
- WL-S1-2: the WI3 table cites `routes/webhooks/twilio.ts` and
  `routes/webhooks/voice.ts`.
- WL-S1-3: S1 did not touch `documentation/GLOSSARY.md` (S8.9's, WL-S8-9).

## 7. Deviations from the plan text

- Mechanism only (WORKLIST G2 / WL-S1-1): the plan's heredocs and pasted
  blocks were applied by `sed` line-range extraction from the plan file, not
  by typing; the written text is byte-identical to the plan.
- S1.1 Step 2's quoted RED text ("Failed to resolve import") is not vitest
  3.2.6's wording; the RED reason (module missing) holds (G4, D1-4).
- No other deviation: no one-value test fix, no behavior change, no QUESTION.

## 8. Other records the plan asks for

- Untrimmed input paths: `notes_expected_updated_at` passes the global JSON
  body trim like every body string (`trimJsonBody`, app/src/app.ts:146;
  app/src/middleware/trimStrings.ts), so a whitespace-only value arrives as
  '' and is refused 400 (contacts.ts:690-693). The edit form compares the
  Notes box trimmed (C5).
- S1 adds no guard to the importer's or extraction's Notes write (spec 4;
  `import-overwrites-notes-box` stays open), and builds no e2e spec (PR9: the
  Notes-conflict e2e is S7's).
- Issue-registry updates S1 makes possible (S8 writes them, per the plan's
  cross-slice notes): `extraction-note-line-break-unprefixed-continuation`
  closed by S1.3; `contact-edit-form-notes-save-drops-auto-lines` closed by
  S1.6, S1.8 and S1.10; `notes-guard-stale-reread-vs-flip-back` part one done
  (S1.3-S1.5), stays open for production numbers; `import-overwrites-notes-box`
  stays open (the importer now stamps, still unguarded; C7 above).

## 9. For the next slices (exact names S1 shipped)

- `app/src/lib/singleLine.ts` (leaf, imports nothing): `export function
  toOneLine(text: string): string` - each run of CR, LF, U+2028, U+2029 to
  " / "; ends and other whitespace untouched (callers trim).
- `app/src/services/extraction/apply.ts`: `NoteLineFilterResult.duplicate:
  number`; `ApplyOutcome.notesDuplicate: number`.
- `app/src/repos/aiRunsRepo.ts:83` `AiRunRecord.notesDuplicate?: number`
  (S1.4 touched only this field; the header comment at :1-2 is S2's,
  WL-S2-10); `app/src/jobs/extraction.ts` `RunDraft.notesDuplicate?` :367,
  set :721, recorded :775.
- `app/src/repos/contactsRepo.ts:198` `ContactItem.notes_updated_at?: string`
  - now a TYPED attribute: S3's `TENANT_CARD_FIELDS` must classify it
  `exclude`, and S3 drops it from `UntypedTenantKey` (WL-S3-2, WI4's other
  half). S3's writer-key scan will find `'notes_expected_updated_at' in b`
  in `parseTriageBody` (contacts.ts:688): a guard, never stored; the stored
  key is `notes_updated_at`, stamped by the route.
- `app/src/routes/contacts.ts`: `SERVER_OWNED_CONTACT_FIELDS` gains
  `'notes_updated_at'` (:325); `TriagePatch.notesExpected?: string | null`;
  409 bodies `{ error: 'notes_stale', contact }`; the 400 message
  `notes_expected_updated_at must be a non-empty string or null`.
- Dashboard `dashboard/src/api/types.ts`: `AiRunRecordView.notesDuplicate?`
  (:395), `Contact.notes_updated_at?` (:2395),
  `ContactPatch.notes_expected_updated_at?: string | null` (:2541).
- `dashboard/src/routes/contact/ContactEditForm.tsx`: `export const
  NOTES_STALE_COPY` (:137). The panel is `role="alert"` directly above the
  Notes box, outside its WRAPPING label, holding `NOTES_STALE_COPY` and the
  current notes (or "(The notes were cleared.)"); the textarea's
  `aria-describedby` names the panel while a conflict shows. S7.12 drives it
  end to end (PR9).
- Seeds: S1 changed no seed file; `app/test/seedNotesStamp.test.ts` pins
  that no lean or full-world contact carries `notes` / `notes_updated_at`
  (S2's lean-seed edit must keep both pins green).
- Suite state at S1 close: section 2, S1.11 Step 5.
