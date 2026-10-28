# S3 slice report - Extraction reconciles the four fields (WP1 B1)

Slice S3 (plan section 7, tasks S3.1-S3.9; spec rev 10 D3, the extraction
bullets of D1, the provenance bullet of D2). Implementer: Claude Opus 5.5.
Branch head at start 8cd6feb5 (S2 closed); main @d0e2c2d8 (unchanged during
the slice; `git merge-base main HEAD` = d0e2c2d8). Findings only; code cited
by `file:line` at the S3 head.

## Commits

| Task | Commit | Subject |
|---|---|---|
| S3.1 | 9bcbdee2 | feat(extraction): sixteen decision targets, eleven tenant-only, text_field_filled (B1 S3.1) |
| S3.2 | 9f116f38 | feat(extraction): coerceField exported, the tenant matching inputs coerced by kind (B1 S3.2) |
| S3.3 | 2e8f08ad | feat(extraction): the four tenant matching inputs become extractable (B1 S3.3) |
| S3.4 | 63226a7d | feat(extraction): a write on a filled text field is dropped as text_field_filled (B1 S3.4) |
| S3.5 | a5fe185a | feat(extraction): CURRENT PROFILE carries the tenant matching inputs (B1 S3.5) |
| S3.6 | d20e9853 | feat(extraction): prompt guidance for the tenant matching fields from the list (B1 S3.6) |
| S3.7 | b1659d3d | feat(dashboard): run detail orders the tenant matching inputs and labels text_field_filled (B1 S3.7) |
| S3.8 | f8e5f7fa | chore(extraction): every target and field count updated to sixteen and twelve (B1 S3.8) |
| S3.9 | (this report) | docs(records): B1 S3 slice report |

## Start gate (plan section 7 "Assumptions S3 builds on")

All four held, the second as WL-6 / D3-S3-1 corrects it. No stop.

- The list module exports `TENANT_MATCHING_INPUTS` (four, spec D1 order,
  `as const satisfies`), `TenantMatchingInputKey`, `TenantMatchingInputKind`,
  `TENANT_MATCHING_TEXT_MAX = 500`, `TENANT_MATCHING_DOLLARS_MAX = 20000` and
  has no import line (app/src/lib/tenantMatchingInputs.ts:17-85). Each
  `promptGuidance` is one ASCII line (now pinned by S3.6's case "gives every
  tenant matching input its guidance from the list, one line each").
- `ContactItem extends TenantMatchingInputValues`
  (app/src/repos/contactsRepo.ts:122): the four VALUE keys only; `<key>_source`
  rides the index signature (:396), per PR24. Nothing in S3 needs a typed
  `_source` key.
- `parseTriageBody` pushes every changed key among the four into
  `changedFields` (app/src/routes/contacts.ts:790-794) and accepts the portion
  as an integer through `parseTenantMatchingInputs`
  (tenantMatchingInputs.ts:128-142).
- The dashboard mirror exports `TENANT_MATCHING_INPUTS` with the same keys in
  the same order (dashboard/src/routes/contact/tenantMatchingInputs.ts:27-44).

## What the tree held that the plan got wrong

- Nothing material beyond what the WORKLIST already corrected (D3-S3-1 .. -5,
  applied below). Every quoted anchor matched verbatim and uniquely; no Edit
  was refused (no G4 event).
- Line hints drifted with S1/S2 and S3's own earlier tasks (the quoted text
  was the authority): contacts.ts PROVENANCE comment :1119-1121 (plan
  :1097-1099) and "other eleven targets" :2066 (plan :2043);
  suggestionResolution.ts :33, :48, :108-110, :735 (plan :31, :46, :106-108,
  :722); adapters/extraction.ts budget comment :188 (plan :172); schema.ts
  :322, :357 (plan :329, :364); journalSweep.ts :231, :253 (WL-8 :229, :251);
  journalSweep.test.ts :513 (WL-8 :512); extractionSchema.test.ts :577 (WL-8
  :536, moved by S3.3's inserted describe); dashboard types.ts :2257 (plan
  :2241); AiRunsSection.test.tsx :112-117 (plan :109-114).
