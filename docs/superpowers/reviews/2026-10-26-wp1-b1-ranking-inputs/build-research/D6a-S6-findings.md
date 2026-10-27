# D6a-S6 findings - plan section 10 preamble, S6.1, S6.1a, S6.2

Reader D6a-S6 checked plan lines 1-515 (binding sections 0-4), 10921-11137
(the section 10 preamble: contradictions, cross-slice SEAMS notes 1-8,
planner decisions 1-13, setup notes) and 11138-13141 (tasks S6.1, S6.1a,
S6.2), plus the probe edits S3.2 (plan 4054-4319) and S5.4 (plan 8925-9255)
that land on `app/scripts/extraction-prompt-probe.ts` before S6.2 rewrites
it. Tree: worktree branch HEAD ede08552, whose app/, dashboard/, e2e/,
scripts/, eslint.config.mjs, tsconfig.base.json and package.json are
byte-identical to main @d0e2c2d8 (`git diff --stat d0e2c2d8 HEAD` over those
paths is empty). Checked against the live tree: every name, import, export
and type the three tasks' code and tests call; the S6.1a anchors in
`app/src/adapters/extraction.ts`; the installed `@anthropic-ai/sdk` 0.129.0
types for the structured-output request shape; the tsconfig and eslint
coverage of the new files; the S3/S4/S5 planned APIs the SEAMS name; WI16.
Nothing was run (no test, typecheck, lint or script). Two MINOR findings and
two NOTEs; no BLOCKER, no MAJOR.

## D6a-S6-1 - MINOR - S6.2's "verbatim" dry-run loop still calls the old main()'s local `prompt`

- Plan location: Task S6.2 Step 2, the "Anchors kept from the current file"
  paragraph (plan 12492-12499), the `runDefault` dry-run placeholder
  (13044-13049), and the builder note "copy it verbatim and apply only the
  stated substitution" (13107-13110).
- What the plan says: move "the old dry-run loop (:293-298), console.log ->
  deps.print, buildInput(c, orgListBlock, sentBlock)" into `runDefault`;
  those two substitutions are the only ones stated.
- What the tree holds: `app/scripts/extraction-prompt-probe.ts:297` is
  `for (const u of input.transcript) console.log(\`  ${prompt.renderUtteranceLine(u)}\`);`
  where `prompt` is a local of the old `main()` (:276). The rewritten script
  has no `prompt` binding anywhere (only `type PromptModule` and the
  `BaseModules.prompt` member, reached as `m.prompt` - e.g. the plan's own
  `m.prompt.extractionPromptFingerprint()` at 13042). Copied as instructed,
  `npm run typecheck` fails (TS2304 "Cannot find name 'prompt'" under
  app/tsconfig.scripts.json and tsconfig.test.json), and vitest (no
  typecheck) throws a ReferenceError inside `runDefault`, which `main`'s
  catch turns into exit 1 - so the S6.2 test "a dry run needs no key and
  calls nothing" (12431-12436, expects 0) is red at GREEN. S6.4's own
  never-written dry-run loop already writes it correctly
  (`m.prompt.renderUtteranceLine(u)`, plan 14631).
- Correction: in S6.2 Step 2 replace the placeholder comment
  `// ... the old dry-run loop (:293-298), console.log -> deps.print, buildInput(c, orgListBlock, sentBlock) ...`
  with the explicit loop (the two PR52 prints after it stay as written):

  ```ts
      for (const c of cases) {
        const input = buildInput(c, orgListBlock, sentBlock);
        deps.print(`\n[${c.id}] ${c.about}`);
        deps.print(`  ${c.field}: recorded ${c.recorded ?? '(blank)'}, supports ${c.supports ?? '(nothing new)'}`);
        for (const u of input.transcript) deps.print(`  ${m.prompt.renderUtteranceLine(u)}`);
      }
  ```

  and add "`prompt.` -> `m.prompt.`" to the stated substitutions in the
  "Anchors kept" paragraph. (Line hints there are against main @d0e2c2d8;
  after S3.2's withRecorded edit, which grows :187-192 by three lines, the
  moved blocks sit at judge :211-219, outcomeOf :221-234, pool :236-247,
  load :250-252, dry-run/table :290-348, `await main();` :351. S5.4's edit
  keeps the line count.)

## D6a-S6-2 - MINOR - S6.2's RED step imports the pre-refactor probe, whose top-level main() can read the key and call the real model

- Plan location: Task S6.2 Step 1, RED command and reason (plan
  12480-12488); section 10 setup note (11127-11134); WI16 (182-183); PR1
  (187-193).
