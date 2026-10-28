# S5 slice report - Feedback lines (WP1 B1)

Slice S5 (plan section 9, tasks S5.1-S5.9; spec rev 10 D5.1-D5.4 and its
spec 4/5 lines). Implementer: Claude Opus 5.5. Branch head at start 6d56b5d4
(S4 closed); main @d0e2c2d8 (unchanged during the slice; merge base
d0e2c2d8). Findings only; code cited by `file:line` at the S5 head.

## Commits

| Task | Commit | Subject |
|---|---|---|
| S5.1 | be9b7982 | feat(extraction): propertyLabel, labelMatches and the street-address pattern in one leaf (wp1 b1 S5.1) |
| S5.2 | d4f63921 | feat(units): getDisplaysByIds requireComplete option (wp1 b1 S5.2) |
| S5.3 | bc62bc2e | feat(extraction): the PROPERTIES SENT block renderer and the feedback counter (wp1 b1 S5.3) |
| S5.4 | c87ce7ae | feat(extraction): the PROPERTIES SENT block's place in the user content (wp1 b1 S5.4) |
| S5.5 | a6a2a1ac | feat(extraction): prompt names the PROPERTIES SENT block and asks for feedback lines (wp1 b1 S5.5) |
| S5.6 | f42f6d21 | feat(extraction): the job sends the PROPERTIES SENT block (wp1 b1 S5.6) |
| S5.7 | 67b1c5eb | feat(extraction): feedbackLines and unlabeledAddressLines on the run record (wp1 b1 S5.7) |
| S5.8 | fa11d6f2 | feat(dashboard): AI run detail shows the properties sent fingerprint and the feedback counts (wp1 b1 S5.8) |
| S5.9 | (this report) | docs(records): wp1 b1 S5 slice report |

## What the tree held that the plan got wrong

- Nothing beyond what the WORKLIST already corrected (WL-15, WL-18 ..
  WL-24, applied below). Every main-era anchor S1-S4 left in place matched
  verbatim and uniquely on the first Edit, and every S4-rewritten anchor
  matched the WORKLIST's post-S4 text verbatim. No G4 event.
- Line hints drifted with S1-S4 (the quoted text was the authority), at the
  S4 head: unitsRepo.ts interface :661-669 and implementation :1277
  (plan :661-668 / :1276); extractionSchema.test.ts literal sites :484, :550,
  :572, :665, :680 (plan :412, :478, :500, :593, :608) and the address case
  :641-647 (plan :569-576); jobs/extraction.ts org fingerprint :598-599 and
  driver call :604 (plan :580-581 / :586), RunDraft :329-364, recordRun
  :677-697; prompt.ts description :30-33 (plan :20-23), "Keep every noteLine
  SHORT" :162-163 (plan :124-125), the no-address bullet :170-171 (plan
  :132-133), buildExtractionUserContent :232-233 (plan :191-195); probe
  buildInput :208 (plan :205); aiRunsRepo.ts AiRunRecord :40-80 (the
  `'\uffff'` line moved :132 -> :137 -> :143 as S5.6/S5.7 added doc
  comments); AiRunsSection.test.tsx anchor :245-248 (plan :242-245);
  AiRunRecordView :346-389 (plan :339-374).
- The extractionApply system-line text the S5.7 case pins
  (`Mentioned number +15550109999 which belongs to another contact`) is
  apply.ts:837 as written; the job prefix is `[Auto - Jul 17]` (harness NOW)
  and the apply prefix `[Auto - Jul 16]`, as the plan said.

## Divergences (each deliberate)

