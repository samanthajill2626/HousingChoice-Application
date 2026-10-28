# S4 slice report - Notes lines (WP1 B1)

Slice S4 (plan section 8, tasks S4.1-S4.8; spec rev 10 D4 and its spec 4/5
lines). Implementer: Claude Opus 5.5. Branch head at start 8b89e49b (S3
closed); main @d0e2c2d8 (unchanged during the slice; merge base d0e2c2d8).
Findings only; code cited by `file:line` at the S4 head.

## Commits

| Task | Commit | Subject |
|---|---|---|
| S4.1 | 0a6434a4 | feat(config): EXTRACTION_FACT_MIN_CONFIDENCE, default 0.7, fail-fast 0 < x <= 1 (B1 S4.1) |
| S4.2 | a7681f99 | feat(extraction): filterNoteLines, the one place for Notes line value rules (B1 S4.2) |
| S4.3 | 9b0105a1 | feat(extraction): noteLines are { text, confidence }, appended through filterNoteLines (B1 S4.3) |
| S4.4 | 601ea533 | feat(extraction): the run record carries notesBelowFloor and notesDemoted (B1 S4.4) |
| S4.5 | f91f8f24 | feat(dashboard): the AI run detail shows the Notes line counts (B1 S4.5) |
| S4.6 | cdea1112 | feat(extraction): noteLines widened to matching facts, with confidence and the never-written list (B1 S4.6) |
| S4.7 | 32a868ee | test(e2e): extraction payloads send noteLines as { text, confidence } (B1 S4.7) |
| (S4 follow-up) | adf7f055 | docs(extraction): cite the fake driver's marker merge, not a line S4.7 moved (B1 S4) |
| S4.8 | (this report) | docs(records): B1 S4 slice report |

## What the tree held that the plan got wrong

- Nothing beyond what the WORKLIST already corrected (WL-12 .. WL-16,
  applied below). Every quoted anchor matched verbatim and uniquely on the
  first Edit; no G4 event. The S3 rewrites composed with every S4 anchor, as
  D4 said.
- Line hints drifted with S1-S3 (the quoted text was the authority), at the
  S3 head: apply.ts MAX consts :80-81 (plan :74-75), `autoPrefix` :189-193
  (plan :144-149), ApplyDeps :40-50 (plan :34-44), section 8 :775-813 (plan
  :713-751; :883-921 once S4.2 inserted filterNoteLines above it), the
  return :820 (plan :758); schema.ts noteLines schema
  :117-120 (plan :124-127), constants :160-162 (plan :167-169), parser
  :261-267 (plan :268-274); extractionSchema.test.ts :93 / :125-137 / :148
  were :134 / :166-178 / :189 (extractionApply.test.ts sat at its hints:
  S3 only appended to it); jobs/extraction.ts RunDraft :336-337 (plan
  :322-323), after apply :643 (plan :629), recordRun :685-686 (plan
  :671-673); dashboard types.ts AiRunRecordView :380-382 (plan :372-374);
  AiRunDetail.tsx rawText line :91 (plan :87); prompt.ts noteLines bullet
  :131-135 (plan :107-111); ai-run-log.spec.ts `noteLines: []` :182 (plan
  :177). config.ts and the e2e / fake-driver anchors sat at their hints.
- S4.3 Step 2's RED reason for the rewritten Layer-3 case: the plan says it
  "still appends"; observed, it fails earlier with `line.trim is not a
  function` because its migrated fixture is now an object item that the old
  section 8 trims. Red for the stated family of reasons (the old apply cannot
  read the new shape); green after Step 3.
- S4.7's seven header lines moved the fake driver's marker merge
  (`result: { fields: {}, ...partial }`) from extractionFake.ts:103 to :110.
  The plan's two new S4.2 comments cited `:103`; see divergence 2.

## Divergences (each deliberate)

