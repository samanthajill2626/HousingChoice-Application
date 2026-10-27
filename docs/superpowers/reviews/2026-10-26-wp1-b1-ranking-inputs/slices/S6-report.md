# S6 slice report - the never-written test, the fake driver and the docs (WP1 B1)

Slice S6: plan section 10, tasks S6.1-S6.10 (spec rev 10 D7; spec 4 Docs
bullet). Built in two halves by two implementers (Claude Opus 5.5):
S6a = S6.1, S6.1a, S6.2 (its own report:
`slices/S6a-report.md` - divergences, seams at 809e5b3a, WI16 at that
point); S6b = S6.3-S6.10 (this report). S6_BASE = be5177a1 (the S5 close);
merge base with main d0e2c2d8. Findings only; code cited by `file:line` at
74987aa3 (the S6.9 commit - the report commit adds only this file).

## Commits

| Task | Commit | Subject |
|---|---|---|
| S6.1 | edd8e56a | feat(extraction): never-written probe data - cases with planted facts, controls, the grader prompt and schema, dated price table (b1 S6.1) |
| S6.1a | dfece14a | feat(extraction): structured-output client in the extraction adapter - the never-written grader's vendor call, sharing the driver's client, cap and thinking-off form (b1 S6.1a) |
| S6.2 | 809e5b3a | refactor(extraction): probe exports main behind an invokedDirectly guard, injectable deps, the gate argument contract (b1 S6.2) |
| S6a report | fc33f164 | docs(records): wp1 b1 S6a slice report |
| S6.3 | 7b83a980 | feat(extraction): never-written scoring through the production filters, the grader request and answer, verdicts, cost and the record (b1 S6.3) |
| S6.4 | c74743cb | feat(extraction): probe --suite never-written - 3 runs per case through production code, one grader call per run, the record, the exit code (b1 S6.4) |
| S6.5 | 16afe6b1 | feat(extraction): probe --baseline compares the default suite branch vs main with the D7 thresholds and one re-run (b1 S6.5) |
| S6.6 | 99d95d51 | docs(extraction): fake driver documents the b1 payloads; pin that it passes them through verbatim (b1 S6.6) |
| S6.7 | 2a680697 | docs(runbook): extraction after b1 - demoted runs append no line, sonnet-5-5, the fact floor, feedback lines, the probe gate and its grader (b1 S6.7) |
| S6.8 | 261feea6 | docs(env): EXTRACTION_FACT_MIN_CONFIDENCE=0.7 in the three env templates, uncommented with its default (b1 S6.8) |
| S6.9 | 74987aa3 | docs(glossary): tenant matching inputs, Notes line, feedback line, Preferences & notes vs Preferences and constraints (b1 S6.9) |
| S6.10 | (this commit) | docs(records): b1 S6 slice report |

## What the tree held that the plan got wrong

- Nothing that stopped the build; no STOP condition hit, no G4 event (every
  S6b Edit anchor matched verbatim and uniquely on the first try).
- The plan's S6.3-S6.5 RED/GREEN commands and S6.10 Step 6 lack the full G1
  prefix (Step 6 has `-u ANTHROPIC_API_KEY` only). Every run here used
  `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL` (WORKLIST G1).
- The plan keeps two bindings unused for one task: `GATE_RUNS` in S6.3's
  test import and `NEVER_WRITTEN_CASES` in S6.3's script import. With
  `@typescript-eslint/no-unused-vars` an error (eslint.config.mjs:30-38),
  the S6.3 commit would carry 2 lint errors. Moved to S6.4 (divergence 1).
- The items D6b-S6-1..-4 and -6 and D3-S3-4 found (WL-29..WL-34) - applied
  below.

## Divergences (each deliberate)

