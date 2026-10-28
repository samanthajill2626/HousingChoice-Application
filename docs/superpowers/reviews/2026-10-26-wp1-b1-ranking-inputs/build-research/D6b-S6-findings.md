# D6b-S6 findings - plan section 10 preamble, S6.3-S6.10, gate-run commands, S6 coverage

Reader D6b-S6 checked plan lines 1-515 (binding sections 0-4), 10921-11137
(the section 10 preamble, read closely: contradictions, cross-slice notes
1-8, planner decisions 1-13, setup notes) and 13142-15789 (tasks S6.3,
S6.4, S6.5, S6.6, S6.7, S6.8, S6.9, S6.10, the "Gate-run commands"
subsection and "S6 coverage"), reading the planned exports of S6.1, S6.1a
and S6.2 (plan 11138-13141) and the S3/S4/S5 APIs those tasks call (S3
`coerceField` plan 4207-4260, S4.1 `parseExtractionFactMinConfidence` plan
6055-6064, S4.2 `filterNoteLines` plan 6279-6369, S4.7 fake header plan
7605-7628, S5 `propertyLabel` / `labelMatches` plan 8114-8191, S5.3
`sentPropertiesBlock.ts` plan 8740-8896, S5.4 user content plan 9196-9197,
S5.6 job WARNs plan 9908-9921, the S5 hand-off notes plan 7889-7909). Tree:
worktree branch HEAD ede08552, whose app/, dashboard/, e2e/, scripts/,
RUNBOOK.md, documentation/ and the three env templates are byte-identical to
main @d0e2c2d8 (`git diff --stat d0e2c2d8 HEAD` over those paths is empty).
Checked against the live tree: every name, export, type and signature the
S6.3-S6.5 code and tests call; strict TS (`noUncheckedIndexedAccess`,
NodeNext) and the tsconfig/eslint coverage of the touched files; every
quoted anchor in RUNBOOK.md, the three env templates, GLOSSARY.md and
extractionFake.ts (verbatim and unique), including composition with the
earlier slices' planned rewrites; the WI16 greps against the tree; the
`--baseline` runtime loader on Windows; the dry-run path; the gate-run
commands against the planned flags. Nothing was run (no test, typecheck,
lint, npm script or probe). No BLOCKER, no MAJOR; two MINOR and four NOTEs.

## D6b-S6-1 - MINOR - S6.4 "a feedback control with no line naming its property fails the gate" asserts only the exit code

- Plan location: Task S6.4 Step 1, plan lines 14414-14417 (RED claim
  14507-14515).
- What the plan says: the test runs `main(NW, ...)` with
  `control-feedback-yes` answering `'Loves the apartment, wants to apply'`
  and asserts only `expect(await main(NW, h.deps)).toBe(1)`.
- What the tree holds: S6.2's `runNeverWritten` placeholder (plan
  13062-13065) already returns 1, so this case is GREEN at S6.4's RED step,
  contrary to the step's "red for the stated reason" rule (plan section 0).
  After GREEN it still passes for any wrong reason that exits 1: `main`'s
  catch-all (plan 13085-13088) turns ANY thrown error in the run (a seam
  mismatch, a bad label lookup) into exit 1. Every sibling never-written
  failure test pins its reason in the record (plan 14380-14382,
  14393, 14411, 14422); this one does not.
- Correction: append one assertion to the test body (plan line 14416), after
  the `toBe(1)` line:
  `    expect(h.records[0]!.text).toMatch(/control-feedback-yes: control met in 0 of 3 runs \(needs 2\)/);`
  (the suite reason `judgeSuite` builds from `judgeCase`'s
  `control met in 0 of 3 runs (needs 2)`, printed in the record's Verdict
  block; the line is graded clean by `allClean`, so it is the only reason).

## D6b-S6-2 - MINOR - S6.7 Edit 5 omits the 4,000-character budget and the two block WARNs the S5 hand-off assigns to the RUNBOOK

- Plan location: Task S6.7 Edit 5, plan lines 15185-15205; S5 hand-off to
  S6 docs, plan lines 7906-7909.
- What the plan says: the S5 hand-off asks S6's RUNBOOK extraction section
  for "the block, its 20-row / 4,000-char limits, that a failed sends or
  units read fails the run, and the two counts in the AI run detail". Edit 5
  states the newest-20 rows, the run-failing reads and the two counts, but
  not the 4,000-character budget, and nothing about the two WARN lines the
  job logs when it leaves a property out of the block.
