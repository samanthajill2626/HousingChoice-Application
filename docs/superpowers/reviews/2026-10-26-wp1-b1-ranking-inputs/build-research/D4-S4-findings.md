# D4-S4 findings - plan section 8 (S4 Notes lines)

Reader D4-S4 checked plan lines 1-515 (binding sections 0-4) and 5792-7733
(S4: tasks S4.1-S4.8 and the S4 coverage table), plus the S3 text S4 builds
on (plan 3628-5791), against the worktree at branch HEAD ede08552, whose
app/, dashboard/, e2e/ and scripts/ are byte-identical to main @d0e2c2d8
(`git diff --stat d0e2c2d8 HEAD` over those paths is empty). Checked: every
quoted anchor (verbatim and unique; the section-8 anchor and the worker /
dev / extractionFake / config anchors were diffed byte-for-byte), the
composition of S3's replacement text into each S4 anchor, every AppConfig
construction site, every ApplyDeps literal and applyExtraction caller, every
string-noteLines fixture in app/test and e2e, the run-record and run-detail
surfaces, the prompt text against the S3.6 absent-phrase test and PR58, and
each test sketch traced by hand against the planned implementation. Nothing
was run. Five findings: 1 BLOCKER, 3 MINOR, 1 NOTE.

## D4-S4-1 - BLOCKER - S4.2 "non-number reads as 0" case passes `undefined` to a defaulted parameter, so it can never go green

- Plan location: Task S4.2 Step 1, `app/test/extractionNoteLines.test.ts`,
  the helper at plan line 6154 and the case 'clamps confidence to 0..1 and
  reads a non-number as 0' at plan lines 6163-6169 (the item at 6165).
- What the plan says: the helper is
  `const note = (text: string, confidence: unknown = 0.9) => ({ text, confidence })`,
  and the case builds
  `[note('over one', 7), note('a string', '0.9'), note('missing', undefined), note('negative', -1)]`
  expecting `append` `['over one']` and `belowFloor` 3.
- What the tree holds: plain JavaScript. A default parameter applies when the
  argument is `undefined`, so `note('missing', undefined)` builds
  `{ text: 'missing', confidence: 0.9 }`. Traced against the S4.2 Step 3
  `filterNoteLines` (clampConfidence(0.9) = 0.9 >= 0.7, not blank, not
  postal, not present): the result is `append: ['over one', 'missing']`,
  `belowFloor: 2`. The case fails at S4.2 Step 4 GREEN, again at S4.3 Step 4
  (which re-runs the file) and at S4.8 step 2. An implementer following the
  plan literally is pushed to "fix" a correct `filterNoteLines`.
- Correction: plan line 6165 becomes
  `      modelLines: [note('over one', 7), note('a string', '0.9'), { text: 'missing' }, note('negative', -1)],`
  (an item with NO confidence key - the "missing" intent; `modelLines` is
  `readonly unknown[]`, so the literal typechecks). Expected values at
  6167-6168 are unchanged (`['over one']`, belowFloor 3).

## D4-S4-2 - MINOR - The WI4 grep "prints nothing" is wrong: the migrated `.map` fixtures and the legacy-string case still match

- Plan location: S4.3 Step 4 (plan line 7135), S4.7 Check (7633-7635), S4.8
  step 5 WI4 (7676-7677).
- What the plan says: `git -C W:/tmp/wp1-b1-ranking-inputs grep -n "noteLines: \['" app/test`
  (and `-- e2e app/test`, `-- app e2e`) "prints nothing".
- What the tree holds: S4.3's own migrations keep the string-array literal and
  map it: `noteLines: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((text) => note(text)),`
  (extractionApply.test.ts ~652, plan 6488),
  `noteLines: ['  ', '', 'real fact'].map((text) => note(text)),` (~665, plan
  6490), the new WI5 case
  `noteLines: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((text) => note(text)),`
  (plan 6590) and the deliberate legacy case
  `noteLines: ['a legacy string line'] as unknown as ExtractionResult['noteLines'],`
  (plan 6617). All four contain the literal `noteLines: ['`, so the grep prints
  four lines after S4.3 (git grep's default BRE reads `\[` as a literal `[`).
  Conversely the pre-S4.7 e2e form `noteLines: [noteLine],`
  (caseworkers.spec.ts:517) never matched the pattern, so the check also
  proves less than it claims.
- Correction: at all three places use
  `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -E "noteLines: \[('|noteLine\])" -- app/test e2e`
  and state the expected output: "prints exactly 4 lines, all in
  app/test/extractionApply.test.ts - the three `[...].map((text) => note(text))`
  fixtures (the cap, blank-line and WI5 cases) and the legacy-string case
  (`as unknown as ExtractionResult['noteLines']`); any other hit is an
  unmigrated string fixture." (At S4.3 Step 4, before S4.7, it additionally
  prints the three e2e lines, which S4.7 migrates.)