1. Lint-clean at every commit (the S6a precedent, S6a-report.md
   divergence 1): `GATE_RUNS` is imported by the S6.4 block,
   `import { GATE_RUNS, GRADER_ITEMS_HEADER } from '../scripts/extractionProbeNeverWritten.js';`
   (app/test/extractionPromptProbe.test.ts:673), not by S6.3's import list;
   `NEVER_WRITTEN_CASES` joined the script's data-module import in S6.4 (the
   plan's own S6.3 builder note allows this). The end state differs from
   the plan's only in which import statement carries `GATE_RUNS`.
2. S6a's four left-out bindings, added verbatim where its report says:
   test `import { createHash } from 'node:crypto';` (:7) and `failed()`
   (:47-49) BEFORE S6.3's RED; `const BASELINE_ROOT = 'W:/probe-test/main';`
   (:37) BEFORE S6.5's RED; the script's `createHash` import
   (app/scripts/extraction-prompt-probe.ts:88, first import) with S6.3's
   implementation (an unused script import cannot change the test's RED
   reason; its first users are `graderPromptFingerprint` and `contentHash`).
3. WL-33 is written as a `passText` constant
   (extraction-prompt-probe.ts:1092-1094) feeding the Verdict line, not a
   nested ternary; the wording is D6b-S6-6's, verbatim.
4. WL-31's lead sentence is wrapped over two comment lines
   (app/src/adapters/extractionFake.ts:20-21) to the header's width; the
   text is verbatim.
5. WL-30's inserted sentence keeps each WARN string whole on one line
   (RUNBOOK.md:1484-1487), so an operator can grep the RUNBOOK for the exact
   log message; prose around it is wrapped to the section width. The rest of
   Edit 5 is the plan's text as given (including its one long
   never-written-list line).
6. WL-29's added assertion carries a two-line comment naming WL-29
   (extractionPromptProbe.test.ts:837-839). Commit bodies name the WORKLIST
   items each applies.

## WORKLIST items applied

- WL-29 (D6b-S6-1): extractionPromptProbe.test.ts:839 pins
  `control-feedback-yes: control met in 0 of 3 runs (needs 2)`. The case
  was RED at S6.4's RED step (it read `h.records[0]` of an empty record
  list), where the plan's exit-code-only form would have been green.
- WL-30 (D6b-S6-2): RUNBOOK.md:1481 "newest 20, at most 4,000 characters";
  :1484-1487 the WARN sentence with both messages, checked against
  app/src/jobs/extraction.ts:655 and :661 (logged with counts only).
- WL-31 (D6b-S6-3): the payload block sits after S4.7's last line
  (extractionFake.ts:18), :20-32, opening with the shorter lead sentence.
- WL-32 (D6b-S6-4): the line `// Placeholders - S6.4 and S6.5 replace these
  two bodies.` is gone (`grep -n "Placeholders"` on the script: no output,
  exit 1).
- WL-33 (D6b-S6-6): a passing `--case` record reads
  `PASS on every automatic check (PARTIAL - one case, not a gate run; no sign-off)`.
  No test change (none pins it; the PARTIAL test still passes).
- WL-34 (D3-S3-4): RUNBOOK.md:1635 "the twelve scalar profile fields (the
  eight intake fields and the four tenant matching inputs)"; RUNBOOK.md:614
  the tenant-only accept list adds the four (checked against
  app/src/services/extraction/runTypes.ts:37-41 TENANT_ONLY_TARGETS and
  app/src/services/suggestionResolution.ts:835-838).
- WL-28 (S6a): live; every `--out` in S6.3-S6.5's tests is gated (`NW`,
  `CMP`), none refused.
- G1 (every app vitest run and the dry run), G2 (absolute paths and
  `git -C` throughout), G3 (no `db:start`), G4 (no event).

## Seams as delivered (cross-slice notes 1-4)