1. WORKLIST items, verbatim: WL-15 (S5.8's second NotesLines anchor uses the
   built row `{run.notesDemoted} withheld by the unknown-speaker rule`);
   WL-18 (S5.7 3b/3c on S4's `notedLines = filtered.append.length;` + its two
   "(S5)" comment lines, replaced by D5-S5-1's comment and
   `appendedLines = filtered.append;`, apply.ts:921-924; the five-line return
   gains `appendedLines`, :935-939); WL-19 (recordRun, AiRunRecord and
   AiRunRecordView anchored on S4's `notesDemoted` line; the S5.8 note about
   `notedLines: number;` at ~264/~2207 dropped); WL-20 (confirmed: the NEVER
   bullet ends `'  animal are allowed. This is the never-written list.',`,
   prompt.ts:152 - S5.5's last bullet and its test phrase kept as planned);
   WL-21 (the case renamed to 'carries the address hard rule
   (current-residence only); the no-address bullet is gone (PR50)' and the
   sibling comment rewritten, extractionSchema.test.ts:635-636, :645);
   WL-22 (the aiRunsRepo PIN was runtime-green at RED and typechecks once
   Step 3h's fields exist; the typecheck ran after 3h); WL-23 (absolute grep
   forms: 4, 8, and the ApplyOutcome grep below); WL-24 (E1-3's WI10
   pattern); WL-16 (escape check after both S5.6's and S5.7's edits to
   aiRunsRepo.ts).
2. S5.7 Step 3e and 3f placed AFTER S4's last lines - `feedbackLines?` /
   `unlabeledAddressLines?` after `notesDemoted?: number;` in RunDraft
   (jobs/extraction.ts:364-368), and the countFeedbackLines block after
   `draft.notesDemoted = applyOutcome.notesDemoted;` (:717-724) - instead of
   directly after the plan's main-era anchors `notedLines?: number;` /
   `draft.notedLines = applyOutcome.notedLines;` (both still matched). The
   plan's own step headers and its S5 cross-slice note say S5's counts go
   "after S4's count fields", and WL-19 does exactly that for 3g/3h/S5.8 3b.
   Field and statement order only; no behavior difference.
3. S5.7 Step 3b first edit: anchored on `let notedLines = 0;` plus the
   comment line under it (apply.ts:897-899); the same insertion.
4. S5.8 Step 1 test comment: the plan's text cited `jobs/extraction.ts:601,672`
   (main's lines, moved by S4/S5); written instead as "the job's failed-call
   path sets it to 0 and recordRun defaults it with `?? 0`"
   (AiRunsSection.test.tsx, the fingerprint-only case). Comment only - the
   S4 precedent adf7f055 for stale line cites.
5. MERGE_HEAD check: the brief's `test -e "$(git -C ... rev-parse --git-path
   MERGE_HEAD)"` form, gating the add + commit in the same command; it
   printed `none` before every commit. Instead of the plan's `ls`.
6. Commit bodies of S5.5, S5.7 and S5.8 carry one extra line naming the
   WORKLIST items they apply.
7. Typecheck cadence per the brief: bare root `npm run typecheck` after S5.2,
   S5.3, S5.4, S5.6, S5.7, S5.8 and at S5.9. S5.5 changes prompt strings only
   (no type), so it ran tests only.

## Contradictions C1-C9 (plan section 9), as built

- C1: no second `isListed`. `listByContact` filters (listingSendsRepo.ts:497);
  `selectSentRows` only narrows `sentAt` to a string and takes the newest 20
  (sentPropertiesBlock.ts:81-95).
- C2 (PR16): the contacts precedent - with `requireComplete` a thrown chunk
  rethrows (unitsRepo.ts:1317), keys still unread throw
  `IncompleteBatchReadError(unprocessed, requested, 'units')` (:1323-1325);
  nothing is WARNed on that path. Either fails the run as `repo`
  (jobs/extraction.ts:637-649). Tests: unitsRepoDisplays.test.ts
  'requireComplete' describe; extractionJob.test.ts 'FAILS the run when the
  units read is incomplete ...'.
- C3: optional third constructor argument `table = 'contacts'`
  (contactsRepo.ts:690-695); the two-argument sites are unchanged;
  PIN 'the contacts message is unchanged when no table is named'.
- C4: `ApplyOutcome.appendedLines: string[]` (apply.ts:66-74), set only at the
  one successful notes write to `filtered.append` (:924) - exactly the list
  joined into `nextNotes` (:917-918); [] when nothing was appended or the
  write failed. The job counts over it (jobs/extraction.ts:718-724); apply
  never sees the block.
- C5 (PR34/PR42/PR46): the three items sit in S4's "Notes lines" region after
  S4's rows (AiRunDetail.tsx:82-84); the guard widens to any S4/S5 count or
  the fingerprint (:74-77); the "appended" row renders only when a count is
  present or `notedLines > 0` (:79). The header is unchanged.
- C6 (PR50): the no-address bullet is deleted with nothing in its place; the
  address-output bullet (prompt.ts:185-190) is byte-unchanged and pinned
  ('drops the no-address bullet; the address output still never takes a
  sent home').
- C7 (PR45): `propertyLabel` flattens every control character and whitespace
  run to ONE space in the leaf (propertyLabel.ts:48-57); the module header and
  the ONE-line test say so.
- C8: stale spec cites only; no code.
- C9 (PR18): a soft-deleted unit that answers the display read is listed like
  any other (no `deleted_at` read in the job, jobs/extraction.ts:643-646).

## Built on top of S4's text

- apply.ts section 8 (S4.3): the anchors were S4's
  `notedLines = filtered.append.length;` + its "(S5)" comment (replaced,
  WL-18) and S4's five-line return object. `appendedLines = filtered.append`
  relies on S4's invariant that `filtered.append` is model lines (after
  clamp, floor, postal filter, guard) then system lines, capped, and is
  exactly what is joined into the notes (filterNoteLines :275-302).
- `ApplyOutcome` (S4.3 3h): `appendedLines` sits after `notedLines`, before
  S4's `notesBelowFloor` / `notesDemoted`, as the plan placed it.
- The two exact pins (extractionApply.test.ts:217 and :278-291) as S4.3 left
  them: `appendedLines: []` added beside S4's counts (PR31).
- prompt.ts (S4.6): the feedback bullets (prompt.ts:167-184) go right after
  "Keep every noteLine SHORT" (:165-166, a bullet S4 did not reword) and
  before the `address` bullet (:185). S4's noteLines, confidence and NEVER
  bullets (:134-152) and the RECONCILE / revise bullets are untouched.
- RunDraft, recordRun, AiRunRecord, AiRunRecordView: S5's fields after S4's
  `notesDemoted` (WL-19, divergence 2).
- AiRunDetail.tsx `NotesLines` (S4.5): S4.5's four guard lines and the WL-15
  withheld row were the anchors.
- The extractionJob harness `applyDeps` carries S4's `factMinConfidence: 0.7`
  (extractionJob.test.ts:303), so the 0.5 line in S5.7's job case is below
  the floor as planned.

## Watch items owned by S5

- WI2 (transcript render and per-message hash byte-unchanged, pinned):
  extractionRunWindow.test.ts '(PIN) WI2 - the PROPERTIES SENT block leaves
  the transcript render and the per-message hash byte-unchanged' - the render
  literals and the hashes `8804bb247bad2f59` / `f0196a44d5ac9368` were green
  at the S5.4 RED run (before the builder changed) and after; its second case
  proves the bytes after `\nTRANSCRIPT\n` are identical with and without the
  block. `renderUtteranceLine` and `toSingleLine` are byte-identical to main
  (awk-extracted, `cmp`); `git diff d0e2c2d8 HEAD -- app/src/services/extraction/runWindow.ts`
  is empty.
- WI8 (existing callers unchanged): S5.2 PIN 'WI8: without requireComplete
  (absent, {} or false) an unread key is dropped with a WARN, never a throw'
  green; the callers pass nothing - routes/tours.ts:551
  `units.getDisplaysByIds(unitIds)` and the harness fake
  app/test/helpers/twilioWebhookHarness.ts:2991 `async getDisplaysByIds(unitIds)`
  (one parameter, still assignable; root typecheck exit 0). The only
  `requireComplete` caller is the job (jobs/extraction.ts:642).
- WI9 (required deps at every construction site): app/src/worker.ts:472-473,
  app/src/routes/dev.ts:748-749, app/test/extractionJob.test.ts harness
  (:307-315), app/test/extractionJobDraftGuard.test.ts:176-177. The
  typecheck named no other site (exit 0 at S5.6); dev.ts:129's
  `extractionTickDeps?: ExtractionJobDeps` override is typed, so covered too.
- WI10 (no listing_sends write in the extraction path): the E1-3 grep
  (`putShareMemory|setDeclined|clearDeclined|getByKeyConsistent|applyShareLedgerEntry|applyFlyerShareEntry|applyLaterAttempt|originalRowLedgerWrite|createListingSendsRepo`
  over jobs/extraction.ts, services/extraction, lib/propertyLabel.ts) printed
  nothing, exit 1. The S5.6 proxy test 'WI10: the run only READS -
  listByContact and getDisplaysByIds are the only members it touches' is
  green.
- WI15 (fingerprint changes; per-message hash does not): the prompt text
  changed in S5.5 (expected); no test pins a fingerprint literal (the adapter
  tests recompute `extractionPromptFingerprint()`); the per-message hash is
  WI2's pin.
- WI1 (S5's share): the counts read apply's output (`appendedLines`), never
  the parser; S5.7's job cases go through the fake driver's EXTRACT marker,
  which bypasses the parser, and the counts hold.

## ExtractionInput literals updated (S5.4)

- app/test/extractionSchema.test.ts: the 4 `      orgListBlock: '',` sites
  (grep -c printed 4 before the edit) and the 1 `orgListBlock: block,` site;
  plus 2 new cases.
- app/test/extractionAdapter.test.ts: the 8 `orgListBlock: '', profile:`
  sites (grep -c printed 8); plus 1 new case.
- app/test/extractionRunWindow.test.ts: 1 site; plus the 2 new WI2 cases.
- app/src/jobs/extraction.ts driver call (interim `''`, then `sentBlock.text`
  in S5.6, :670-672); app/scripts/extraction-prompt-probe.ts:208
  (`sentPropertiesBlock: ''` - S6 replaces it).
- The typecheck named no extra literal. `git grep -n "ApplyOutcome" -- app/src app/test app/scripts`
  finds only apply.ts and one test name, so no other hand-built outcome.

## Risks and notes

- Every run that passes the skip gates now makes one more Query
  (listing_sends byContact) and, when the contact has sends, one units
  BatchGet (at most 20 ids). A listing_sends or units outage now fails
  extraction for every conversation that reaches the model, parked after
  MAX_EXTRACTION_ATTEMPTS (spec D5.1's accepted cost). The instance role
  already grants Query and BatchGetItem on every stack table and its indexes
  (infra/modules/ec2/main.tf `values(var.table_arns)` and `/index/*`); no
  infra change.
- The "Notes lines" region now renders on EVERY run that read the sends,
  including `PROPERTIES SENT: none` runs, because the fingerprint is always
  stamped there (PR42). Runs recorded before B1 are unchanged. No e2e spec
  asserts the region's absence (git grep over e2e).
- `hasStreetAddress` is a heuristic (its header says so): "a 3 bedroom place"
  counts. It only feeds `unlabeledAddressLines`.
- `labelMatches` folds only `.` `,` `#`, case and spacing; a label holding
  other punctuation (an apostrophe or hyphen in a street name) must be copied
  exactly. The S6 probe and Cameron's gate run are where label copying is
  seen.
- `countFeedbackLines` runs inside `draftPiece`: a throw there logs ids only
  and leaves both counts absent; it never fails the run.
- The fingerprint item renders on truthiness while the guard tests
  `!== undefined`; a stored `''` fingerprint (unreachable - always sha256
  hex) would render an empty region.
- S5.8's new cases sit inside the "AiRunsSection - the organization list"
  describe, where the plan's anchor puts them.
- For S6: the probe still sends `sentPropertiesBlock: ''` (S5.4 interim);
  the fake driver ignores the block. For S7: the detail item text is
  `Feedback lines: <n>`, `Unlabeled address lines: <n>`,
  `Properties sent fingerprint: <hex>`.

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, each prefixed
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL` (G1); dashboard runs from
`W:/tmp/wp1-b1-ranking-inputs/dashboard`; root typecheck and lint from the
worktree root. Nothing piped; output redirected to
`.superpowers/sdd/s5-*.log` (gitignored). DynamoDB Local was already running
(G3); no AWS_* variable is exported (count 0).

| Step | Command | Result |
|---|---|---|
| S5.1 RED | `npx vitest run test/propertyLabel.test.ts` | exit 1, the file fails to load (`../src/lib/propertyLabel.js` not found) - stated reason |
| S5.1 GREEN | same | exit 0, 1 file / 18 tests |
| S5.2 RED | `npx vitest run test/unitsRepoDisplays.test.ts` | exit 1, 2 failed / 9 passed: `expected undefined to be an instance of IncompleteBatchReadError`; `promise resolved ... instead of rejecting` - stated reasons; 3 PINs green |
| S5.2 GREEN | the five plan files | exit 0, 5 files / 51 tests; root typecheck exit 0 |
| S5.3 RED / GREEN | `npx vitest run test/extractionSentPropertiesBlock.test.ts` (+ propertyLabel) | exit 1, module not found; exit 0, 2 files / 36 tests; root typecheck exit 0 |
| S5.4 RED | runWindow + schema + adapter | exit 1, 4 failed / 100 passed: the request-bytes case, the two schema cases, the adapter case (block absent); the WI2 literal pin green |
| S5.4 GREEN | the five plan files | exit 0, 5 files / 229 tests; root typecheck exit 0 |
| S5.5 RED | `npx vitest run test/extractionSchema.test.ts` | exit 1, 6 failed / 54 passed: the renamed address case and the five new cases |
| S5.5 GREEN | schema + adapter + caseworkers | exit 0, 3 files / 172 tests |
| S5.6 RED | extractionJob + draft guard | exit 1, 10 failed / 100 passed: every new case except the skip-path and no-WARN PINs |
| S5.6 GREEN | the four plan files | exit 0, 4 files / 157 tests; root typecheck exit 0 |
| S5.7 RED | apply + job + aiRunsRepo | exit 1, 8 failed / 260 passed: the 2 whole-outcome pins, 3 apply cases, 3 job cases; the failed-call case and the aiRunsRepo PIN green at runtime |
| S5.7 GREEN | the five plan files | exit 0, 5 files / 352 tests; root typecheck exit 0 |
| S5.8 RED | `npx vitest run src/routes/settings/aiRuns/AiRunsSection.test.tsx` | exit 1, 3 failed / 38 passed: items absent; region absent (zero-count, fingerprint-only) |
| S5.8 GREEN | AiRunsSection + useAiRuns | exit 0, 2 files / 48 tests; root typecheck exit 0 |
| S5.9 step 1 | `npm run typecheck` (root, bare) | exit 0, 0 `error TS` |
| S5.9 step 2 | `npx eslint <the 25 files>` | exit 0, no output - no errors, none pre-existing in these files |
| S5.9 step 3 | WI10 grep (E1-3 pattern) | no output, exit 1 |
| S5.9 step 4 app | `npx vitest run` | exit 0, 542 files / 11592 passed, 1 skipped (S4 close 540 / 11521 + 1; +2 files, +71 tests = S5.1 18, S5.2 5, S5.3 18, S5.4 5, S5.5 5, S5.6 12, S5.7 8); 0 `[dynamoAdmin]` lines; 60.3 s |
| S5.9 step 4 dashboard | `npx vitest run src/routes/settings/aiRuns` | exit 0, 2 files / 48 tests |
| S5.9 step 5 | `git diff -U0 d0e2c2d8 -- app dashboard` added lines through `tr -d '\11\12\15\40-\176' \| wc -c`; same for `6d56b5d4..` (all files) | 0; 0 |

Per-commit checks: the added lines of every touched file printed 0 in the
ASCII check before each commit (new files checked whole), and the
six-character `\u` escape count of every touched file was unchanged (the one
escape, aiRunsRepo.ts `SORT_KEY_CEILING = '\uffff'`, survived both edits -
now :143; every other file holds none).

## WORKLIST items applied

WL-15 (S5.8), WL-18 (S5.7), WL-19 (S5.7, S5.8), WL-20 (confirmed, S5.5),
WL-21 (S5.5), WL-22 (S5.7), WL-23 (S5.4, S5.7), WL-24 (S5.9), WL-16 (S5.6,
S5.7). G1 (every app vitest run), G2 (absolute worktree paths), G3 (no
db:start), G4 (no event).