- What the tree holds (as planned): S5.3 drops the OLDEST lines over
  `SENT_PROPERTIES_BLOCK_BUDGET = 4_000` (plan 8753-8756, 8770) and a line
  holding the word TRANSCRIPT (plan 8750-8752); S5.6's job WARNs on both
  with `'extraction: properties sent over the prompt budget - oldest left
  out'` and `'extraction: a sent property label holds the word TRANSCRIPT -
  left out of the block'` (plan 9910-9921). RUNBOOK.md is the operator
  manual (AGENTS.md: "operational only"); an operator who sees either WARN
  finds nothing in the extraction section (RUNBOOK.md:1442-1500) to explain
  it.
- Correction: in Edit 5's new text, replace
  `sends a PROPERTIES SENT block (the tenant's listed listing_sends rows, newest 20) so a **feedback`
  with
  `sends a PROPERTIES SENT block (the tenant's listed listing_sends rows, newest 20, at most 4,000 characters) so a **feedback`
  and, right after the sentence ending `that names no sent property, i.e. an attach miss).`,
  insert:
  `A property left out of the block logs a WARN with counts only (never a label): \`extraction: properties sent over the prompt budget - oldest left out\` (the oldest beyond 4,000 characters) or \`extraction: a sent property label holds the word TRANSCRIPT - left out of the block\`.`
  (ASCII; wrap to the section's width.)

## D6b-S6-3 - NOTE - S6.6's comment lands between line 11 and S4.7's new paragraph, restating it

- Plan location: Task S6.6 Step 2, plan lines 15078-15104; S4.7 Edit 5,
  plan lines 7605-7628.
- What the plan says: insert the WP1 B1 payloads block "after the header
  paragraph that ends `... config refuses driver 'fake' in production.`
  (:11)". S6.6's intro says to re-read the fake after S4 but names only
  S4's test-fixture migration (plan 15021-15024).
- What the tree holds: the anchor is verbatim and unique at
  app/src/adapters/extractionFake.ts:11, and S4.7 keeps it there, so the
  insertion works. But S4.7 appends its own paragraph directly after :11
  (plan 7621-7627: "The payload is NOT run through parseExtractionText ...
  every value rule - the floor included - is apply.ts filterNoteLines ...").
  Inserting "after :11" puts S6.6's block BETWEEN line 11 and S4.7's
  paragraph, and its first sentence ("The payload is returned VERBATIM -
  this driver does no value filtering, so the confidence floor ... are all
  exercised in apply") restates S4.7's. Comment-only; no test or typecheck
  impact (the readers pin still passes: neither paragraph spells a list
  key).
- Correction: anchor S6.6 Step 2 on S4.7's last line instead - "after the
  line `// EXTRACTION_FACT_MIN_CONFIDENCE (default 0.7).` (S4.7; unique in
  the file)" - and open the block with `// WP1 B1 payload examples (spec
  2026-10-26-wp1-b1-ranking-inputs D3-D5); the fake passes them through as
  above:` in place of the two sentences S4.7 already carries.

## D6b-S6-4 - NOTE - The "Placeholders" comment survives above the real runners

- Plan location: S6.2 plan line 13061 (`// Placeholders - S6.4 and S6.5
  replace these two bodies.`); S6.4 Step 2 (d) plan 14592; S6.5 Step 2 plan
  14926.
- What the plan says: S6.4 and S6.5 each "Replace the ... placeholder"
  function; neither names the comment line above them.
- What the tree holds: nothing yet (new code). After S6.5 the comment would
  label the two finished runners as placeholders.
- Correction: S6.5 Step 2, "Replace the `runComparison` placeholder" also
  deletes the line `// Placeholders - S6.4 and S6.5 replace these two bodies.`.

## D6b-S6-5 - NOTE - `app/src/adapters/extraction.ts:184` will not point at MAX_OUTPUT_TOKENS by gate time

- Plan location: planner decision 12, plan lines 11096-11099; Gate-run
  commands step 4, plan line 15618 (spec D7 also cites `:184`).
- What the plan says: "raise `MAX_OUTPUT_TOKENS`
  (app/src/adapters/extraction.ts:184)".
- What the tree holds: `const MAX_OUTPUT_TOKENS = 4096;` is at
  app/src/adapters/extraction.ts:184 today, but S3 (TenantMatchingProfile),
  S4 (ExtractionNoteLine), S5 (the `sentPropertiesBlock` input field and its
  doc) and S6.1a (eight header lines, plan 12063-12076) all insert lines
  above it.
- Correction: S7.6's sheet (plan 16037-16044) cites the constant by name -
  "raise `MAX_OUTPUT_TOKENS` (the `const MAX_OUTPUT_TOKENS = 4096;` line in
  app/src/adapters/extraction.ts)" - or re-reads the line number from the
  built file.

## D6b-S6-6 - NOTE - A PARTIAL never-written record says "PENDING Cameron's sign-off below" with no sign-off section

- Plan location: S6.3 `renderNeverWrittenRecord`, plan lines 14101-14102
  and 14193-14200; S6.4 final print, plan 14665-14669.
- What the plan says: the Verdict line on a passing suite is always
  "PASS on every automatic check - PENDING Cameron's sign-off below", while
  the `### Sign-off` section is printed only when `!r.partial`; the CLI's
  closing line likewise says the gate "still needs Cameron's written
  sign-off" on a `--case` run.
- What the tree holds: nothing yet. A `--case` record (never a gate run)
  points at a section it does not carry. No test pins the PARTIAL wording
  (the `--case` test, plan 14475-14481, asserts `PARTIAL` and the absent
  Sign-off only).
- Correction: in `renderNeverWrittenRecord`, print
  `r.partial ? 'PASS on every automatic check (PARTIAL - one case, not a gate run; no sign-off)' : "PASS on every automatic check - PENDING Cameron's sign-off below"`
  for a passing suite; no test changes.

## Verified with no finding

- S6.3 test imports and helpers: every name exists in S6.1 / S6.2 / S6.3 as
  planned; no module-level name collides across the S6.2-S6.5 appended
  blocks; mid-file `import` declarations are legal (no `import/first` rule
  in eslint.config.mjs); the file's final state leaves no unused import
  (`GATE_RUNS` unused at S6.3 is used by S6.4/S6.5; gate 5 lints the end
  state).
- S6.3 RED is red for the stated reason (the module-level
  `sentLabels(branch)` throws at load).
- S6.3 implementation typechecks under strict + `noUncheckedIndexedAccess`:
  `writtenLines` matches `NoteLineFilterInput` (`modelLines: readonly
  unknown[] | undefined` accepts `result.noteLines`) and
  `NoteLineFilterResult`; `factFloor` matches S4.1's
  `parseExtractionFactMinConfidence(raw: string | undefined): number`;
  `coerceField(field, raw: string | undefined)` is exported by S3; the
  `fields` flatMap narrows `op.op` to write/suggest; `parseGraderOutput`
  narrows `unknown` verdicts correctly; exported functions using
  non-exported interfaces are fine with `declaration: false`
  (tsconfig.base.json).
- Every S6.3 assertion traced to the planned code: items order (lines, then
  fields in list order), field items typed `<label> (field value)` with the
  RAW value (PR51), `not-needed` counts as graded (decision 10), excluded
  verdict with no known kind kept as `unspecified` and empty reason
  `(no reason given)` (decision 11), grader failure/truncation leaves the run
  ungraded and is not a gate truncation (decision 12), the 2-of-3 scored-and-
  graded bar on every case (decision 2 / PR51), field verdicts reported
  never failing, the retry guard via `existingNotes` (S4.2 `alreadyPresent`),
  `$900` -> 900 kept and `900.50` dropped (S3 dollars rule), record strings
  (Verdict, Commit, Model, Key, both fingerprints, floor, planted fact, user
  content hash, per-item verdict text, review list, PR55 "Lines the grader
  did not judge" with `- none`, tokens and informational cost, gist line,
  Sign-off), ASCII of the record (asciiSafe on every dynamic string; labels,
  gists and patterns are ASCII).
- `graderPromptFingerprint` hashes system prompt + schema + user-content
  shape; planted facts are printed, not hashed; `contentHash` hashes the
  production `buildExtractionUserContent` (PR51).
- S6.4: `nwHarness` shares the harness's arrays and deps object by reference,
  so its injected `createGrader` reaches `main`; `nwPassing` meets every
  control (labels `412 Oak Ave, Decatur`, `88 Birch Ln Apt 3, Tucker`,
  `1530 Peachtree Rd, Atlanta` match through `labelMatches`), so the
  passing suite exits 0 with 87 extraction calls and 84 grader calls (the
  no-address control has no item); one grader call per run with items and
  none for a run with nothing to judge; the PROPERTIES SENT expectation
  equals S5.3's renderer output over S6.2's `sentRow`/`sentDisplay`
  (`latestCountedShareKey` -> `flyer` -> "signed up", newest first, dates
  `YYYY-MM-DD`) and S5.4 places the block verbatim in the user content
  (plan 9196-9197) (PR30); `safeGrade` turns a throwing grader into an
  ungraded run; a record-write failure exits 1 through `main`'s catch; the
  dry run builds every request and constructs no driver or grader.
- S6.4 header anchors (S6.2 plan 12519-12521 and 12530-12532) are verbatim
  and unique in S6.2's planned text; S6.3's two anchors (the data-module
  import line and the `// (S6.3 adds ...)` comment) likewise.
- S6.5: `compareDefaultSuites` thresholds match spec D7 (case drop >= 2,
  total more than 2 below, branch truncation per decision 7); every test's
  numbers trace (60/120 inputs, Attempt 1/2 strings, the reason text); the
  same-checkout usage error; PR52 dry-run print lines (S6.2, S6.4 and S6.5
  all print `''` then `Dry run: nothing was sent.`).
- `--baseline` runtime loading is feasible on Windows: `load` uses
  `pathToFileURL(path.join(root, rel)).href` (kept from
  extraction-prompt-probe.ts:247-249); tsx resolves the other checkout's
  `.js` -> `.ts` imports; bare imports resolve by walking up from that
  checkout (W:/AI Projects/Housing Choice/HC Application/node_modules has
  `@anthropic-ai/sdk`; its HEAD is `main`); `SENT_BLOCK_PATH` is absent on
  main @d0e2c2d8, so the baseline sends no block, as its production does;
  main's modules ignore the extra `sentPropertiesBlock` input field.
- Module side effects on the dry-run path: config.ts, dynamo.ts (lazy
  client), contactsRepo.ts, extractionRepo.ts, tables.ts have no top-level
  env read or throw; only index.ts/worker.ts call `loadConfig()` at import.
  The dry run reads `ANTHROPIC_API_KEY` only as `deps.env` (unset -> '') and
  returns before `createDriver` / `createGrader`.
- S6.6: `markerInput`, `model`, `createExtractionDriver`, `ExtractionInput`
  exist in app/test/extractionAdapter.test.ts (:21-47); the fake returns
  `meta { driver, promptFingerprint, rawText }` and `{ fields: {}, ...partial }`
  (extractionFake.ts:82, :103), so the PIN is green on arrival; the comment
  spells no list key (S3.3 readers pin, plan 4625-4648).
- S6.7: all six RUNBOOK anchors are verbatim and unique (RUNBOOK.md:1445-1447,
  :1455-1457, :1465, :1466, :1469, :1491-1496); spec 4's :1455-1457 and
  :1465 citations hold; "banned", "unset or blank" and "never demoted" occur
  nowhere else today; "parks after five failures" matches
  jobs/extraction.ts:54 `MAX_EXTRACTION_ATTEMPTS = 5`.
- S6.8: the `.env.example` block (:191-195) and the identical
  `.env.dev.example` (:225-228) / `.env.prod.example` (:250-253) anchors are
  verbatim and unique; all three files are LF (the `^...0.7$` grep works);
  nothing loads `.env.example` at runtime (scripts/dev.mjs reads `.env` and
  `.env.dev` only); secretsCore.mjs:253-254 writes a new key empty, as
  cross-slice note 7 says.
- S6.9: the GLOSSARY anchor (documentation/GLOSSARY.md:172-173) is verbatim
  and unique; the labels match S1's list (plan 927-957); the mirror path,
  the label format and docs/issues/wp3-property-feedback-redesign.md exist.
- S6.10: WI16 greps against the tree - grep 1 today prints only
  extraction-prompt-probe.ts:268 (removed by S6.2's rewrite), grep 5 prints
  only extraction.ts:4 and :12; after S6.4 grep 3 prints exactly TWO probe
  lines (S6.4's header line and `defaultDeps`), matching PR56; the guard
  (`process.argv[1]?.endsWith(...)`) is the assign-primary-contacts.ts
  template (:554-555) and works on Windows paths.
- Gate-run commands match the planned flags (`--suite never-written --model
  ... --dry-run` needs no `--out`; `--baseline` requires `--model` and
  `--out`); `tsx` is a root devDependency present in both checkouts; call
  counts (87 + up to 87, 60/120) and the cost arithmetic are consistent with
  `PRICE_TABLE`.
- No non-ASCII character and no `\u` escape anywhere in plan lines
  10921-15789.
- S6 coverage maps every spec D7 bullet, the spec 5 D7 test list and the
  spec 4 Docs bullet to a task.