- S4.2: `filterNoteLines(input: NoteLineFilterInput): NoteLineFilterResult`
  app/src/services/extraction/apply.ts:283; input :219 (`modelLines`,
  `systemLines`, `floor`, `existingNotes`, `prefix`, `demoted`), result
  :239 (`append`, `modelCount`, `belowFloor`, `demoted`). The probe calls it
  ONCE, in `writtenLines` (extraction-prompt-probe.ts:301), with
  `systemLines: []`, `prefix: PROBE_NOTE_PREFIX` ('[Auto - Oct 20]', :286),
  `demoted: false`, reading `append.slice(0, modelCount)` and `belowFloor`.
  The "current address" postal filter is INSIDE `filterNoteLines`
  (apply.ts:285 `isPostal`): no gap.
- S4.1 floor: `factFloor` (:317) calls
  `parseExtractionFactMinConfidence(raw: string | undefined): number`
  (app/src/lib/config.ts:535); blank or absent = 0.7, '1.5' throws (test).
- S5: `SENT_BLOCK_PATH` = app/src/services/extraction/sentPropertiesBlock.ts;
  `selectSentRows(rows, max?)` :81, `renderSentPropertiesBlock(entries,
  opts?)` :97 read as `.text`, `SentPropertyEntry { unit, sentAt, signedUp }`
  :53; the block rides in the REQUIRED `ExtractionInput.sentPropertiesBlock`
  (app/src/adapters/extraction.ts:164). `propertyLabel(unit:
  PropertyLabelSource)` (app/src/lib/propertyLabel.ts:60) is called with
  `{ address }` (`labelOf`, extraction-prompt-probe.ts:275);
  `labelMatches(line, label)` (:80) decides the feedback controls. S6.4's
  test proves the flyer row renders "signed up", newest first, and that
  production's user content carries the block verbatim.
- S3: `coerceField(field: ExtractableField, raw: string | undefined): Coerced`
  apply.ts:145 (`Coerced` :120), called once, in `evaluateRun`
  (extraction-prompt-probe.ts:847). `ExtractionProfileSnapshot`
  (adapters/extraction.ts:128) extends the list-mapped
  `TenantMatchingProfile` (:122): the case profiles use the list keys as
  written, no mapping.
- The root typecheck (exit 0) proves every seam fits.

## The grader seam

- `createStructuredOutputClient` app/src/adapters/extraction.ts:535
  (S6.1a). The driver and the client share `newAnthropicClient` (:259;
  driver :291, client :481), `MAX_OUTPUT_TOKENS` (:226; :308, :490) and
  `thinkingOff` (:254; :309, :491).
- The probe's one `createGrader` default: extraction-prompt-probe.ts:1370
  (the `ProbeCliDeps` member :1323). The one `safeGrade` call: :1468
  (`safeGrade` :1209 - a throwing grader is an ungraded run).
- The dry run printed grader prompt fingerprint `5887c5904d61` and
  extraction prompt fingerprint `436f91b01983`.

## Watch items