- What the plan says: RED is
  `cd W:/tmp/wp1-b1-ranking-inputs/app; npx vitest run test/extractionPromptProbe.test.ts`,
  red because importing the script "runs its top-level `await main()` ...
  whose `fail()` calls `process.exit(2)`".
- What the tree holds: at RED time the script is still the old one (plus
  S3.2/S5.4). `app/scripts/extraction-prompt-probe.ts:348` `await main();`
  runs on import. `main()` takes the model from
  `values.model ?? process.env.AI_EXTRACTION_MODEL` (:266) and exits 2 only
  when that is empty (:267). If the shell exports `AI_EXTRACTION_MODEL` it
  reads `process.env.ANTHROPIC_API_KEY` (:268); if that is exported too it
  builds the anthropic driver and makes 5 runs x 10 cases = 50 real calls
  (:303-313). vitest workers inherit the shell environment
  (`app/vitest.config.ts` `test.env` only adds keys). So the stated RED is
  safe only in a shell that exports neither variable; in one that carries
  both (the gate-run shell Cameron prepares for section 11, or any session
  that exported AI_EXTRACTION_MODEL for a dev loop) the RED step is an
  agent-run real-model probe - exactly what PR1 and WI16 forbid. The plan
  guards the S6.10 dry-run with `env -u ANTHROPIC_API_KEY` (plan 15497) but
  not this step.
- Correction: make the S6.2 RED command
  `cd W:/tmp/wp1-b1-ranking-inputs/app; env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL npx vitest run test/extractionPromptProbe.test.ts`
  and append to the RED reason: "Both variables are unset for this run, so
  the pre-refactor script's top-level main() stops at `--model is required`
  (process.exit(2), which vitest reports) and can neither read a key nor
  reach the API." (The GREEN run needs no prefix: the rewritten script has
  no top-level effect and every test injects its own env.)

## D6a-S6-3 - NOTE - The setup note forbids "construct the anthropic driver" in any S6 test; S6.1a's construction case does so against the stub

- Plan location: section 10 setup notes (plan 11127-11131) vs Task S6.1a
  Step 1, case "constructs the SDK client exactly as the extraction driver
  does" (11988-11997).
- What the plan says: "No S6 test may read `process.env.ANTHROPIC_API_KEY`,
  construct the anthropic driver, or construct the structured-output client
  against the real SDK (WI16)."
- What the tree holds / plan holds: S6.1a's case calls
  `createExtractionDriver({ driver: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'sk-test' })`
  under `vi.mock('@anthropic-ai/sdk')` - safe, and the same thing
  `app/test/extractionAdapter.test.ts:280` and `:362` already do. S6.10
  Step 5's `driver: 'anthropic'` grep is scoped to the two probe test files
  (plan 15478), so the gate check stays clean. Only the note's wording
  conflicts; a literal builder or reviewer could drop the case or flag it as
  a WI16 breach.
- Correction: reword the note to "No S6 test may read
  `process.env.ANTHROPIC_API_KEY`, or construct the anthropic driver or the
  structured-output client against the REAL (unmocked) SDK (WI16).
  `app/test/structuredOutputClient.test.ts` (S6.1a) constructs both against
  its `vi.mock('@anthropic-ai/sdk')` stub, which is allowed."

## D6a-S6-4 - NOTE - `--out` is accepted and silently ignored on the plain default suite

- Plan location: Task S6.2 Step 2 - header `--out` line (plan 12553),
  `parseProbeArgs` (12916-12959), `runDefault` (13028-13059).
- What the plan says: the header documents `--out` as "APPEND this run's
  record (Markdown) to the file, creating it" with no mode restriction, and
  S6.2 claims "the full argument contract for all three modes".
- What the plan code does: `parseProbeArgs` returns `out` for a plain
  default run (no `--baseline`, no `--suite never-written`) and `runDefault`
  never writes a record. A gate command typed without `--baseline`
  (`--model claude-sonnet-5-5 --out never-written-test.md`) runs the plain
  5-run suite, exits 0 or 1, and writes nothing, with no message. Not a spec
  requirement either way (spec D7 names `--out` for the gate runs only).
- Correction (optional): in `parseProbeArgs`, after the `gated` checks, add
  `if (!gated && values.out !== undefined) return { usage: '--out applies only with --suite never-written or --baseline' };`
  plus a row in the S6.2 "refuses %j" table:
  `[['--model', 'claude-sonnet-5-5', '--out', 'r.md'], /--out applies only with/],`
  - or, at minimum, scope the header line to "(never-written and --baseline
  only)".

