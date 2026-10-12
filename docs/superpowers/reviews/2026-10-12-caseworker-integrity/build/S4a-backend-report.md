# S4a build report - properties backend: landlord of record (I3), contact list (I4), restore (U5)

Implementer: U5 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 2dd668f8 (S1-S3 done; base 19607658).
Plan `docs/superpowers/plans/2026-10-12-caseworker-integrity.md` Tasks
4.1-4.6 (the BACKEND half of slice S4), orchestrator corrections C1-C2, the
half-slice gate and the required mutant check (M1-M11). The dashboard half
(Tasks 4.7-4.13) is the next implementer's; no dashboard file was edited.
Findings only; code is cited by file:line at dc143817 (the last code/test
commit; `app/src/routes/units.ts` and `app/src/repos/unitsRepo.ts` are
unchanged since a16aa28c / 74c0d07a).

Headline: 7 commits - one per plan task (6) plus one gap-test commit. Every
RED failed for the reason the plan states, every GREEN passed as written,
every plan anchor matched exactly once (the Task 4.1 `replace_all` matched
its 27 call sites). The half-slice gate is green (all exit 0; both
DynamoDB Local integration files RAN, none skipped), lint is clean on all 11
app paths, and all eleven required mutants were killed by the plan's own
tests. One EXTRA mutant I added (dropping the S4 route-level
`consistentRead: true` options) survived - FakeWorld repos ignore the option -
so three (PIN) spy cases were added in their own commit (dc143817); each
per-site mutant is now killed. No STOP condition was hit: no unexpected
importer or implementer of `UnitsRepo`, no import cycle, no contract mismatch
with plan section 2, no failing RED/GREEN, no unlisted mutation surface or
reader. `contactTypeGuards.ts` was used as shipped and not edited.

## Per task

| Task | Commit | RED observed | GREEN |
|---|---|---|---|
| 4.1 W3 fixture prep | f3abdd3f | none by ruling S4-11 (CONTRACT ISSUE 11); the PIN baseline before editing: 4 files / 70 passed | same 4 files / 70 passed; `tsc -p tsconfig.test.json` 0; eslint 0 |
| 4.2 POST /api/units | 1e07b704 | 6 failed, 2 passed (8): the 404 case `expected 201 to be 404`, the five 409 cases `expected 201 to be 409`; both PINs passed | unitsLandlordOfRecord, unitsApi, unitsApiOrgNames, unitsApiRoster: 4 files / 74 |
| 4.3 PATCH changed landlordId | 36d9ffcf | 7 failed, 12 passed (19): missing contact `expected 200 to be 404`, five `expected 200 to be 409`, empty id `expected 200 to be 404`; the 4 PATCH PINs and the 8 POST cases passed | unitsLandlordOfRecord, unitsApi, unitsApiOrgNames, unitsApiPhotos, unitsApiActivity: 5 files / 121 |
| 4.4 contact list I4 + claim I3 | a63927eb | 10 failed, 6 passed (16): roles pm / owner / other `expected 200 to be 409`; role landlord on an OWNED unit got the `landlord_reassignment_required` body; the order case, the four `landlord_not_landlord` cases and the SEATED-caseworker case `expected 200 to be 409`; 6 PINs passed | unitsApiRosterTypeChecks, unitsApiRoster, unitsApiActivity: 3 files / 52 |
| 4.5 restoreWithLandlord (+ C2) | 74c0d07a | 9 failed (9), ran against DynamoDB Local (not skipped): every case `restoreWithLandlord is not a function` (the unknown-unit case too: the rejection was that TypeError); the C2 case the same | unitsRepoRestoreWithLandlord.integration, unitsRepoRoster.integration, unitsSoftDelete: 3 files / 30; `npm run typecheck` 0 |
| 4.6 restore route | a16aa28c | 8 failed, 5 passed (13): both `restore_needs_landlord` cases `expected 200 to be 409`; the 400 case `42: expected 200 to be 400`; the swap `expected 'c-old' to be 'c-new'`; `landlord_not_landlord` 200 vs 409; `landlord_not_found` 200 vs 404; `unit_roster_conflict` 200 vs 409; restore-ownerless `expected true to be false` (landlordId still present); 5 PINs passed | unitsRestoreLandlord, unitsSoftDelete, unitsApiActivity: 3 files / 28; `npm run typecheck` 0 |
| gap pins (extra) | dc143817 | (PIN) cases, green on unchanged code (3 files / 51); see the mutant check, M12 | each per-site mutant M12a-e killed by exactly one of them |