- Neither fallback the plan offered was needed: the `as const` tuple with a
  spread compiles (S3.1 Step 4), and `ExtractionProfileSnapshot extends
  TenantMatchingProfile` compiles as an interface (no TS2312, S3.5 Step 3b).
- D3-S3-6 confirmed in passing: the dismiss PIN is green because dismiss
  returns its plan before any target check
  (app/src/services/suggestionResolution.ts:295-304), not because of
  `isDecisionTarget`.

## Divergences (each deliberate)

1. WL-7 (S3.3 Step 1b): the PROVENANCE case reads
   `expect(PROVENANCE_FIELDS).toEqual([...ORIGINAL, ...MATCHING, 'address'])`
   (app/test/extractionSchema.test.ts:96-97). Observed RED on unchanged code
   (nine elements, expected thirteen), GREEN after 3b.
2. WL-10 (S3.3 Step 1e): D3-S3-5's case appended as the LAST case of the
   describe (app/test/suggestions.test.ts, "refuses a fractional or
   out-of-range dollars suggestion, KEEPING it (one coercion rule)"). Observed
   RED exactly as stated: status 400 passed, body `unknown_target` vs
   `invalid_suggestion_value`.
3. Extra non-vacuity check (S3.3, not in the plan): with the `coerceAccept`
   delegation temporarily disabled (its `if` made unreachable), 4 cases of
   suggestions.test.ts failed - the '1200' accept stored the STRING '1200',
   the '$1,200' accept stored '$1,200', the 501-character text was accepted
   (200), and WL-10's '1200.50' was accepted (200). Restored before the
   commit (a grep for the temporary marker prints nothing). This proves WL-7's Step 2
   sentence ("$1,200 only passes after 3e") and that WL-10 guards C3.
4. WL-8 (S3.8 items 15-20), verbatim per D3-S3-3: journalSweep.ts:231 and
   :253, journalSweep.test.ts:513, suggestionResolutionRecovery.test.ts:17,
   extractionSchema.test.ts:577, AiRunsSection.test.tsx:114 ("summed to 16")
   and :116-117 (`not_addressed: 15` / `16`). Their four app files joined the
   S3.8 `git add`.
5. WL-9 (S3.8 item 21): e2e/support/selectors.md:81 takes D3-S3-4's wording
   verbatim ("porting, then the tenant matching inputs in list order
   (area_preference, max_tenant_portion, accessibility_need,
   preferences_constraints), address, status, type, phone)") - not
   E2-readers-3's flat list, since WL-9 says "per D3-S3-4" - and the label
   exception now also reads "`text_field_filled` reads `Field already
   filled`". The `'\\b'` in the same line survived. The RUNBOOK half
   (RUNBOOK.md:1596, :614) is S6.7's (WL-34); not touched here.
6. The S3.3 and S3.8 commit messages carry one extra body line naming the WL
   items.
7. The MERGE_HEAD check used the brief's
   `test -e "$(git -C ... rev-parse --git-path MERGE_HEAD)"` form (printed
   `none` before every commit) instead of the plan's `ls`.
8. Typecheck: the brief's rule (bare root `npm run typecheck` whenever a task
   changes a type, interface, import or signature) was applied after S3.1,
   S3.2, S3.3, S3.5, S3.6 and S3.7, in addition to the plan's per-workspace
   tsc steps; S3.4 (no type or import change) ran the app src tsc only.
9. S3.8's check also ran the four app files WL-8 and item 12 touch
   (journalSweep, suggestionResolutionRecovery, extractionSchema,
   suggestionResolutionRepo.integration), not only the plan's two.
10. S3.9: the dashboard step ran the whole dashboard workspace (allowed by the
    brief; it includes the plan's two paths), and the lint step ran all 30
    `.ts`/`.tsx` files S3 touched (D3-S3-7 noted the plan's list covers 10).
11. The WI3 grep is recorded below as every hit's `file:line` with its reason,
    plus the exact command, rather than pasted raw lines: the raw output is
    regenerable at this commit and AGENTS.md keeps byte-exact code quotation
    out of records. Nothing is dropped - all 81 hits are listed.

## Contradictions C1-C6 (plan section 7), resolved

- C1: executable pins and runTypes in S3.1 (journalSweep.test.ts:135-136,
  extractionJob.test.ts:1130), schema doc comments in S3.3, the rest in S3.8.
  Left as is, with reason (see WI3): aiRunVerdicts.test.ts:2263,
  journalSweep.test.ts:262, suggestionResolutionRecovery.test.ts:118, and the
  "ninth target" name of `address` (adapters/extraction.ts:71, apply.ts:439,
  schema.ts:137, :244, extractionApply.test.ts:852).
- C2: label `text_field_filled: 'Field already filled'`
  (dashboard/src/api/types.ts:319-321) and the code in the hand-kept server
  list (dashboard/src/api/types.test.ts:360-361).
- C3: `coerceAccept` delegates to the exported `coerceField` for a tenant
  matching input (app/src/services/suggestionResolution.ts:166-175): one rule.
  No import cycle: `suggestionResolution.ts` is imported only by
  jobs/journalSweep.ts:76, routes/api.ts:136 (type-only) and
  routes/suggestions.ts:29, none of which apply.ts reaches.
- C4: the four get the 500 cap on both paths (C3). The original eight are
  unchanged on both paths, so the pre-existing disagreement stays: coerceField
  caps free text at 120 (apply.ts:163, :169) while coerceAccept has no cap
  (suggestionResolution.ts:189). Out of scope per PR13; noted here.
- C5: the `text_field_filled` check sits after the contact-type check and
  BEFORE coercion (app/src/services/extraction/apply.ts:266-282).
- C6: the probe's `withRecorded` uses `Object.assign`
  (app/scripts/extraction-prompt-probe.ts:188-195); `tsc -p
  tsconfig.scripts.json` exit 0 at S3.2, and the root typecheck after S3.5
  (the widened profile type) exit 0.

## Watch items owned by S3

### WI3 - hard-coded counts

Command (PR36 form, run after the S3.8 edits; output 81 lines, ASCII):

```
git -C W:/tmp/wp1-b1-ranking-inputs grep -n -i -w -e eight -e twelve -e eleven -e 12 -- app/src/services/extraction app/src/jobs/extraction.ts app/src/jobs/journalSweep.ts app/src/adapters/extraction.ts app/src/services/suggestionResolution.ts app/src/repos/suggestionResolutionRepo.ts app/src/routes/contacts.ts 'app/test/extraction*.ts' app/test/journalSweep.test.ts 'app/test/suggestion*.ts' app/test/aiRunVerdicts.test.ts dashboard/src/routes/settings/aiRuns dashboard/src/api/types.ts e2e/tests/dashboard-next/ai-run-log.spec.ts
```

Every hit, by reason (none is a stale count of the target or field sets):

- Updated by S3, now CORRECT counts (13 hits): adapters/extraction.ts:188
  (twelve field ops); routes/contacts.ts:1120 (twelve since B1);
  schema.ts:25 (twelve ... the eight original), :43 (twelve), :357 (twelve
  scalars); suggestionResolution.ts:33 (eleven since B1);
  extractionOps.test.ts:57 (twelve scalars); suggestionReclassification.test.ts:247
  (eleven tenant-only); dashboard/src/api/types.ts:2257 (twelve
  ExtractableField values); ai-run-log.spec.ts:144 (twelve declines), :146
  (other eleven declines), :152 (sixteen / twelve `fields`), :277 (twelve).
- The words "the eight ORIGINAL" (a named group, not the set's size; 3 hits):
  apply.ts:117, runTypes.ts:10, extractionApply.test.ts:1564 (S3.2's PIN
  name).
- S3's own new tests, correct by construction (4 hits):
  extractionSchema.test.ts:86, :91, :93 (eight -> twelve, `toHaveLength(12)`
  of EXTRACTABLE_FIELDS), :668 (the test NAME "no stale 'eight'").
- Dates "2026-10-12" / "2026-06-12" matched as the word `12` (25 hits):
  suggestionResolutionRepo.ts:165, :459, :468, :495, :862, :901;
  routes/contacts.ts:16, :1872, :2527; runTypes.ts:28;
  suggestionResolution.ts:228, :514, :822, :827, :901;
  aiRunVerdicts.test.ts:646; suggestionReclassification.integration.test.ts:1;
  suggestionReclassification.test.ts:1, :259;
  suggestionReclassificationGuard.test.ts:1, :156, :328;
  suggestionResolutionRepo.integration.test.ts:486;
  dashboard/src/api/types.ts:1838, :1843.
- The voucherSize range 0..12 (9 hits): routes/contacts.ts:623, :624, :916,
  :917; apply.ts:146, :147; suggestionResolution.ts:180;
  extractionApply.test.ts:306, :1131.
- The 12-hex prompt fingerprint (10 hits): prompt.ts:163, :176;
  extractionAdapter.test.ts:80; extractionSchema.test.ts:354, :358, :365;
  dashboard/src/api/types.ts:211; AiRunsSection.test.tsx:41;
  ai-run-log.spec.ts:269, :405.
- Fixture token counts / sizes (8 hits): extractionAdapter.test.ts:301, :306,
  :340, :359, :403, :423 (`input_tokens: 12`); AiRunsSection.test.tsx:26
  (`inputTokens: 12`, `chars: 12`), :170 ("12 input tokens").
- Item / task numbers (3 hits): suggestionResolution.ts:634, :641 ("item
  12"); suggestionResolutionRecovery.test.ts:2 ("Task 12").
- Unrelated domain words in dashboard/src/api/types.ts (3 hits): :2705
  ("12-month minimum" lease term), :2760 (bedrooms 0..12), :2789 ("The eight
  requirement items", property requirements).
- Plan "Do NOT touch" (3 hits): aiRunVerdicts.test.ts:2263 (quotes the frozen
  spec 7.3 text), journalSweep.test.ts:262 ("twelve rows" is that fixture's
  own count: six targets times two, :263-270),
  suggestionResolutionRecovery.test.ts:118 (`maxAttempts: 12` still exceeds
  the three journals it drives).

Total: 13 + 3 + 4 + 25 + 9 + 10 + 8 + 3 + 3 + 3 = 81 hits, all accounted for.

Not in the grep (moved or removed): the five WL-8 count words
(journalSweep.ts:231 and :253 "12-key", journalSweep.test.ts:513 "12
journals", suggestionResolutionRecovery.test.ts:17 "twelve keys",
extractionSchema.test.ts:577 "eight scalar fields") are fixed; the four
executable counts are derived or updated (SWEEP_MAX_ATTEMPTS_PER_CALL =
DECISION_TARGETS.length at journalSweep.ts:88; prompt.ts:54 counts
EXTRACTABLE_FIELDS.length; the schema `fields` block is built from
EXTRACTABLE_FIELDS at schema.ts:84-85; DECISION_TARGET_ORDER spreads the
mirror at AiRunDetail.tsx:46). An extra sweep for seven / thirteen / nine /
ninth / ten / eleven / 13 / 7 / 8 over the same paths plus
adapters/extractionFake.ts and e2e/support/selectors.md found no stale count
of these sets (the hits are dates, fixture values, section numbers, model
names, the historical "ninth target" and S3.1's own "join the seven" test
comment, which names the original group).

### WI13 - runTypes stays cycle-free

`app/src/services/extraction/runTypes.ts:6` is its ONLY import
(`../../lib/tenantMatchingInputs.js`); the header (:1-5) says so and names
the pin. The pin is app/test/extractionRunTypes.test.ts, case "stays
cycle-free: imports ONLY the tenant matching inputs leaf, which imports
nothing (B1 WI13)": the specifier list equals the one leaf, and the leaf has
no import line. RED before S3.1 (`[]`), green since.

### WI15 - the prompt fingerprint (shared with S4/S5)

The fingerprint changes in S3 (the schema gains four `fields` entries at
S3.3; the prompt text changes at S3.6) - expected. No test pins a literal:
every reader computes it (extractionAdapter.test.ts:198-240,
extractionSchema.test.ts:357-359). The run-log message hash is untouched:
`renderUtteranceLine` and the window builders were not edited by S3.

## Risks and notes

- WL-11 (E1-1, accepted residual, no code): the `text_field_filled` drop
  reads the run's contact SNAPSHOT (read at app/src/jobs/extraction.ts:452,
  before the message read and the model call) and apply commits every field
  write in one unconditional `contacts.update`
  (app/src/services/extraction/apply.ts:562). A staff fill of a text field
  landing during the model call is overwritten by the model's value and
  stamped `<key>_source` - the last-write-wins class pets and tenure already
  have. Filed: docs/issues/extraction-text-field-write-races-staff-fill.md.
- CURRENT PROFILE vs the drop rule on whitespace: `toProfile` keeps a
  whitespace-only stored text (its `str()` checks length only,
  jobs/extraction.ts:138-140), while apply treats it as empty
  (`isFilledText`, apply.ts:183-186). Both writers trim before storing (the
  staff parser and `coerceField`), so no such value is written today; noted,
  no code.
- A text `write` that is the SAME fact in a better form on a filled text
  field is now dropped (spec D3: "write" means fill an empty field and
  nothing else); the prompt says so (prompt.ts:98-99). A wording correction
  of staff text therefore needs staff or a `suggest`.
- D3-S3-7 (recorded): a portion suggestion is a bare integer string because
  apply suggests `String(value)` of the COERCED number; the "$1,200" accept
  test is reachable only through a hand-seeded suggestion and pins the shared
  coercion.
- Untrimmed input paths: none new. Extraction text is trimmed by
  `coerceField` before any write or suggestion; the accept path trims through
  the same function.
- The app suite prints ERROR log lines from test-simulated faults
  (`ProvisionedThroughputExceededException` thrown by stubs in
  importConvertGroups.test.ts and groupConvert.test.ts, "boom" in
  backfillMediaContentTypes.test.ts); pre-existing noise, every file passed,
  0 `[dynamoAdmin]` lines.

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, each prefixed
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL` (G1); dashboard runs from
`W:/tmp/wp1-b1-ranking-inputs/dashboard`; typecheck and lint from the
worktree root. Nothing piped; output redirected to
`.superpowers/sdd/s3-*.log`. DynamoDB Local was already running (G3); no
AWS_* variable is exported.

| Step | Command | Result |
|---|---|---|
| S3.1 RED | `npx vitest run test/extractionRunTypes.test.ts test/suggestionReclassification.test.ts test/suggestionReclassificationGuard.test.ts test/journalSweep.test.ts test/extractionJob.test.ts` | exit 1, 10 failed / 182 passed: 12 vs 16 targets, 13 vs 14 drop reasons, specifiers `[]`, seven vs eleven, the four new guard cases, sweep 12 vs 16, decisions length 12 vs 16 (stated reasons) |
| S3.1 GREEN | same | exit 0, 5 files / 192 tests |
| S3.1 | `npx tsc -p tsconfig.json --noEmit` (app); `npm run typecheck` (root) | exit 0; exit 0 |
| S3.2 RED | `npx vitest run test/extractionApply.test.ts` | exit 1, 5 failed / 96 passed: "coerceField is not a function" (stated reason) |
| S3.2 GREEN | same; `npx tsc -p tsconfig.scripts.json` | exit 0, 1 file / 101 tests; exit 0 |
| S3.2 | `npm run typecheck` | exit 0 |
| S3.3 RED | `npx vitest run test/extractionSchema.test.ts test/extractionOps.test.ts test/extractionApply.test.ts test/suggestions.test.ts test/tenantMatchingInputsReaders.test.ts` | exit 1, 17 failed / 173 passed: schema 4 (list eight, PROVENANCE missing the four, no entries, parser drops), ops 1 (absent), apply 6 (nothing reached), suggestions 6 (400 unknown_target x3, `_source` survives x2, WL-10 body); zero-optional PIN, dismiss PIN and readers pin green |
| S3.3 GREEN | same | exit 0, 5 files / 190 tests |
| S3.3 extra | delegation disabled, `npx vitest run test/suggestions.test.ts` | exit 1, 4 failed / 23 passed (divergence 3); restored |
| S3.3 GREEN + Step 4 | the five files plus suggestionReclassification, aiRunVerdicts, extractionDecisions, extractionJob | exit 0, 9 files / 408 tests |
| S3.3 | `npm run typecheck` | exit 0 |
| S3.4 RED | `npx vitest run test/extractionApply.test.ts` | exit 1, 2 failed / 110 passed: the first WROTE the field, the second became a demoted suggestion (stated reasons); three PINs green |
| S3.4 GREEN | `npx vitest run test/extractionApply.test.ts test/extractionDecisions.test.ts test/tenantMatchingInputsReaders.test.ts` | exit 0, 3 files / 129 tests |
| S3.4 | `npx tsc -p tsconfig.json --noEmit` (app) | exit 0 |
| S3.5 RED | `npx vitest run test/extractionJob.test.ts` | exit 1, 2 failed / 89 passed: profile carries only the named eight (stated reason); the omit case green (PIN) |
| S3.5 GREEN | `npx vitest run test/extractionJob.test.ts test/contactStaffNotes.test.ts test/tenantMatchingInputsReaders.test.ts` | exit 0, 3 files / 119 tests |
| S3.5 | `npm run typecheck` | exit 0 |
| S3.6 RED | `npx vitest run test/extractionSchema.test.ts` | exit 1, 5 failed / 42 passed: "of the 12 field entries" absent, no guidance lines, no accumulate head, no dollars line, the two examples present; "stays ASCII" green (PIN) |
| S3.6 GREEN | `npx vitest run test/extractionSchema.test.ts test/caseworkers.test.ts test/extractionAdapter.test.ts test/tenantMatchingInputsReaders.test.ts` | exit 0, 4 files / 160 tests |
| S3.6 | `npm run typecheck` | exit 0 |
| S3.7 RED | `npx vitest run src/routes/settings/aiRuns/AiRunsSection.test.tsx src/api/types.test.ts` | exit 1, 3 failed / 69 passed: the four ranked last, the fallback "text field filled", no label key (stated reasons); the 17-row case green |
| S3.7 GREEN | same; `npm run typecheck` (dashboard) | exit 0, 2 files / 72 tests; exit 0 |
| S3.7 | `npm run typecheck` (root) | exit 0 |
| S3.8 check | app: extractionDecisions, extractionOps, journalSweep, suggestionResolutionRecovery, extractionSchema, suggestionResolutionRepo.integration; dashboard: AiRunsSection.test.tsx; `npm run typecheck` (e2e) | exit 0, 6 files / 141 tests; exit 0, 1 file / 32 tests; exit 0 |
| S3.8 WI3 | the grep above | 81 lines, every hit reviewed (WI3) |
| S3.9 Step 1 | `npm run typecheck` | exit 0 |
| S3.9 Step 2 app | `npx vitest run` | exit 0, 539 files / 11485 passed, 1 skipped (S2 close 538 / 11440 + 1 skipped; +1 file, +45 tests = S3.1 5, S3.2 5, S3.3 21, S3.4 5, S3.5 3, S3.6 6); 0 `[dynamoAdmin]` lines |
| S3.9 Step 2 dashboard | `npx vitest run` | exit 0, 272 files / 5619 passed (S2 close 272 / 5618; +1, the S3.7 label case) |
| S3.9 Step 3 | `git diff -U0 main...HEAD -- app/src app/test app/scripts dashboard/src e2e/tests e2e/support`, added lines through `tr -d '\11\12\15\40-\176' \| wc -c`; the same over `8cd6feb5..HEAD`; the new readers test whole | 0; 0; 0 |
| S3.9 Step 4 | `npx eslint <the 30 .ts/.tsx files of git diff --name-only --diff-filter=d 8cd6feb5..HEAD>` | exit 0, no output - no errors, none pre-existing in these files |

Per-commit ASCII checks (added lines of each touched file; the new readers
test whole) all printed 0. Escape counts (`grep -cF` of the six-character
form, at 8cd6feb5 and at HEAD, every S3-touched file): the three `\u0000`
escapes in app/test/suggestions.test.ts and the two in
app/src/repos/suggestionResolutionRepo.ts are unchanged; every other touched
file holds none before or after.

## WORKLIST items applied

WL-6 (start gate), WL-7 (S3.3), WL-8 (S3.8), WL-9 (S3.8 half; the RUNBOOK
half is S6.7's WL-34), WL-10 (S3.3), WL-11 (recorded above). G1 (every app
vitest run), G2 (absolute worktree paths), G3 (no db:start), G4 (no event).