## Verified with no finding

- S6.1a vs the installed SDK: `node_modules/@anthropic-ai/sdk/package.json`
  is 0.129.0 (app/package.json `^0.129.0`). `resources/messages/messages.d.ts`:
  `MessageCreateParamsBase` has `max_tokens` (:3506), `output_config?:
  OutputConfig` (:3611), `system?: string | Array<TextBlockParam>` (:3651),
  `thinking?: ThinkingConfigParam` (:3669); `OutputConfig.format?:
  JSONOutputFormat | null` with `{ type: 'json_schema'; schema: { [key:
  string]: unknown } }` (:1886-1894, :2108-2121); `ThinkingConfigParam`
  includes `{ type: 'between_tools' }` and `{ type: 'disabled' }`
  (:2475-2480, :2514). `Record<string, unknown>` fits the schema field. The
  request shape is the one the live driver already sends
  (extraction.ts:259-266), so it typechecks the same way; the narrowing
  pattern `Awaited<ReturnType<typeof this.client.messages.create>>` + `message?.usage`
  is copied from the driver (:257, :278). claude-api skill (cached
  2026-10-06) agrees: structured outputs via `output_config.format`,
  supported on Sonnet 5.5 / Sonnet 5 / Opus 4.8; `enum`, arrays of objects,
  `additionalProperties: false` all supported (the grader schema uses
  nothing unsupported); Sonnet 5.5 off-form is `between_tools` (no other
  field), Sonnet 5 and Opus 4.8 accept `disabled` - matching `thinkingOff`
  (extraction.ts:210-214).
- S6.1a anchors: header line `//              extractionFake.ts; config refuses driver 'fake' in production).`
  (extraction.ts:11), the `thinkingOff` return line (:213), and the
  constructor line (:244) are verbatim and unique; no S3-S5 task edits them
  (S3.2 edits :12-23/:46-54, S3 the profile type and the MAX_OUTPUT_TOKENS
  comment, S4.3 :87, S5.4 :113-123; the plan's other "config refuses driver
  'fake'" edits are in extractionFake.ts). `MAX_OUTPUT_TOKENS` and
  `thinkingOff` are module-level, so the new class can use them.
- S6.1a test: the `vi.hoisted` + `vi.mock('@anthropic-ai/sdk', () => ({ default: class ... }))`
  + `await import(...)` + `import type` pattern matches
  extractionAdapter.test.ts:8-26; vitest isolates per file (no `isolate:
  false` in app/vitest.config.ts). Every case's assertion matches the
  implementation's exact keys/messages (no-usage, no-content, no-text,
  truncation `4096-token output cap`, thrown error, refusal with and
  without usage, `toThrow(/apiKey/)`); the `it.each` rows infer tuples under
  vitest 3.2.6's `<T extends any[] | [any]>` overload, so `message` is a
  RegExp. RED reason is accurate.
- S6.1 data module and test: every assertion passes against the module as
  written (kind order, 9 x {free, feedback}, street-name presence matches
  setting for all 18 excluded texts, all 18 planted facts match
  `/^The tenant\b.*\.$/` and are distinct, CONTROL_IDS order, field/line
  examples meet their patterns, labels `412 Oak Ave, Decatur` /
  `88 Birch Ln Apt 3, Tucker` / `1530 Peachtree Rd, Atlanta` distinct and
  `labelMatches` attaches every feedback gist, the untied example matches
  no label, every pinned grader phrase is a substring of
  GRADER_SYSTEM_PROMPT, the schema has exactly two closed all-required
  object levels, `buildGraderUserContent` splits into the four expected
  lines). PR58: `sex` description names sexual orientation and gender
  identity, the pin test checks both, the feedback case plants sexual
  orientation, the free case keeps "a woman living alone". PR54 NOT
  EXCLUDED list fully present. PR39: rows carry the unverified comment, the
  pin checks shape/date only; the values (2/10, 2/10, 5/25) equal the
  claude-api skill's cached 2026-10-06 list prices. Type-only imports
  (`ExtractionProfileSnapshot`, `TranscriptUtterance`,
  `TenantMatchingInputKey`) exist or are added by S1/S3. Plan range has no
  non-ASCII byte and no `\u` escape (two `\x` regex escapes, a form the repo
  already carries, e.g. app/test/messageCatalogAscii.test.ts:16).