Before each commit: eslint on the task's files (0), C1 ASCII checks (0),
and `tsc` for the app (`tsconfig.json` and/or `tsconfig.test.json`, 0) or
the full `npm run typecheck` (Tasks 4.5, 4.6).

Where the code landed (`app/src/routes/units.ts` unless noted):
- imports `:80` (`requireLandlordContact`, `sendContactTypeError`) and `:81`
  (`isCaseworker`, from the leaf `lib/caseworkers.js` - no cycle).
- create check `:499` (after the 400 at `:468-470` and the org-list 422;
  before `units.create`).
- PATCH: the consistent "changed" unit read `:1489`, the empty-id 404 `:1496`,
  the contact check `:1500` (after the 400s and the org-list 422; before the
  media snapshot and `units.update`).
- contact-list add: consistent unit read `:1107`, consistent contact read
  `:1116`, I4 seat check `:1131-1135`, I3 claim check `:1137-1143`, both
  before `units.addContact`.
- restore route `:1587`: body validation 400 `:1611`, consistent unit read
  `:1615`, consistent landlord read `:1625`, plain path `:1632`, 409
  `restore_needs_landlord` `:1652`, chosen-landlord check `:1662`,
  `restoreWithLandlord` call `:1678`, audit `:1693-1694`, enriched response
  `:1702`.
- `app/src/repos/unitsRepo.ts`: interface method `:496`, implementation
  `:1103` (the retry bound `:1167`; the conditioned write is the existing
  `updateRosterIfCurrent` `:546`).
- `app/test/helpers/twilioWebhookHarness.ts`: import `:120`, the fake `:3099`.

## Orchestrator corrections

- C1: every ASCII check ran from the worktree with an explicit `cd`, a
  `test -f || echo MISSING` per file, `tr` over each new file and
  `git diff -U0 19607658 -- <edited files> | grep '^+'` over the edited files,
  in each task and at the gate. All printed 0; no MISSING line. Commit
  messages 2dd668f8..HEAD also 0.