- WI1 (S6 part): the probe filters lines ONLY through production
  `filterNoteLines` (the one call, :301) and fields ONLY through production
  `coerceField` (the one call, :847); it re-implements no value rule. The
  fake driver passes payloads verbatim: the S6.6 PIN
  (app/test/extractionAdapter.test.ts, describe 'fake driver carries the
  WP1 B1 outputs through verbatim') was green on arrival.
- WI16, S6.10 Step 5 at 74987aa3:
  1. `process.env.ANTHROPIC_API_KEY` over app/test app/scripts - no output,
     exit 1.
  2. `driver: 'anthropic'` over the two probe test files - no output, exit 1.
  3. `createStructuredOutputClient` over app/test app/scripts - exactly TWO
     probe-script lines (PR56): the header comment
     extraction-prompt-probe.ts:22 and the `defaultDeps` line :1370; the
     rest are app/test/structuredOutputClient.test.ts (:32, :59, :61, :77,
     :82, :84, :93, :97, :98), whose SDK is stubbed.
  4. structuredOutputClient.test.ts:17 `vi.mock('@anthropic-ai/sdk', ...`.
  5. `@anthropic-ai/sdk` over app/src app/scripts - only
     app/src/adapters/extraction.ts:4 (comment) and :20 (the import).
  The injection points: `harness` (extractionPromptProbe.test.ts:68; stub
  `createDriver` :82, fake `KEY` through the injected `env`) and
  `nwHarness` (:691; stub `createGrader` :693). Every never-written CLI test
  uses `nwHarness`; `main` reads the key only as `deps.env.ANTHROPIC_API_KEY`.
  No key, `ANTHROPIC_API_KEY`, `AI_EXTRACTION_MODEL` or `AWS_*` variable was
  exported in this environment (counted, never printed).

## Planner decisions (section 10, 1-13) as applied

1. `--baseline` (default) - S6.2 parse, S6.5 `runComparison` (:1496);
   `--repo` keeps its meaning.
2. Every case needs 2 of 3 runs scored AND graded - `judgeCase` (:956) with
   `MIN_GRADED_RUNS`; tested for excluded cases and controls.
3. The no-address control passes at 2 of 3 (`CONTROL_MIN_PASSES`, every
   control) - tested.
4. No banned-word lists; ONE grader call per run; a line judged excluded
   fails any case; a field value judged excluded is reported only; the
   grader judges the RAW proposed value and the record prints raw and
   coerced; no overrule mechanism (the Sign-off line says how).
5. The four commented `.env.example` extraction defaults are uncommented
   (S6.8); they equal the local code defaults (config.ts:845-939).
6. The record APPENDS a section per run (S6.2 `appendRecordFile`).
7. A branch-side truncation fails the comparison (`compareDefaultSuites`,
   :627) - tested.
8. The dry run ran ONCE with the key unset (Step 6 below).
9. The grader's vendor call is `createStructuredOutputClient` in the one
   SDK file (S6.1a); the grader prompt stays in the data module.
10. A run with nothing to judge makes no call and counts as graded
    (`grading: 'not-needed'`).
11. An excluded verdict with no known kind is kept as `unspecified`; any
    other malformed answer leaves the run ungraded; a missing reason reads
    "(no reason given)" (`parseGraderOutput`) - tested.
12. A grader refusal or truncation is an UNGRADED run, never a gate
    truncation: `applyGrade` sets `graderFailure`, and `judgeCase` counts
    only the extraction call's `failure === 'truncated'`.
13. Grader prompt content is S6.1's; planted facts are printed in the
    record and are not hashed (`contentHash` hashes only production
    `buildExtractionUserContent`).
None was changed by the planner after dispatch.

## Risks and notes

- The CLI's closing line on a passing `--case` run still says "The gate
  still needs Cameron's written sign-off in the record"
  (extraction-prompt-probe.ts:1491), while the record now says PARTIAL, no
  sign-off (WL-33). WL-33 names the record only; left as planned.
- `withRecorded` names `max_tenant_portion` (S6a risk, unchanged): the
  readers pin scans app/src only, and no default case records a matching
  input.
- PRICE_TABLE values are unverified (PR39); the record's cost is
  informational and no verdict reads it (tested).
- THE GATE IS NOT RUN (PR1): `never-written-test.md` does not exist on the
  branch (`ls` exit 2; `git ls-files` empty). The commands are plan section
  10's "Gate-run commands" subsection; S7.6 writes Cameron's sheet.
- [PR37] No `secrets:sync` handback item (PR22: not a handback
  obligation). A real `.env.*` without the key, or with it blank (a sync
  writes `EXTRACTION_FACT_MIN_CONFIDENCE=` empty), reads as the 0.7 default
  (config.ts:535, :939); no agent edited a real `.env.*` - only the three
  committed templates (.env.example:200, .env.dev.example:232,
  .env.prod.example:257), each LF, the key on no denylist
  (scripts/lib/secretsCore.mjs:11 MANAGED_BY_OTHERS).
- `.env.example` now carries the four extraction defaults uncommented; a
  developer who copies it to `.env` gets the code defaults, so local
  behavior is unchanged.

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, each prefixed
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL` (G1); typecheck and lint
from the worktree root. Nothing piped into a gate; output redirected to
`.superpowers/sdd/s6b-*.log` (gitignored). DynamoDB Local already running
(G3).

| Step | Command | Result |
|---|---|---|
| S6.3 RED | `npx vitest run test/extractionPromptProbe.test.ts` | exit 1, file fails at load: `TypeError: (0 , sentLabels) is not a function` - stated reason |
| S6.3 GREEN | same | exit 0, 1 file / 64 tests (23 S6.2 + 41 S6.3) |
| S6.3 typecheck / lint | `npm run typecheck`; `npx eslint` on the 2 files | exit 0 (0 `error TS`) / exit 0 |
| S6.4 RED | same vitest | exit 1, 17 failed / 64 passed: the placeholder returns 1 and calls nothing (`expected 1 to be +0`, no inputs, no grader requests, no record) - stated reason |
| S6.4 GREEN | same | exit 0, 81 tests |
| S6.4 typecheck / lint | as above | exit 0 / exit 0 |
| S6.5 RED | same vitest | exit 1, 9 failed / 81 passed: `compareDefaultSuites is not a function` (4) and the placeholder's exit 1 (5) - stated reason |
| S6.5 GREEN | same | exit 0, 90 tests |
| S6.5 typecheck / lint | as above | exit 0 / exit 0 |
| S6.6 PIN | `npx vitest run test/extractionAdapter.test.ts` | exit 0, 33 tests (green on arrival) |
| S6.6 after comment | `npx vitest run test/tenantMatchingInputsReaders.test.ts test/extractionAdapter.test.ts`; typecheck; lint | exit 0, 2 files / 35 tests; exit 0; exit 0 |
| S6.7 checks | RUNBOOK added-line ASCII; grep "never demoted"; grep the old "currently set claude-sonnet-5." line; grep "banned"; grep "unset or blank" | 0; none; none; only "no banned-word lists"; the new row |
| S6.8 checks | templates added-line ASCII; `grep -c "^EXTRACTION_FACT_MIN_CONFIDENCE=0.7$"` | 0; 1 per file |
| S6.9 check | GLOSSARY added-line ASCII; labels vs app/src/lib/tenantMatchingInputs.ts:40-70 | 0; match |
| S6.10 Step 1 | `npm run typecheck` (bare) | exit 0, 0 `error TS` |
| S6.10 Step 2 | `npx eslint` on the 8 slice files | exit 0, no output |
| S6.10 Step 3 | `npx vitest run` (app workspace, once) | exit 0, 545 files passed; 11710 tests passed, 1 skipped (11711); 62.99s. No `[dynamoAdmin]` line (the two "dynamoAdmin" hits are dynamoAdminRetry.test.ts names) |
| S6.10 Step 4 | `git diff -U0 be5177a1 -- app RUNBOOK.md documentation .env.example .env.dev.example .env.prod.example`, added lines through `tr` | 0 |
| S6.10 Step 5 | the five WI16 greps | as under Watch items |
| S6.10 Step 6 | `npx tsx app/scripts/extraction-prompt-probe.ts --suite never-written --model claude-sonnet-5-5 --dry-run` (once, key unset) | exit 0; key "(not set)"; grader `5887c5904d61`, prompt `436f91b01983`, floor 0.7; the PROPERTIES SENT block with 3 labels (Peachtree "signed up" first); the grader system prompt (9 kind descriptions, the NOT EXCLUDED list); 29 cases, 11 with `planted none`, 29 16-hex hashes; "Dry run: nothing was sent."; output ASCII. It ran while the app-workspace suite ran in the background (both local, no network) |
| escapes | `grep -cF '\u'` on every S6b-touched source file | 0 each; `\n` / `\x09` literals verified present after each edit |