- S6.2 vs the template: `export async function main(argv, cli: Partial<...> = {}): Promise<0 | 1 | 2>`
  and the `invokedDirectly` guard match
  app/scripts/assign-primary-contacts.ts:512 and :554-565. `--repo` keeps its
  meaning (`path.resolve(a.repo ?? deps.ownRoot)`). Every parseProbeArgs
  refuse/accept case resolves to the asserted message/object (strict
  parseArgs error names `--bogus`; `suite` narrows to the literal union for
  the return type; the `...(cond && {...})` spreads already compile in the
  current probe at :227).
- S6.2 seams vs planned APIs: `withSentBlock` matches S5.4's required
  `ExtractionInput.sentPropertiesBlock`; `sentRow` returns a valid
  `ListingSendItem` (required unitId/contactId/via/created_at/updated_at;
  `shares` entries fit `ShareLedgerEntry`, listingSendsRepo.ts:59-126) and
  `selectSentRows` (S5.3) accepts it and derives signedUp through
  `latestCountedShareKey(...) === FLYER_SHARE_KEY` ('flyer',
  lib/shareLedgerKeys.ts:17, :37-47); `sentDisplay` returns a valid
  `UnitDisplayItem` (unitsRepo.ts:642-645, `Address` all-optional strings,
  lib/address.ts:12-21) that is assignable to S5's `PropertyLabelSource`;
  `SentPropertyEntry`, `renderSentPropertiesBlock(...).text`,
  `SENT_PROPERTIES_BLOCK_HEADER` match S5.3 (plan 8768-8876). Preamble notes
  1-3 match S4.2's `NoteLineFilterInput`/`NoteLineFilterResult` (6279-6307),
  S4.1's `parseExtractionFactMinConfidence(raw: string | undefined): number`
  (6055) and S3.2's exported `coerceField`/`Coerced` (4214-4239).
- Composition with S3.2 / S5.4: both earlier probe anchors (withRecorded
  :187-192; `return { transcript, profile, orgListBlock };` :205) are
  verbatim and unique today; S6.2 replaces the whole file, and its own
  `withRecorded` / `buildInput` / `transcriptOf` supersede both edits
  without losing anything (dollars as a number, the block always passed).
  No S4 task touches the probe.
- Probe module surface used by S6.2 exists: prompt.ts exports
  `extractionPromptFingerprint` (:147), `renderUtteranceLine` (:179),
  `buildExtractionUserContent` (:183); orgListBlock.ts `renderOrgListBlock`
  (:80) with header 'ORGANIZATION LIST' (:37); orgStartingList.ts
  `buildStartingEntries` (:85); logger.ts `createLogger` (:178); config.ts
  has no import-time side effect beyond importing logger.
- Typecheck coverage: app/package.json `typecheck` runs
  `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.test.json`;
  tsconfig.scripts.json includes `scripts` + `src` (both new script files);
  tsconfig.test.json includes `test` + `src` and reaches the scripts through
  the tests' imports (existing precedent: assignPrimaryContacts.*.test.ts
  import `../scripts/...js`). tsconfig.base.json: strict, NodeNext,
  `noUncheckedIndexedAccess`, no `exactOptionalPropertyTypes`, no
  `noUnusedLocals`.
- Lint coverage: eslint.config.mjs lints `**/*.ts` (scripts and tests
  included, nothing ignored but node_modules/dist/coverage/.terraform) with
  tseslint recommended + `no-unused-vars` honoring `_`. S6.2's
  temporarily unused `createHash` (script and test), `failed` and
  `BASELINE_ROOT` (test) are all used by S6.3-S6.5, so gate 5 is clean at
  the end; no pre-commit hook lints (hooks: post-checkout, post-commit,
  post-merge, pre-push).
- WI16 otherwise holds for this range: S6.1 is pure; S6.1a stubs the SDK;
  S6.2's tests inject `env` and `createDriver`, so `main` never reads
  `process.env` (only `defaultDeps().env`, which the harness overrides) and
  never constructs a driver. `git grep "@anthropic-ai/sdk" -- app/src app/scripts`
  today prints only extraction.ts:4 and :12, as S6.1a's check expects.
- Preamble citations hold: extraction-prompt-probe.ts:21-23, :266,
  :273-279, :11-14; config.ts:888; .env.example:192-195 (the four commented
  extraction lines); listingSendsRepo.ts:235 `isListed`; extraction.ts:1-4,
  :184, :210-214, :242-244; extractionFake.ts:103;
  scripts/lib/secretsCore.mjs:253-254; the MERGE_HEAD path
  (`.git/worktrees/wp1-b1-ranking-inputs`). New files do not exist yet;
  no source-scanning test (orgListsRetired, tenantMatchingInputsReaders
  READERS) is tripped by them.