- C2 (RD-1, ruling S4-4): one case in
  `app/test/unitsRepoRestoreWithLandlord.integration.test.ts:228` pins the
  3-attempt bound. Every attempt loses a REAL contacts-only race (a raw write
  of `contacts[]` lands between the attempt's read and its conditional
  write); the call throws `RosterWriteConflictError` after exactly 3 writes,
  and the stored unit is untouched by it (still deleted, still `c-old`'s,
  `primary_contact` `c-old`, roster = the racer's last write). The racer stops
  after 5 races so a loop with no bound wins attempt 6 and fails fast instead
  of hanging. Mutants (applied and reverted with the Edit tool, sha256 OK):
  bound removed -> the C2 case alone red (`promise resolved ... instead of
  rejecting`); bound 2 -> the C2 case alone red (`expected 2 to be 3`).

## W3 - every fixture fixed (the rule was never weakened)

Exactly the plan's sweep table; nothing else needed a fix.
- `app/test/unitsApi.test.ts`: `landlordHarness()` `:43` seeds
  `contact-ll-1`, `contact-ll-9`, `contact-ll-reg` typed `landlord`; all 27
  `makeWebhookHarness();` call sites now use it.
- `app/test/unitsApiOrgNames.test.ts`: `seedLandlord(world)` `:33`, called in
  the two 201 tests.
- `app/test/unitsApiRoster.test.ts:466-467`: `c-ll-prop` and `c-ll-other`
  seeded (the file's `seedContact` defaults to `landlord`).
- `app/test/unitsSoftDelete.test.ts:56`: `contact-ll-1` seeded as `landlord`
  for the restore test.

## Typed UnitsRepo fakes

- Extended: `app/test/helpers/twilioWebhookHarness.ts:3099` (the only typed
  fake; it mirrors the real method line for line, with `unitsRepo.ts:1103`).
- Checked, nothing needed: `app/test/placementNudges.test.ts:176` is an
  `as unknown as UnitsRepo` cast; `caseworkerRepoParity.integration.test.ts`,
  `orgRecordWriters.integration.test.ts` and the other integration suites
  build the real repo. A repo-wide grep found no other implementer;
  `npm run typecheck` (all five workspaces) is 0.

## Divergences from the plan

- Code and the plan's tests: none. Every old_string matched exactly once and
  every new_string is the plan's text.
- Task 4.5 Step 2: `npm run db:start` was NOT run. The container was already
  up (`docker ps`: `hc-dynamodb-local` Up 19 hours; `:8000` answered), and
  `db:start` on a running container prunes old database files and recreates
  a container it finds with stale args - not needed, so not risked. Both
  integration files ran against it (9 + 17 tests, no SKIPPED line).
- Task 4.5's commit carries one extra body paragraph naming C2; the subject is
  the plan's.
- C2's form: a genuine contacts-only race per attempt instead of
  `unitsRepoRoster.integration.test.ts:217-233`'s thrown
  `ConditionalCheckFailedException`; same assertion shape (exact write count
  plus the error), plus a nothing-written check. It proves the real DynamoDB
  condition loses each time.
- Extra commit dc143817 (three (PIN) spy cases,
  `unitsLandlordOfRecord.test.ts:161`, `unitsApiRosterTypeChecks.test.ts:111`,
  `unitsRestoreLandlord.test.ts:70`): a test gap found by my extra mutant
  M12, closed in its own commit as the brief asks for an unkilled mutant.
  Test-only.
- Gate form: each run redirected to `.superpowers/sdd/logs/s4a-*.log` and
  echoed `$?` (never a pipe). The gate was run at a16aa28c (205 passed) and
  re-run at dc143817 (208 passed); the numbers below are the final run.
- The brief said the worktree checks files out CRLF; `.gitattributes` forces
  `eol=lf` and the files are LF. New files were written LF. No effect.
- No good divergence found (nowhere was the live code better than the plan).

## Half-slice gate (bare commands, from the worktree, at dc143817)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app vitest, the plan line 12587 command exactly (11 files) | 0 | 11 files, 208 passed, 0 skipped; `unitsRepoRestoreWithLandlord.integration` 9 and `unitsRepoRoster.integration` 17 ran against DynamoDB Local |
| 2 | `npm run typecheck` | 0 | all five workspaces (app incl. scripts and tests) |
| 3 | `npx eslint` on the 11 `app/...` paths of plan line 12614 | 0 | no output; `--print-config` on `units.ts`: 47 rules, `@typescript-eslint/no-unused-vars` at error |
| 4 | ASCII (C1) | - | 4 new files: 0 each, no MISSING; 7 edited files, added lines vs 19607658: 0 |
| 5 | coverage: `git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx'` | 0 | 74 paths, every one in the S1 (plan line 3253 + aiRunVerdicts.test.ts), S2 (5558), S3 (9188) or S4 (12614) list |

Lint: clean, so no attribution run was needed; there is no pre-existing
error to name in these files. The dashboard paths of the S4 lint list belong
to the dashboard half's gate.

DynamoDB Local: no `[dynamoAdmin]` line and no SKIPPED line in any of this
half-slice's 62 run logs (tasks, gate, mutants). The container was not
started, restarted or stopped. No `AWS_*` variable was exported in the shell.

## Mutant check

Each mutant was applied and reverted with the Edit tool; the sha256 of the
three mutable files (`units.ts`, `unitsRepo.ts`, `twilioWebhookHarness.ts`)
was checked against a pre-mutant baseline after every revert (all OK). Every
mutant ran the full 11-file gate list. After the last revert `git status` was
clean and `git diff --stat` empty, and a post-revert gate run was green.

| Mutant | Where | Tests that went red (of 205; 208 for M12a-e) |
|---|---|---|
| M1 create skips the landlord check | `units.ts:499` commented out | 6, `unitsLandlordOfRecord.test.ts` POST: the 404 and the five 409s |
| M2 PATCH checks only an UNCHANGED landlordId | `units.ts:1494` `!==` -> `===` | 8, `unitsLandlordOfRecord.test.ts` PATCH: the missing-contact 404, five 409s, the empty-id 404, and the UNCHANGED PIN (the skip-entirely variant is the Task 4.3 RED: 7 red) |
| M3 claim check before the caseworker check | the two blocks at `units.ts:1131-1143` swapped | 1, `the caseworker refusal comes before the landlord-claim refusal on a vacant slot` |
| M4 seated caseworker refused too | `units.ts:1132` drops `!seated &&` | 2, the seated-caseworker PIN (`expected 409 to be 200`) and `a SEATED caseworker re-roled to landlord ...` (got `contact_list_caseworker`) |
| M5 re-asserting the owner is checked | `units.ts:1137` claim also when `unit.landlordId === contactId` | 1, the re-assert PIN |
| M6 restore write without the landlordId condition | `updateRosterIfCurrent` (`unitsRepo.ts:572-579`) skips the landlordId clause for the restore patch only (other roster writes untouched) | 1, integration `a landlordId changed between the read and the write is a conflict` (`promise resolved ... instead of rejecting`) |
| M7 real repo keeps the old landlord's row | `unitsRepo.ts:1128-1129` -> the unfiltered roster | 5, integration: swap, keep-seated, clear, legacy clear, contacts-only race |
| M8 real repo leaves primary_contact at the old landlord | `unitsRepo.ts:1159` commented out | 1, integration `clears the landlord: ... primary_contact removed` |
| M8f (extra) the same in the fake | `twilioWebhookHarness.ts:3136` commented out | 1, route `restores ownerless: ... primary cleared` |
| M9 fake keeps the old landlord's row | `twilioWebhookHarness.ts:3112-3113` -> the unfiltered roster | 2, route `restores with the chosen landlord` and `restores ownerless` |
| M10 body honored when the plain restore would not refuse | `units.ts:1632` `!needsLandlord` -> `!needsLandlord && !choosesLandlord` | 2, route PINs `a property that is not deleted restores as before` and `a body is ignored when the stored landlord is still valid` |
| M11 the type comparison dropped | `units.ts:1626` `current === undefined \|\| current.type !== 'landlord'` -> `current === undefined` | 5, route: `restore_needs_landlord` with the name, the swap, `landlord_not_landlord`, `landlord_not_found`, `unit_roster_conflict` (all now plain 200s); the missing-contact 409 case still passes, by design (a missing contact is the other half of that condition) |
| M11b plain restore never checks | `units.ts:1632` -> `!needsLandlord \|\| !choosesLandlord` | 2, both `restore_needs_landlord` cases |
| M12 (extra) all five S4 route reads without `consistentRead` | `units.ts:1107,1116,1489,1615,1625` | 0 - SURVIVED: test gap, closed by dc143817 |
| M12a-e (after dc143817) one site each | the same five lines, one at a time | 1 each: `:1489` -> `decides "changed" from a CONSISTENT unit read`; `:1107` and `:1116` -> `decides from CONSISTENT reads of the unit and the contact`; `:1615` and `:1625` -> `reads the unit and its landlord of record CONSISTENTLY` |

All of M1-M11 were killed by the plan's tests, so no gap test was needed for
them.

## Surprising, or sub-threshold worries

- FakeWorld's `unitsRepo.getById` and `contactsRepo.getById` ignore
  `consistentRead`, so nothing in the plan's S4 tests could see the binding
  "every new contact read is consistent" at the route (M12 survived). Pinned
  now by spies; the guard's own read is pinned in
  `contactTypeGuards.test.ts:87`.
- The two restore success shapes differ: the plain path answers the RAW
  stored unit (as before; `contacts` only if stored, never enriched), the
  body path the enriched roster (CONTRACT ISSUE 9). A body-carrying request
  whose stored landlord became valid in between is answered on the plain
  path (body ignored), so a client cannot assume an enriched roster on every
  200. Recorded in the HANDOFF.
- `units.addContact` re-reads the unit EVENTUALLY consistently
  (`unitsRepo.ts:782`) after the route's consistent reads; its conditional
  write still guards landlordId and `contacts[]`, so a stale repo read can
  only end in `landlord_reassignment_required` / a retry, never a wrong
  claim. The residual window is CONTRACT ISSUE 1 (L1 class), as ruled.
- The plain restore stays unconditioned (CONTRACT ISSUE 2, ruled): between
  the type read (`:1625`) and `units.restore`, only another type-checked
  writer (or the out-of-scope importer) can change landlordId.
- Already recorded by the research and unchanged here: `landlordName` is
  first + last only (RD-2); the nested `landlordReplaced` / `landlordCleared`
  audit fields render as a plain restore row in Activity (RD-4); a changed
  landlordId by API PATCH leaves the old landlord's contact-list row (RF2-N2,
  filed in S5); `primary_contact` stays writable on create/PATCH unchecked
  (`unit-primary-contact-unchecked`, S5).
- `landlordId: null` on PATCH is a 400 (`unitFields.ts` kind `string`), so
  PATCH cannot make a property ownerless; restore-without-a-landlord is the
  only new path to an ownerless property (as the spec intends).

## HANDOFF for the dashboard implementer (Tasks 4.7-4.13)

Every error body is exactly `{ "error": "<code>" }` unless a key is named.

POST `/api/units/:unitId/restore`
- Request: no body, or a body WITHOUT a `landlordId` key = the plain restore.
  `{ "landlordId": "<contactId>" }` = restore with that landlord;
  `{ "landlordId": null }` = restore without a landlord. (So
  `restoreUnit(unitId)` must keep sending no body, and the dialog sends one of
  the two bodies.)
- 400 `{ "error": "landlordId must be a contact id or null" }`: the key is
  present and the value is neither a non-empty string nor null. Checked
  before any read; nothing written.
- 404 `{ "error": "unit_not_found" }`: unknown unit (also if it vanishes
  before the write).
- Plain path, 200 `{ "unit": <raw stored unit> }` (exactly as before): the
  unit is NOT soft-deleted (no check at all, a body is ignored); or it is
  deleted and ownerless; or its `landlordId` names a contact typed
  `landlord` (a body is ignored).
- 409 `{ "error": "restore_needs_landlord", "landlordName"?: string }`: the
  unit is deleted and its landlord contact is missing or not typed
  `landlord`, and no `landlordId` key was sent. `landlordName` is the stored
  contact's first + last name when it exists and has one; the key is absent
  for a missing or nameless contact. Nothing written.
- Body path (honored only when the plain restore would answer
  `restore_needs_landlord`):
  - `{ landlordId: "<id>" }`: 404 `landlord_not_found` / 409
    `landlord_not_landlord` (consistent read; nothing written); otherwise 200
    `{ "unit": { ...unit, "contacts": <enriched roster> } }` - restored,
    `landlordId` = the chosen contact, the old landlord's row removed, the
    chosen contact's row role `landlord` (kept if already seated), and when
    the old landlord was the primary the chosen contact becomes the sole
    primary (`primary_contact` too).
  - `{ landlordId: null }`: 200 `{ "unit": { ...unit, "contacts": <enriched
    roster> } }` with NO `landlordId` key, the old landlord's row removed,
    and `primary_contact` removed (no row primary) when it pointed at the old
    landlord.
  - 409 `unit_roster_conflict`: the stored landlordId changed under the
    request (or three contacts-only races in a row). Nothing written; re-read
    the property.
- The enriched roster is the roster routes' shape (rows with read-time
  `name` / `company`), so `applyRosterUnit` can take it; a plain-path 200 is
  the raw unit and should be handled like today's restore answer.