## D4-S4-3 - MINOR - S4.6 prompt block: the "Profile notes lines" sentence lands inside the NEVER bullet, and the list S5.5 cites is never named

- Plan location: Task S4.6 Step 3 replacement block (plan 7534-7554; the two
  lines at 7552-7553), its test (7495-7505), the cross-slice note (5941-5945);
  consumers: S5's cross-slice note (7884-7886: "S5's bullet 'the
  never-written list included' should use S4's exact name for that list"),
  S5.5 Step 3b last bullet (9402-9403) and its test phrase (9322), and S5.5's
  own fallback (9405-9406).
- What the plan says: the replacement ends
  `'  animal are allowed.',` /
  `'  Profile notes lines beginning "[Auto - <date>]" are your own notes from',` /
  `'  earlier runs.',`. Today (prompt.ts:107-111, also after S3.6's 3d) those
  two lines are the continuation of the noteLines bullet.
- What the tree holds / composes to: after S4.6 the two lines are indented
  continuation text of the `- NEVER write a noteLine stating any of these ...`
  bullet, so the model reads "Profile notes lines ... are your own notes" as
  part of the never-written rule. Separately, no S4.6 line names "the
  never-written list"; S5.5 then writes "Every other noteLine rule applies to
  feedback, the never-written list included", a name with no referent in the
  prompt the never-written gate (spec D7) is judged on.
- Correction: replace the S4.6 Step 3 `new:` block with (ASCII; every Step 1
  phrase stays inside one line; no "eight", "their rent portion" or "stairs
  are OK or a problem", so the S3.6 absent-phrase case stays green):
  ```ts
      '- noteLines are facts that might matter to matching this client with a home,',
      '  or to staff understanding their situation, that no field or other output',
      '  covers (for example: when they last moved, household size, work hours,',
      '  utility debt, other useful screening facts). A fact that adds to an',
      '  already-filled tenant matching text field is also a noteLine (see above).',
      '  Profile notes lines beginning "[Auto - <date>]" are your own notes from',
      '  earlier runs.',
      '- Each noteLine is an object: "text" is the line, "confidence" is a number',
      '  from 0 to 1 for how sure you are that the client stated the fact. Lines with',
      '  low confidence are not written, so never inflate it.',
      '- NEVER write a noteLine stating any of these, even when the client says it:',
      '  race, color, religion, sex (including sexual orientation and gender',
      '  identity), national origin; familial facts beyond',
      '  household size (no pregnancy, marital status, children\'s ages or custody);',
      '  disability or medical facts, other than the accessibility need (its field,',
      '  or a noteLine when it adds to the filled field) and an assistance animal.',
      '  Write a need as a feature of the home ("needs a ground floor"), never as a',
      '  diagnosis. Household size, the client\'s own rent portion and an assistance',
      '  animal are allowed. This is the never-written list.',
  ```
  Add to the S4.6 case 'states the never-written list ...':
  `expect(sys).toContain('animal are allowed. This is the never-written list.');`.
  Rewrite the cross-slice note (5941-5945) to "ending at
  `'  animal are allowed. This is the never-written list.',`". S5.5 needs no
  change (it anchors on the "Keep every noteLine SHORT" bullet, which S4 does
  not touch, and its "the never-written list" now has a referent).

## D4-S4-4 - MINOR - Run-detail copy "0 withheld - an unknown speaker was in the window" states a false fact on every normal run

- Plan location: Task S4.5 Step 3b (plan line 7409), Step 1 test 1 (7327),
  cross-slice note (5922-5923); S5.8's two verbatim anchor copies of the same
  `<li>` (10679 old, 10684 new).
- What the plan says: `notesDemoted` is present (0) on every run that reached
  apply (C3, PR34: a present 0 renders as 0), and the row renders
  `{run.notesDemoted} withheld - an unknown speaker was in the window`.
- What the tree holds / composes to: every non-demoted run that reached apply
  shows "0 withheld - an unknown speaker was in the window" in the admin run
  detail, asserting an unknown speaker that was not there. Spec 4 only says
  the counts are "shown in the run detail"; the copy is the plan's.
- Correction: change the row text to `withheld by the unknown-speaker rule` in
  lockstep at plan 7409 (`<li>{run.notesDemoted} withheld by the unknown-speaker rule</li>`),
  7327 (`'0 withheld by the unknown-speaker rule'`), 5922-5923, and BOTH S5.8
  anchor copies (10679, 10684) - S5.8 anchors on this `<li>` verbatim and
  STOPs on a mismatch (10695-10696). The S4.5 commit message (7448) may keep
  its wording.

## D4-S4-5 - NOTE - S4.4 edits aiRunsRepo.ts, which carries a `\u` escape; no escape check is listed

- Plan location: Task S4.4 Step 3d (plan 7258-7281); section 0 rule (plan
  59-60: "after any edit near one, grep that the six-character escape
  survived").
- What the tree holds: `app/src/repos/aiRunsRepo.ts:124`
  `const SORT_KEY_CEILING = '\uffff';` - the only `\u` escape in any file S4
  touches; S4.4's Edit sits at :63-66 (S5.7 edits the same interface again).
- Correction: add to S4.4 Step 4:
  `git -C W:/tmp/wp1-b1-ranking-inputs grep -n -F "'\uffff'" -- app/src/repos/aiRunsRepo.ts`
  prints the SORT_KEY_CEILING line.

## Verified with no finding

- Tree: branch source equals main @d0e2c2d8 for app/, dashboard/, e2e/,
  scripts/ (diff --stat empty); worktree clean.
- S4.1 (config): all four anchors verbatim and unique (config.ts:372-374,
  :903-906, :1331-1333; `export function loadConfig(` :516); no other slice
  edits config.ts. No AppConfig object literal exists anywhere: every site is
  an `as AppConfig` cast (backfillMediaContentTypes.test.ts:433,
  groupConversationsAdapter.test.ts:725/739/751/990, groupSend.test.ts:237/1388,
  contactTimeline.test.ts:1654, poolNumbers.test.ts:318,
  poolNumbersAdmin.test.ts:642, relayWarm.test.ts:52,
  twilioEventsWebhook.test.ts:188) or a `...loadConfig(...)` spread
  (jobQueueWiring.test.ts:22, systemStatus.service.test.ts:29/34,
  voiceTranscriptJobs.test.ts:49, sesWebhook.test.ts:93,
  cloudwatch.adapter.test.ts:46); no `keyof AppConfig` map or config key-list
  pin; `base`/`prodBase` exist (configAiExtraction.test.ts:5, :11); each
  it.each value ('0', '1.5', 'abc', '-0.1', 'NaN', 'Infinity') throws under
  the planned parser; ' 1 ' and '' behave as asserted; configEmail /
  configEventBridge test files exist.
- S4.2: `filterNoteLines` typechecks under strict + noUncheckedIndexedAccess;
  apart from D4-S4-1 every case's expected value matches the planned code
  (traced); the floor-before-cap and guard-before-cap cases each fail a
  wrong-order implementation (not vacuous); the insertion point after
  `autoPrefix` (apply.ts:144-149) survives S3.4's `isFilledText` (inserted
  before it); MAX_NOTE_CHARS / MAX_NOTE_LINES are both used; the new test file
  name is free. Order matches PR9 (clamp, floor counted, blank/postal, guard
  over model and system lines, join, cap model-first, demotion last) and PR11
  (`demoted` = what the run would have appended).
- S4.3: the section-8 anchor is byte-identical to apply.ts:713-751; header
  (:8), ApplyDeps (:42-44), ApplyOutcome (:51-52) and return (:758) anchors
  are unique; no `existing` / `prefix` / `filtered` at applyExtraction's
  function scope; `ctx` in scope. schema.ts anchors (:14-19, :124-127,
  :167-169, :268-274) are untouched by S3.3/S3.8; `isRecord` exists
  (schema.ts:171); the new parser narrows `item.text` / `item.confidence` the
  way schema.ts:200 already does; no other schema.ts reader of the removed
  constants. The six ApplyDeps construction sites are exactly the repo's set
  (worker.ts:489, routes/dev.ts:765, extractionApply.test.ts:102,
  contactStaffNotes.test.ts:381, extractionJob.test.ts:287,
  extractionJobDraftGuard.test.ts:163); worker.ts:38 and dev.ts:222 hold a
  full AppConfig; no other applyExtraction caller (jobs/extraction.ts:614) and
  no other `applyDeps` / `extractionTickDeps` builder in app/test or e2e. The
  app string-noteLines list is complete (contactStaffNotes.test.ts:417;
  extractionAdapter.test.ts:125/133/134; extractionApply.test.ts:652, 665,
  674, 686, 711, 798, 1052, 1068-1071, 1260; extractionSchema.test.ts:93,
  125-137, 148; :176 and :253 are `[]`); the probe references neither
  noteLines nor ApplyDeps. The two whole-outcome pins (:207, :268-279) are the
  only ones; the Layer-3 rewrite anchors (:788, :810-813) are unique;
  '555-010-9999' normalizes to +15550109999 (lib/phone.ts); the demoted
  phone case emits nothing (no suggestion-state change on that path).
- S4.4: RunDraft / recordRun / AiRunRecord anchors verbatim
  (jobs/extraction.ts:322-323, :629, :671-673; aiRunsRepo.ts:63-66); putRun
  spreads its input (aiRunsRepo.ts:223-225) and the detail route returns the
  run verbatim (routes/aiRuns.ts:228-272); harness helpers exist
  (extractionJob.test.ts msg :69, callMsg :89, landlordContact :163, convWith
  :171, dueRow :315, contactsUpdate :261); `Speaker N:` lines become speaker
  'unknown' (jobs/extraction.ts:211-212), so test 2 is a demoted run; the
  landlord PIN skips before apply.
- S4.5: AiRunRecordView anchor unique (dashboard/src/api/types.ts:372-375);
  the rawText line (AiRunDetail.tsx:87) is untouched by S3.7; the planned
  NotesLines text is exactly S5.8's anchor (plan 10656-10659, 10679); the base
  fixture (AiRunsSection.test.tsx:26) carries no counts, so the PIN holds;
  `section` + `aria-label` gives the region role; the CSS tokens exist in
  AiRunsSection.module.css; no aria snapshot or unscoped list/region query in
  e2e ai-run-log.spec.ts. (Step 2's aside that `npx tsc` rejects the fixture
  is moot - `useAiRun` is an untyped `vi.fn()` - and harmless.)
- S4.6: S3.6 3d's replacement composes S4.6's `old:` anchor exactly
  (prompt.ts:107-111); every Step 1 phrase sits inside one line; the PR58
  wording is present; `buildExtractionSystemPrompt` is already imported
  (extractionSchema.test.ts:8-13); the existing prompt cases (:324-394,
  :524-575) stay green; S5.5's anchors are not touched by S4.
- S4.7: e2e anchors verbatim (caseworkers.spec.ts:517,
  conversation-fact-extraction.spec.ts:332, :377; extractionFake.ts:7-11
  diffed); no other noteLines in e2e or dashboard; ai-run-log.spec.ts:177 is
  `[]`; payloads are untyped (e2e/fixtures/extraction.ts:50-54); every e2e
  flow carrying noteLines is an SMS window, so none is demoted; the new
  header text names no tenant matching key (S3.3 readers pin).
- WI6: hasAiCaseworkerNote's only reader (services/possibleCaseworkers.ts:82)
  and its tests (caseworkers.test.ts, possibleCaseworkers.test.ts) seed notes
  directly; no app or e2e test relies on a note from a demoted window.
- Commands: every named test file exists; app `typecheck` covers src,
  scripts and test configs; dashboard and e2e `typecheck` scripts exist.
- ASCII: plan 5792-7733 carries no non-ASCII character and no `\u` escape.
