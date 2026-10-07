# U8 report - Task 0 (ruling B-3) + S8, S9, S10 (Tasks 8.1-10.1)

- Implementer: U8 (Opus 5.5), 2026-10-06/07, worktree W:/tmp/clean-org-names,
  branch feat/clean-org-names. Six commits, tree clean after the last.
- Stopped after Task 10.1 as dispatched: the S10 checkpoint (`npm test`) was
  NOT run - it is the orchestrator's.
- DynamoDB Local was already up (hc-dynamodb-local, Up 10 hours); not touched.

## Task 0 - ruling B-3 (refines RG-2 4f7be1ef)

- Commit dfd313a5 `fix(org-names): a dismissed shared spelling does not suppress one entry's full name`
- Code (app/src/services/extraction/apply.ts, housingAuthority match branch):
  `alsoDismissedAs = [String(coerced.value), ...ownSpellings]`, where
  `ownSpellings` keeps a spelling only when
  `resolveOrgText(ctx.orgEntries, s, KINDS_FOR_FIELD.housingAuthority)` is
  `match` and its `entry.orgId === matched.orgId` (orgId compare; the entries
  come from the same array, so identity would also work). The RG-2 comment now
  states the B-3 rule and why (AHA: Atlanta + Augusta; MHA: Marietta +
  Macon-Bibb; every old alias spelling resolves to one entry, so RG-2's
  pre-deploy dismissals still hold; the model's own text always counts).
- RED: new case "a dismissal of a SHARED spelling does not suppress one
  entry's full name (worklist B-3)" - `expected [] to deeply equal [ 'housingAuthority' ]`
  (dismissal keyed `normalizeSuggestionValue('housingAuthority', 'AHA')`,
  model suggests "Augusta Housing Authority"). PIN "(PIN) a dismissal of a
  spelling unique to the entry still suppresses its full name (worklist B-3)"
  ('Atlanta (AHA)' vs "Atlanta Housing Authority") green before and after.
- GREEN: test/extractionApply.test.ts 96/96 (exit 0).
- Fast gates: `npm run typecheck` exit 0; fallout extractionJob,
  extractionJobDraftGuard, contactStaffNotes 108/108 (exit 0).
- Divergences (comment-only, same intent): also updated the
  `putSuggestionSafe` comment and the RG-2 describe header comment in the test
  file, which both said "every spelling" and would have been stale. The PIN's
  input equals RG-2 case 1's; kept as the dispatch asked, framed as B-3's
  boundary (a spelling holding the shared token AHA but resolving to Atlanta
  alone stays a key).
- Observation for the handback (intended by B-3, no action): the old alias map
  had no bare `aha` key, so before the deploy a model's bare "AHA" was
  suggested verbatim; a staff dismissal of it (key "aha") still suppresses a
  later ambiguous "AHA" suggestion, but no longer an unambiguous "Atlanta
  Housing Authority" or "Augusta Housing Authority" (same for "MHA").

## Task 8.1 - contact side

- Commit 2a608fd7 `feat(import): resolve contact housing authority against the org list - fill-only, agencies to agency (D9)`
- RED: 6 failed - importOrgNames x4 (`expected 'SET #type = ...' to contain
  'housingAuthority = if_not_exists(...)'`, `... to contain '#agency =
  if_not_exists(...)'`, `orgNotWritten` undefined, `expected 'Hope Atlanta' to
  be 'Test Hope Housing Board'`); importApply.integration x2
  (`resolveImportedAuthority is not a function`, re-import overwrote the staff
  value: `expected 'Atlanta (AHA)' to be 'DeKalb County Housing Authority'`).
- GREEN: importOrgNames + importApply.integration + importGroupAttribution +
  importGroupGuards 66/66 (exit 0). `npm run typecheck` exit 0.
- Divergences: none (all eleven apply.ts edits and the test edits verbatim).

## Task 8.2 - unit side; the alias map leaves the importer

- Commit 1f8ef36c `feat(import): only resolved housing authority names on a property; the alias map leaves the importer (D9)`
- RED: 6 failed - unit write `expected [ 'Atlanta (AHA)' ] to deeply equal
  [ 'Atlanta Housing Authority' ]` (stub and integration), the three it.each
  cells (`expected 'SET ...' not to contain 'accepted_authorities'`), the
  source check (`... not to contain 'housingAuthority.js'`).
- GREEN: importOrgNames, importApply.integration, importGroupAttribution,
  importGroupGuards, extractionSchema 108/108 (exit 0). typecheck exit 0.
- Named fallout applied: extractionSchema.test.ts:16 still read the pre-S8
  path, so it was re-pointed at `../src/lib/housingAuthority.js` (plan's
  conditional). The two node imports went at the top of the import block.
- Divergences: none.

## Task 8.3 - the CLI peeks the list and prints what was not written

- Commit cc57e315 `feat(import): import:apply reads the org list without creating it and reports names not written (D9)`
- RED: `expected -1 to be greater than -1` (no `peek()` in the CLI).
- GREEN: importOrgNames + importGroupAttribution 23/23 (exit 0); typecheck
  exit 0 (app typecheck includes tsconfig.scripts.json, so app/scripts is
  covered).
- Divergence (mechanical): plan edits 1 (the `randomUUID` import) and 4 (the
  header paragraph) touch adjacent lines, so they went in one Edit call; the
  result is byte-identical to applying them separately.

## Task 9.1 - agency is an intake fact (D15)

- Commit 03cf52b8 `feat(intake): an agency marks a missed caller as known (D15)`
- RED app: 2 failed - new gate case `expected [ { to: '+15550177777', ... } ]
  to have a length of +0 but got 1`; "any single fact present - skip"
  `expected true to be false` (on agency). The two PIN lines (agency '' and
  '   ') were green. RED dashboard: `Unable to find an element with the text:
  /voucher size, housing authority,\s*or agency saved/i`.
- GREEN: app missedCallAutoText 19/19 (exit 0); dashboard TemplatesSection
  9/9 (exit 0). No type change; typecheck ran green at 10.1.
- No other pin of the hint text or INTAKE_FIELDS exists (git grep over app,
  dashboard, e2e).
- Divergences: none. (The issue doc gained no `updated:` line - the plan does
  not ask and the field is optional per docs/issues/README.md.)

## Task 10.1 - retire the hand-kept lists; the permanent guard

- Commit f97b9fd3 `refactor(org-names): retire the app's hand-kept authority lists`
  (includes the `git rm` of app/src/lib/housingAuthority.ts).
- RD-2: `git grep -n housingAuthorityFor -- app/test/importApply.integration.test.ts`
  printed nothing (exit 1) - items 3 and 5 were no-ops (S8 did them; item 3's
  doc comment was already Task 8.1's text).
- RD-1: app/test/orgStartingList.test.ts:96 says "The retired alias map ..."
  with no module path; the guard never listed the file. No edit.
- RED: 3/3 failed (module exists; schema exports HOUSING_AUTHORITY_VOCAB; the
  scan listed 12 offenders in exactly the four expected files:
  src/lib/housingAuthority.ts, src/services/extraction/schema.ts,
  test/extractionSchema.test.ts, test/importOrgNames.test.ts).
- GREEN: item 1 (git rm), item 2 (schema constant + doc comment; one blank
  line left), item 4 (schema test: the import name, the re-pointed import
  line, the HOUSING_AUTHORITY_VOCAB describe; the `:437-440` prompt-vocabulary
  test was already gone after S7), item 4b (S8's one-file source check; the
  readFileSync/join imports stay for the CLI check), item 7 (dashboard
  comment). Item 6: no other offender after the re-run.
- Runs: app orgListsRetired, extractionSchema, extractionApply,
  importApply.integration, importOrgNames 176/176 (exit 0); dashboard
  ContactEditForm 41/41 (exit 0); `npm run typecheck` exit 0;
  `git grep --untracked ... -- app dashboard/src` hits only
  app/test/orgListsRetired.test.ts and dashboard/src/routes/contact/orgVocabulary.ts:2.
  A wider sweep for the module path (whole repo minus docs/*.md) hits only the
  guard's own header (skipped as SELF).
- Divergences: none.

## Out of scope noticed (owned by later slices per the plan)

- RUNBOOK.md:1292,1298 still describe lib/housingAuthority.ts and
  CANONICAL_AUTHORITY (S15, ruling F8).
- documentation/GLOSSARY.md:281 names CANONICAL_AUTHORITY in
  app/src/lib/import/apply.ts (S16).
- docs/issues/housing-authority-free-text-drift.md:36-183,
  docs/issues/import-display-name-unread.md:98-103,
  docs/issues/retire-humanize-authority.md:36 name the retired identifiers
  (S16 / historical text).
- dashboard/src/routes/contact/orgVocabulary.ts:2 (S11 deletes it).

## Gate-5 note

Files this unit touched that carry pre-existing lint errors at the merge base
(from the worklist's baseline additions): app/test/extractionApply.test.ts:5
no-unused-vars `beforeEach`. Nothing new added by U8 was linted here (the
orchestrator runs gate 5 at S17).