- Audit (Activity): `unit_restored` gains `landlordReplaced { from, to }` or
  `landlordCleared { from }` on the body path only.

POST `/api/units/:unitId/contacts` - answers in this order:
1. 400s (body, `contactId`, `role`, `primaryContact`) - unchanged.
2. 404 `unit_not_found`, then 404 `contact_not_found` - unchanged codes (both
   reads now consistent).
3. 409 `contact_list_caseworker` - a caseworker (a `partner` whose role is a
   caseworker role) who is NOT already on the property's contact list, any
   role. A caseworker already seated can still be re-roled / made primary /
   removed.
4. 409 `landlord_not_landlord` - role `landlord` on a property with NO
   landlord of record (the vacant-slot claim) by a contact not typed
   `landlord`. Re-asserting the existing owner is never checked.
5. The repo's answers, unchanged: 409 `landlord_reassignment_required`
   (role `landlord` on a property owned by someone else), 409
   `unit_roster_conflict`, 404 `unit_not_found`.

POST `/api/units` (UnitCreateForm): after the 400s and the org-list 422,
404 `landlord_not_found` / 409 `landlord_not_landlord`; nothing created on a
refusal.

PATCH `/api/units/:unitId` with a CHANGED `landlordId`: after the 400s and
the org-list 422 (and 404 `unit_not_found`), 404 `landlord_not_found` (an
empty string included) / 409 `landlord_not_landlord`; nothing written. An
unchanged `landlordId` is not checked. No dashboard screen sends
`landlordId` on a PATCH today.

The S3 helper `contactTypeErrorMessage` already maps `landlord_not_found`,
`landlord_not_landlord` and `contact_list_caseworker`;
`restore_needs_landlord` is the dialog's trigger, not a sentence.
