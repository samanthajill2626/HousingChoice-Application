# S6a slice report - the never-written test, first half (WP1 B1)

Slice S6a: plan section 10, tasks S6.1, S6.1a and S6.2 (spec rev 10 D7).
Implementer: Claude Opus 5.5. S6_BASE = be5177a1 (the S5 close); merge base
with main d0e2c2d8. A second implementer builds S6.3-S6.10 on top of this.
Findings only; code cited by `file:line` at 809e5b3a.

## Commits

| Task | Commit | Subject |
|---|---|---|
| S6.1 | edd8e56a | feat(extraction): never-written probe data - cases with planted facts, controls, the grader prompt and schema, dated price table (b1 S6.1) |
| S6.1a | dfece14a | feat(extraction): structured-output client in the extraction adapter - the never-written grader's vendor call, sharing the driver's client, cap and thinking-off form (b1 S6.1a) |
| S6.2 | 809e5b3a | refactor(extraction): probe exports main behind an invokedDirectly guard, injectable deps, the gate argument contract (b1 S6.2) |
| report | (this commit) | docs(records): wp1 b1 S6a slice report |

## What the tree held that the plan got wrong

- Nothing beyond WL-25..WL-28 (applied below). No G4 event: every Edit
  anchor matched verbatim and uniquely on the first try.
- S6.1a's three anchors were verbatim at S6_BASE: the header line
  `//              extractionFake.ts; config refuses driver 'fake' in production).`
  (extraction.ts:11), the `thinkingOff` return line (:247), and the
  constructor's `new Anthropic(` line (:278). Now: `newAnthropicClient`
  app/src/adapters/extraction.ts:259, the driver uses it at :291, the client
  section :444-542 (`StructuredOutputRequest` :449, `StructuredOutputCall`
  :461, the class :476, `createStructuredOutputClient` :535).
- S6.2's line hints drifted exactly as D6a-S6-1 said (S3.2 grew
  `withRecorded` by three lines; S5.4 kept the count): at S6_BASE `fail()`
  :172-175, `judge` :211-219, `outcomeOf` :221-234, `pool` :236-247, `load`
  :250-252, dry run + table :295-348, `await main();` :351. The quoted text
  was the authority. Every moved block was DIFFED against the S6_BASE file
  and is byte-identical: the ten cases (CASES -> DEFAULT_CASES), `judge`,
  `outcomeOf`, `pool`, `load`'s body, the table loop (with only
  `console.log` -> `print`), and the dry-run loop (with only the stated
  substitutions: `console.log` -> `deps.print`, `buildInput(c, orgListBlock)`
  -> `buildInput(c, orgListBlock, sentBlock)`, `prompt.` -> `m.prompt.`).
- The SEAMS match the shipped S3-S5 code (no STOP): apply.ts:120 `Coerced`,
  :145 `coerceField(field, raw)`, :219 `NoteLineFilterInput` (modelLines,
  systemLines, floor, existingNotes, prefix, demoted), :239
  `NoteLineFilterResult` (append, modelCount, belowFloor, demoted), :283
  `filterNoteLines`; lib/config.ts:535
  `parseExtractionFactMinConfidence(raw: string | undefined): number`;
  services/extraction/sentPropertiesBlock.ts:38 `SENT_PROPERTIES_BLOCK_HEADER`,
  :53-57 `SentPropertyEntry { unit: PropertyLabelSource; sentAt; signedUp }`,
  :81 `selectSentRows(rows, max?)` over `Pick<ListingSendItem, 'unitId' |
  'sentAt' | 'shares'>`, :97 `renderSentPropertiesBlock(entries, opts?)` ->
  `{ text, fingerprint, labels, dropped, unlabeled }`; lib/propertyLabel.ts:60
  `propertyLabel(unit: PropertyLabelSource)`, :80 `labelMatches(line, label)`;
  adapters/extraction.ts:164 `ExtractionInput.sentPropertiesBlock: string`
  (required). `ExtractionProfileSnapshot` (:128) extends the list-mapped
  `TenantMatchingProfile` (:122), so cross-slice note 3 holds: the two
  case profiles use `area_preference` / `preferences_constraints` as
  written, no mapping. S6.2 USES only the S5 seams (`withSentBlock`,
  `sentRow`, `sentDisplay`, `renderSentBlock`, `labelOf`); the root
  typecheck (exit 0) proves they fit. The S4 seams (`filterNoteLines`,
  `factFloor`, `coerceField`) are first called in S6.3; checked by reading.

## Divergences (each deliberate)