1. WORKLIST items, verbatim: WL-12 (the third item of 'clamps confidence to
   0..1 and reads a non-number as 0' is `{ text: 'missing' }`,
   app/test/extractionNoteLines.test.ts:27); WL-13 (the WI4 grep form, below);
   WL-14 (D4-S4-3's block, prompt.ts:131-149, plus the test line
   `animal are allowed. This is the never-written list.` in
   extractionSchema.test.ts 'states the never-written list ...'); WL-15 (the
   row `{run.notesDemoted} withheld by the unknown-speaker rule`,
   AiRunDetail.tsx:73, and test 1's `'0 withheld by the unknown-speaker
   rule'`); WL-16 (escape check, below); WL-17 (recorded under WI14).
2. Commit adf7f055 (outside the plan's list, comment-only): the two new
   comments that cited `adapters/extractionFake.ts:103`
   (apply.ts:212-217 NoteLineFilterInput.modelLines, and the header of
   app/test/extractionNoteLines.test.ts:4) now name "the marker merge"
   instead of a line number S4.7 had just made stale. Kept OUT of the S4.7
   commit so S4.7 stays e2e-specs-plus-fake-comment only, as dispatched. No
   later slice anchors on that text (plan grep for `extractionFake.ts:103`
   finds only prose and these two comment lines).
3. MERGE_HEAD check: the brief's
   `test -e "$(git -C ... rev-parse --git-path MERGE_HEAD)"` form (it
   resolves to the absolute worktree git path) printed `none` before every
   commit, instead of the plan's `ls`.
4. Typecheck cadence per the brief: bare root `npm run typecheck` after
   S4.1, S4.2, S4.3, S4.4, S4.5 and at S4.8, plus the plan's app (S4.3),
   dashboard (S4.5) and e2e (S4.7) workspace typechecks. S4.6 changes prompt
   strings only (no type), so it ran tests only until the S4.8 root run.
5. Commit bodies of S4.2, S4.5 and S4.6 carry one extra line naming the
   WORKLIST item they apply.
6. S4.7 also ran app/test/tenantMatchingInputsReaders.test.ts (it reads
   extractionFake.ts as a "reader" file) and extractionAdapter.test.ts after
   the header edit: green. PR14 waives a unit RED for S4.7; nothing else was
   run there and no e2e was run.
7. S4.8 lint ran every `.ts`/`.tsx` file S4 touched (23 files, from
   `git diff --name-only --diff-filter=d 8b89e49b..HEAD`), not the plan's 12;
   the dashboard step ran the whole dashboard workspace (allowed by the
   brief; it contains the plan's two paths).

## Contradictions C1-C7 (plan section 8), as built

- C1: the retry guard covers model AND system lines before the cap
  (apply.ts:278-279 `alreadyPresent`, applied to model lines at :292 and to
  system lines at :297, both before the cap at :299); case 'the guard also
  drops a bare line already in the notes - model or system (spec D4 C1)'.
- C2: a "Notes lines" `section` region (`NotesLines`,
  AiRunDetail.tsx:61-75), rendered just above the raw model response
  (:107); appended / below the floor / withheld rows.
- C3: `notesDemoted` is `append.length` after floor, postal filter, guard and
  cap (apply.ts:300); `belowFloor` is still counted on a demoted run. Both
  optional on AiRunRecord (aiRunsRepo.ts:66-73) and RunDraft
  (jobs/extraction.ts:338-341), set once apply ran
  (jobs/extraction.ts:648-649, spread at :693-694). PIN: a skipped run
  carries neither key.
- C4: the parser keeps up to `MAX_PARSED_NOTE_LINES = 20` structurally valid
  `{ text: string, confidence: number }` items, unmodified (schema.ts:173,
  :272-284); the 200-char clamp (`MAX_NOTE_CHARS`, apply.ts:96) and the
  five-line cap (`MAX_NOTE_LINES`, :94) live in filterNoteLines. The schema
  item is an object with both keys required (schema.ts:118-131); the zero
  optional-parameter pin stays green.
- C5: e2e/tests/dashboard-next/ai-run-log.spec.ts:182 `noteLines: []` - no
  edit.
- C6: extractionFake.ts gains header text only (:13-18); its last line is
  `// EXTRACTION_FACT_MIN_CONFIDENCE (default 0.7).`, S6.6's WL-31 anchor.
- C7: the Layer-3 case is rewritten with its reason comment
  (extractionApply.test.ts, 'leaves native suggestions untouched under the
  flag, appends NO note line, and counts it (no demotion audit)').

## Watch items owned by S4

- WI1 (the fake bypass skips no value rule): every rule is in the pure
  exported `filterNoteLines` (apply.ts:275-302), called from section 8
  (:896-903) with `result.noteLines` as received; nothing trusts the parser.
  Proven by extractionNoteLines.test.ts 'drops an item that is not a { text }
  object, never throwing (the fake driver bypasses the parser, WI1)' and
  'clamps confidence to 0..1 and reads a non-number as 0', and
  extractionApply.test.ts 'drops a legacy string item without throwing (only
  the fake driver can deliver one, WI1)'. The fake driver header says so
  (extractionFake.ts:13-18).
- WI4 (every fixture migrated; typecheck green at the end of S4): WL-13's
  grep `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -E "noteLines: \[('|noteLine\])" -- app/test e2e`
  printed exactly 4 lines, all app/test/extractionApply.test.ts (:664, :677
  and :1773 the `.map((text) => note(text))` fixtures; :1800 the legacy
  string case). At S4.3 it also printed the three e2e lines
  (caseworkers.spec.ts:517, conversation-fact-extraction.spec.ts:332, :377),
  which S4.7 migrated. A repo-wide `git grep -l noteLines` outside docs/
  lists 13 files - the five extraction sources, the five app tests and the
  two e2e specs S4 touched, plus ai-run-log.spec.ts (`[]`, C5); the seeds,
  scripts, dashboard and the probe carry none. No string item is left.
  Root `npm run typecheck` exit 0 at S4.8; it includes app
  tsconfig.scripts.json (`include: ["scripts", "src"]`), so the probe
  compiled.
- WI5 (guard before the cap): extractionNoteLines.test.ts 'runs the retry
  guard BEFORE the cap, so a line already present takes no slot (WI5)' and
  extractionApply.test.ts 'a guarded duplicate no longer takes a cap slot
  (WI5)'. Traced: a cap-then-guard order returns bravo..echo (4) and loses
  foxtrot, so both cases fail it.
- WI6 (`hasAiCaseworkerNote` silenced by a dropped or demoted line): the
  rewritten Layer-3 case and its comment (C7) carry the reason (spec Q1).
  Its only reader is services/possibleCaseworkers.ts:82;
  `git diff main...HEAD -- app/test/caseworkers.test.ts app/test/possibleCaseworkers.test.ts`
  is empty and both files ran green at S4.3 Step 4 and in the S4.8 suite.
- WI14 (importer untouched): `git diff --stat main...HEAD -- app/src/lib/import`
  is empty; the importer still REPLACES the Notes box
  (lib/import/apply.ts:1196-1198; docs/issues/import-overwrites-notes-box.md).
  WL-17, same class: the staff edit form also replaces the WHOLE Notes box
  from the copy it opened with - `const [base] = useState(contact)`
  (dashboard/src/routes/contact/ContactEditForm.tsx:189), the `notes` state
  seeded from it (:234) and `if (notes !== str(base.notes)) patch.notes =
  notes;` (:389) (main :183, :228, :379) - so `[Auto - <date>]` lines
  appended while the form was open are erased by its save. No code. Filed:
  docs/issues/contact-edit-form-notes-save-drops-auto-lines.md.
- WI15 (fingerprint changes; the per-message hash does not): both inputs of
  `extractionPromptFingerprint` changed - the schema's noteLines item (S4.3)
  and the prompt text (S4.6) - expected; no test pins a literal (every
  reader computes it). `git diff main...HEAD -- app/src/services/extraction/runWindow.ts`
  is empty, and `renderUtteranceLine` (prompt.ts:217) is byte-identical to
  main (awk-extracted function compared with `cmp`). S5 pins it.

## For S5 (anchors as built)

- Section 8 tail (WL-18): `notedLines = filtered.append.length;` then the two
  comment lines `// The model lines really appended are filtered.append.slice(0,`
  / `// filtered.modelCount) - counted here, after the write landed (S5).`
  (apply.ts:912-914); the five-line return object at :925-929.
- WL-19: the last S4 line in recordRun is the `notesDemoted` spread
  (jobs/extraction.ts:694); in AiRunRecord the `notesDemoted?: number;`
  field (aiRunsRepo.ts:73); in AiRunRecordView the same (types.ts:387).
- WL-15 / WL-20: the built row is exactly
  `{run.notesDemoted !== undefined ? <li>{run.notesDemoted} withheld by the unknown-speaker rule</li> : null}`
  (AiRunDetail.tsx:73), and the NEVER bullet ends
  `'  animal are allowed. This is the never-written list.',` (prompt.ts:149),
  followed by the RECONCILE bullet (:150). S5.5's referent exists.

## Risks and notes

- RUNBOOK.md:1446 still says extraction appends "secondary facts"; spec 4
  lists only RUNBOOK.md:1455-1457 ("never demoted") for S6.7. Flagged for S6;
  not touched here (docs are S6, PR2).
- The run record's `rawResult` now carries up to 20 parsed noteLines with
  unclamped text (the parser no longer cuts to 5 x 200). It stays bounded by
  the driver's `MAX_OUTPUT_TOKENS` (adapters/extraction.ts) on the real path,
  and `rawText` already stores the same bytes; no item-size change of note.
- Order effects, by spec D4: the floor runs before the blank and postal
  checks, so a blank or postal model line below the floor is counted in
  `notesBelowFloor`. `notesDemoted` counts what a demoted run would have
  appended after the guard (PR11), so a demoted retry of an already-applied
  window reports 0.
- The floor relies on the model's self-reported confidence; S6's probe and
  Cameron's gate run are where its calibration is seen.
- The e2e payload migrations (S4.7) are unproven until S7's `npm run e2e`
  (PR14). Each carries confidence 0.9, above the 0.7 default; every such flow
  is an SMS window, so none is demoted.
- Q1's accepted consequence stands: a window with unknown-speaker content
  appends no line, so an AI caseworker note is not written from it
  (docs/issues/voice-extraction-window-demotion-persistence.md carries the
  orchestrator's note).
- Test-log noise in the app suite (simulated `ProvisionedThroughputExceededException`
  in importConvertGroups / groupConvert tests, "boom" in
  backfillMediaContentTypes, the retire-paused-tour-reminders WARN lines) is
  pre-existing; every file passed. 0 `[dynamoAdmin]` lines.

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, each prefixed
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL` (G1); dashboard runs from
`W:/tmp/wp1-b1-ranking-inputs/dashboard`; root typecheck and lint from the
worktree root. Nothing piped; output redirected to
`.superpowers/sdd/s4-*.log` (gitignored). DynamoDB Local was already running
(G3); no AWS_* variable is exported; ANTHROPIC_API_KEY and
AI_EXTRACTION_MODEL are not set (only ANTHROPIC_BASE_URL is, unused).

| Step | Command | Result |
|---|---|---|
| S4.1 RED | `npx vitest run test/configAiExtraction.test.ts` | exit 1, 9 failed / 10 passed: `extractionFactMinConfidence` undefined (2), nothing throws (6), `parseExtractionFactMinConfidence is not a function` (1) - stated reasons |
| S4.1 GREEN | `npx vitest run test/configAiExtraction.test.ts test/configEmail.test.ts test/configEventBridge.test.ts` | exit 0, 3 files / 49 tests |
| S4.1 | `npm run typecheck` (root) | exit 0 |
| S4.2 RED | `npx vitest run test/extractionNoteLines.test.ts` | exit 1, 12 failed / 0: every case "filterNoteLines is not a function" |
| S4.2 GREEN | `npx vitest run test/extractionNoteLines.test.ts test/extractionApply.test.ts` | exit 0, 2 files / 124 tests |
| S4.2 | `npm run typecheck` (root) | exit 0 |
| S4.3 RED | `npx vitest run test/extractionApply.test.ts test/extractionSchema.test.ts test/extractionAdapter.test.ts test/contactStaffNotes.test.ts` | exit 1, 22 failed / 202 passed: 15 `line.trim is not a function` (apply 14 incl. the rewritten Layer-3 case, contactStaffNotes 1), 2 whole-outcome pins lacking the counts, the legacy-string case appended (1 vs 0), schema 4 (round-trip, keeps-20, drops-non-object, schema item); extractionAdapter green (migration) |
| S4.3 GREEN | the four plus extractionNoteLines, extractionJob, extractionJobDraftGuard, caseworkers, possibleCaseworkers | exit 0, 9 files / 421 tests |
| S4.3 | `npm run typecheck` (app; then root) | exit 0; exit 0 |
| S4.3 WI4 | WL-13 grep | 4 app/test lines + 3 e2e lines (expected before S4.7) |
| S4.4 RED | `npx vitest run test/extractionJob.test.ts` | exit 1, 2 failed / 92 passed: the record lacks `notesBelowFloor` / `notesDemoted` only (outcome and notedLines matched); PIN green |
| S4.4 GREEN | `npx vitest run test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts test/aiRunsRepo.test.ts test/aiRunsApi.test.ts` | exit 0, 4 files / 165 tests |
| S4.4 WL-16 | `git -C ... grep -n -F "'\uffff'" -- app/src/repos/aiRunsRepo.ts` | prints `:132 const SORT_KEY_CEILING = '\uffff';` (escape survived) |
| S4.4 | `npm run typecheck` (root) | exit 0 |
| S4.5 RED | `npx vitest run src/routes/settings/aiRuns/AiRunsSection.test.tsx` | exit 1, 3 failed / 33 passed: no region "Notes lines" (stated reason); PIN green |
| S4.5 GREEN | same; `npm run typecheck` (dashboard); root | exit 0, 1 file / 36 tests; exit 0; exit 0 |
| S4.6 RED | `npx vitest run test/extractionSchema.test.ts` | exit 1, 3 failed / 50 passed: widen, item, never-written list absent; the verbatim-rules PIN green |
| S4.6 GREEN | `npx vitest run test/extractionSchema.test.ts test/caseworkers.test.ts` | exit 0, 2 files / 133 tests |
| S4.7 check | `npm run typecheck` (e2e); WL-13 grep | exit 0; exactly the 4 extractionApply.test.ts lines |
| S4.7 extra | `npx vitest run test/tenantMatchingInputsReaders.test.ts test/extractionAdapter.test.ts` | exit 0, 2 files / 33 tests |
| follow-up | `npx vitest run test/extractionNoteLines.test.ts test/extractionApply.test.ts` | exit 0, 2 files / 130 tests |
| S4.8 step 1 | `npm run typecheck` (root, bare) | exit 0, 0 `error TS` |
| S4.8 step 2 app | `npx vitest run` | exit 0, 540 files / 11521 passed, 1 skipped (S3 close 539 / 11485 + 1; +1 file, +36 tests = S4.1 9, S4.2 12, S4.3 8, S4.4 3, S4.6 4); 0 `[dynamoAdmin]` lines |
| S4.8 step 2 dashboard | `npx vitest run` | exit 0, 272 files / 5623 passed (S3 close 5619; +4, S4.5) |
| S4.8 step 3 | added lines of `git diff -U0 main...HEAD -- app/src app/test dashboard/src e2e/tests` and of `8b89e49b..HEAD` (all files) through `tr -d '\11\12\15\40-\176' \| wc -c`; extractionNoteLines.test.ts whole | 0; 0; 0 |
| S4.8 step 4 | `npx eslint <the 23 .ts/.tsx files S4 touched>` | exit 0, no output - no errors, none pre-existing in these files |
| S4.8 step 5 | WI6 diff; WI14 `diff --stat`; WI15 runWindow diff; renderUtteranceLine `cmp` vs main | empty; empty; empty; identical |

Per-commit checks: the added lines of every touched file printed 0 in the
ASCII check before each commit, and the six-character `\u` escape counts of
every touched file were unchanged (the one escape, aiRunsRepo.ts
`SORT_KEY_CEILING`, survived; every other file holds none).

## WORKLIST items applied

WL-12 (S4.2), WL-13 (S4.3 Step 4, S4.7 Check, S4.8 WI4), WL-14 (S4.6),
WL-15 (S4.5), WL-16 (S4.4), WL-17 (recorded under WI14). G1 (every app vitest
run), G2 (absolute worktree paths), G3 (no db:start), G4 (no event).