1. Bindings that S6.2 does not use yet are LEFT OUT, per the plan's S6.2
   builder note ("if lint flags an unused import now, add it in the task
   that uses it instead"); `@typescript-eslint/no-unused-vars` is an error
   (eslint.config.mjs:30-38), and with them the S6.2 commit would carry 4
   new lint errors. Left out, each to be added VERBATIM by S6b in the task
   that first uses it:
   - app/scripts/extraction-prompt-probe.ts: `import { createHash } from 'node:crypto';`
     (plan line 12578) - put it as the first import, above
     `import { execFileSync } from 'node:child_process';` (:79). First use:
     S6.3 (the grader fingerprint and the case hash).
   - app/test/extractionPromptProbe.test.ts: `import { createHash } from 'node:crypto';`
     (plan 12259) - above `import { describe, expect, it } from 'vitest';`
     (:7). First use: S6.3's hash case.
   - same test, the helper (plan 12297-12299), right after `ok()` (:35-41):
     ```ts
     function failed(failure: 'refusal' | 'parse' | 'truncated' | 'driver'): ExtractionCall {
       return { ok: false, meta: { driver: 'fake' }, failure, message: `stub ${failure}` };
     }
     ```
     (with the blank line before it). First use: S6.3.
   - same test, `const BASELINE_ROOT = 'W:/probe-test/main';` (plan 12287),
     right after `const BRANCH_ROOT = 'W:/probe-test/branch';` (:33). First
     use: S6.5.
   Without them S6.3's RED would be red for the WRONG reason
   (`createHash` / `failed` not defined), so add them BEFORE running that
   RED.
2. The script header's `--out` entry gains two lines (:53-54): "With
   --baseline or --suite never-written only (refused on the plain default
   suite, which writes no record)." - the header now states WL-28's
   behavior (D6a-S6-4's "at minimum" note). No plan anchor quotes it.
3. The WL-28 refusal (:587-589) and its refuses-table row
   (extractionPromptProbe.test.ts:121-123) each carry a two-line comment
   naming WL-28.
4. `printDefaultTable`'s doc comment says "(the old main's table loop)",
   not "(the old main's :315-344)": a line reference into a function that
   no longer exists would rot.
5. The S6.2 commit carries one extra body line naming WL-25/26/28.

## WORKLIST items applied

- WL-25 (S6.2): the explicit dry-run loop, extraction-prompt-probe.ts:687-692,
  `deps.print(\`  ${m.prompt.renderUtteranceLine(u)}\`)` at :691; the PR52
  prints follow. The case 'a dry run needs no key and calls nothing' is
  green.
- WL-26 + G1: every app vitest run in S6a was prefixed
  `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL`. S6.2's RED was red for
  exactly the stated reason: vitest reported `process.exit unexpectedly
  called with "2"` from the old `fail()` (old :174), after
  `--model is required (or set AI_EXTRACTION_MODEL).` (old :270), reached
  through the old top-level `await main();` (old :351). No key was read and
  nothing was called.
- WL-27: app/test/structuredOutputClient.test.ts constructs the
  structured-output client AND the anthropic driver against its
  `vi.mock('@anthropic-ai/sdk')` stub (the construction case, :81-90) -
  allowed; no test touches the real SDK.
- WL-28: `if (!gated && values.out !== undefined) return { usage: '--out applies only with --suite never-written or --baseline' };`
  after the gated checks (:589), the refuses row
  `[['--model', 'claude-sonnet-5-5', '--out', 'r.md'], /--out applies only with/]`,
  and the header lines (divergence 2).
- G2 (absolute worktree paths everywhere), G3 (no db:start; DynamoDB Local
  already up), G4 (no event).

## Watch items

- WI16 (S6a's range), the five S6.10 Step 5 greps run at 809e5b3a:
  (1) `process.env.ANTHROPIC_API_KEY` over app/test app/scripts - no output,
  exit 1; (2) `driver: 'anthropic'` over the two probe test files - no
  output, exit 1; (3) `createStructuredOutputClient` over app/test
  app/scripts - only app/test/structuredOutputClient.test.ts lines (:32, :59,
  :61, :77, :82, :84, :93, :97, :98); the two probe-script lines PR56
  expects arrive with S6.4; (4) the `vi.mock('@anthropic-ai/sdk'` line,
  structuredOutputClient.test.ts:17; (5) `@anthropic-ai/sdk` over app/src
  app/scripts - only app/src/adapters/extraction.ts:4 (comment) and :20
  (the import). The probe tests inject `env` and `createDriver`; `main`
  reads the key only as `deps.env.ANTHROPIC_API_KEY`.
- WI1: the probe will drive production `filterNoteLines` / `coerceField`
  from S6.3 on; nothing in S6a re-implements a value rule.

## Risks and notes

- `withRecorded` names `max_tenant_portion` (plan text, :375). The readers
  pin (app/test/tenantMatchingInputsReaders.test.ts READERS) scans app/src
  only, so it does not trip, and no default case records a matching input,
  so the branch is unreachable today. Spec D1's "no reader names the four"
  is about production readers; flagged for review, not changed.
- Until S6.4 / S6.5 land, `--suite never-written` and `--baseline` reach
  placeholders that print "built in plan task S6.4/S6.5" and exit 1 after
  the usage and key checks, creating no driver.
- The probe test file imports the real adapter (and so the SDK module) to
  build the injected `BaseModules`; it constructs no client. `defaultDeps()`
  runs on every `main` call; its `env: process.env` is only a reference,
  replaced by every test's injected env.
- PRICE_TABLE values are unverified (PR39); the pin checks shape and date.
- The S6.2 `transcriptOf` changes the default suite's tsMsgIds from
  `probe-<i>` to `probe-<case id>-<i>`. tsMsgId is never rendered into the
  prompt (adapters/extraction.ts:37-44), so the request content is
  unchanged.

## What S6b must know

1. Add the four bindings of divergence 1 in the task that first uses each,
   before that task's RED run.
2. The plan's S6.3-S6.5 RED/GREEN commands lack the G1 prefix. Use
   `cd W:/tmp/wp1-b1-ranking-inputs/app; env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run test/extractionPromptProbe.test.ts`
   (the S6.10 dry run takes the same prefix).
3. Anchors verbatim at 809e5b3a: extraction-prompt-probe.ts:97
   `import { GATE_RUNS, type SentProperty } from './extractionProbeNeverWritten.js';`
   (S6.3 step a); :250 `// (S6.3 adds the S4 seams writtenLines and factFloor here.)`
   (S6.3 step b); `ProbeCliDeps` :604-617 and `defaultDeps()` :644, whose
   `createDriver` entry is :652-658 (S6.4 adds `createGrader` after each);
   :707 `// Placeholders - S6.4 and S6.5 replace these two bodies.` (WL-32:
   S6.5 deletes it), `runNeverWritten` placeholder :708-711, `runComparison`
   placeholder :712-715.
4. WL-28 is live: a test passing `--out` without `--suite never-written` or
   `--baseline` now gets exit 2. Every `--out` in the plan's S6.3-S6.5 code
   is gated (`NW`, `CMP`), so none is affected.
5. The test file header (imports, `base`, `branch`, `KEY`, `BRANCH_ROOT`,
   `ok`, `caseIdOf`, `Answer`, `Harness`, `harness`, `defaultCorrect`) is
   the plan's, minus divergence 1's three test bindings; S6.3-S6.5 append
   describes below :222.

## Commands run (exit codes, counts)

App runs from `W:/tmp/wp1-b1-ranking-inputs/app`, each prefixed
`env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL` (G1); typecheck and lint
from the worktree root. Nothing piped; output redirected to
`.superpowers/sdd/s6a-*.log` (gitignored). DynamoDB Local already running
(G3); no AWS_* variable exported (count 0).

| Step | Command | Result |
|---|---|---|
| S6.1 RED | `npx vitest run test/extractionProbeNeverWritten.test.ts` | exit 1, file fails to load: `Cannot find module '../scripts/extractionProbeNeverWritten.js'` - stated reason |
| S6.1 GREEN | same | exit 0, 1 file / 16 tests |
| S6.1 typecheck | `npm run typecheck` (root, bare) | exit 0 |
| S6.1a RED | `npx vitest run test/structuredOutputClient.test.ts` | exit 1, 11 failed: `createStructuredOutputClient is not a function` (the apiKey case: expected /apiKey/, got that TypeError) - stated reason |
| S6.1a GREEN | structuredOutputClient + extractionAdapter + tenantMatchingInputsReaders | exit 0, 3 files / 45 tests (11 + 32 + 2) |
| S6.1a typecheck | `npm run typecheck` | exit 0 |
| S6.1a SDK importer | `git grep -n "@anthropic-ai/sdk" -- app/src app/scripts` | extraction.ts:4 and :20 only |
| S6.2 RED | `npx vitest run test/extractionPromptProbe.test.ts` | exit 1, suite fails to load: `process.exit unexpectedly called with "2"` from the old `fail()` - stated reason (WL-26) |
| S6.2 GREEN | same | exit 0, 1 file / 23 tests (12 refuses rows + 1 accepts + 4 usage + 6 default) |
| S6.2 typecheck | `npm run typecheck` | exit 0, 0 `error TS` |
| S6.2 moved-block proof | `diff` of each moved block, S6_BASE file vs new file | all 7 identical (substitutions applied to the old side) |
| slice close | the 3 new test files + extractionAdapter + tenantMatchingInputsReaders | exit 0, 5 files / 84 tests |
| slice close lint | `npx eslint` on the 6 touched files | exit 0, no output |
| ASCII | `tr -d '\11\12\15\40-\176'` on each new file; added lines of extraction.ts and the probe; added lines of `git diff -U0 be5177a1 -- app` | 0 each |
| escapes | `grep -cF '\u'` on the 6 touched files, before and after | 0 / 0 each |
| WI16 | the five S6.10 Step 5 greps | as listed under Watch items |
