# S4 slice report - The model call (WP1 B2a), tasks S4.1-S4.12

- Implementer: S4b child (Claude Opus 5.5), 2026-10-29. Tasks S4.1-S4.6 were
  built by the S4a child; their full record is
  [`S4a-report.md`](S4a-report.md) (same directory). This file is the plan's
  S4.12 slice report and covers the WHOLE slice; it repeats from S4a only what
  the S4.12 checklist asks for (the WI22 quotes, the pins, the cap grep).
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Slice range: 9dc940ee (the S3 report) .. this report's commit. S4b range:
  a135a242 (the S4a report) .. this report's commit.
- Scope (S4b): plan section 8 - the slice head (Scope, C1-C13, Cross-slice
  notes; plan 16252-16602) and tasks S4.7-S4.12 with the S4 coverage table
  (plan 19299-21585): `prompt.ts` (system text, handles, `homesSeen`, PR18
  fingerprint, the D8.1 snapshot, PR19, PR20), `driverTypes.ts`,
  `adapters/rankingFake.ts` (PR8), `adapters/ranking.ts` (driver + factory),
  the compile check's two `ranking` variants, RUNBOOK "Changing a
  structured-output schema" (that subsection only), the PR32 version pins,
  the close. Spec D4 (the call), D5, D6, D8.1, D17 item 1.
- Verdict: S4.7-S4.11 one commit each, each RED for its stated reason, then
  GREEN. Six of the nine new S4b files are byte-identical to their plan
  blocks; the deltas are the WORKLIST edits (WL-S4-1, G3) and the S4.11 pin
  values (section 8). The six pins equal S4a's predicted values exactly.
  WL-S4-5: root `npm run typecheck` exit 0 with the exact SDK request - no
  STOP. Close evidence: 13 files / 306 tests green, root typecheck exit 0,
  eslint on the slice's 23 files exit 0, ASCII 0 everywhere. No QUESTION.

## 1. Tasks and commits (the whole slice)

All paths under `app/` unless shown.

| Task | Commit | Files |
|---|---|---|
| S4.1 bands and the one Weak cap function (S4a) | 1174c487 | `src/services/ranking/bands.ts`, `src/services/ranking/cap.ts`, `test/rankingBandsCap.test.ts` |
| S4.2 the cost of one call (S4a) | b5b1cbb6 | `src/services/ranking/cost.ts`, `test/rankingCost.test.ts` |
| S4.3 the output schema and the offline shape test (S4a) | ad84caeb | `src/services/ranking/schema.ts`, `test/rankingSchema.test.ts` |
| S4.4 parseRankingText (S4a) | 9c49e05f | `src/services/ranking/parse.ts`, `test/rankingParse.test.ts` |
| S4.5 the rubric r1 + WL-S4-2 (S4a) | 4c5f8fa1 | `src/services/ranking/rubric.ts`, `test/rankingRubric.test.ts` |
| S4.6 ten worked examples e1 + WL-S4-3 (S4a) | 213dc326 | `src/services/ranking/examples.ts`, `test/rankingExamples.test.ts` |
| S4a report | a135a242 | `docs/.../slices/S4a-report.md` |
| S4.7 the call text: handles, homesSeen once, promptFingerprint, the pair snapshot (+ WL-S4-1, G3) | 5c702299 | `src/services/ranking/prompt.ts`, `test/helpers/rankingBatchFixture.ts`, `test/rankingPrompt.test.ts` |
| S4.8 the driver interface, the fake and console drivers | 2ac38914 | `src/services/ranking/driverTypes.ts`, `src/adapters/rankingFake.ts`, `test/rankingFake.test.ts` |
| S4.9 the anthropic ranking driver and the factory | 439c8c04 | `src/adapters/ranking.ts`, `test/rankingDriver.test.ts` |
| S4.10 the compile check's two ranking variants; RUNBOOK | 5b304da9 | `scripts/extraction-schema-compile-check.ts`, `test/rankingSchema.test.ts` (append), `RUNBOOK.md` (one subsection) |
| S4.11 the PR32 / R2F3 version pins | 117b2533 | `test/rankingVersionPins.test.ts` |
| S4.12 this report | this commit | `docs/.../slices/S4-report.md` |

Every file is on PR2's S4 list or is its test, plus the one new shared helper
the slice head names (`test/helpers/rankingBatchFixture.ts`). Edited
pre-existing files: `scripts/extraction-schema-compile-check.ts`, `RUNBOOK.md`
(PR2: S4's), and S4a's `test/rankingSchema.test.ts`. No file outside PR2 /
PR27 was touched; `test/tenantMatchingInputsReaders.test.ts` is NOT edited
(IR30).

## 2. Test commands and counts (S4b, every run, in order)

Form: `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`.
DynamoDB Local was up (G1); `env | grep -c '^AWS_'` printed 0, so no
`env -u` prefix.

1. S4.7 RED, `rankingPrompt.test.ts`: 1 file failed, no tests ran - "Error:
   Cannot find module '../src/services/ranking/prompt.js' imported from ...",
   caused by "Failed to load url ... Does the file exist?" (G4 wording; the
   stated reason). The plan's "(the helper imports it too)" is moot: the
   helper's prompt.js import is `import type`, erased by esbuild; the test's
   own import is what fails.
2. S4.7 GREEN on the VERBATIM plan `prompt.ts`: 26 passed.
3. WL-S4-1 applied; GREEN: `rankingPrompt` 26 + reader scan 3 = 29 passed.
4. eslint (3 files) exit 0; `tsc -p tsconfig.json --noEmit` exit 0;
   `tsc -p tsconfig.test.json` exit 0.
5. S4.8 RED, `rankingFake.test.ts`: "Cannot find module
   '../src/adapters/rankingFake.js'".
6. S4.8 GREEN (`rankingFake` + reader scan, the plan's command): 17 + 3 = 20
   passed; the scan now reads `adapters/rankingFake.ts` through its
   `existsSync` filter.
7. eslint (3 files) exit 0; tsc src and test exit 0; grep of the three files
   for the four input keys, `process.env`, `ANTHROPIC`: nothing.
8. S4.9 RED, `rankingDriver.test.ts`: "Cannot find module
   '../src/adapters/ranking.js'".
9. S4.9 GREEN (`rankingDriver` + reader scan): 18 + 3 = 21 passed.
10. Root `npm run typecheck`, bare: exit 0 (WL-S4-5; section 4).
11. eslint (2 files) exit 0.
12. S4.10 RED, `rankingSchema.test.ts`: 2 failed | 18 passed (20) - "lists
    the five variants in order" (the received list lacks `ranking-off`,
    `ranking-on`) and "sends the shipped ranking schemas themselves"
    ("TypeError: Cannot read properties of undefined (reading 'schema')"):
    exactly the plan's stated RED; S4a's 18 cases stayed green.
13. S4.10 GREEN: 20 passed.
14. eslint (2 files) exit 0; `tsc -p tsconfig.scripts.json` exit 0;
    `tsc -p tsconfig.test.json` exit 0.
15. S4.11 RED, `rankingVersionPins.test.ts`: 5 failed (5), each with its
    "bump ..." message (the computed hash is not `'PIN-ME'`).
16. The S4.11 print command (`npx tsx -e ...`, calls nothing): the six hashes
    in section 5.
17. S4.11 GREEN: 5 passed.
18. PR32 negative probe (NOT committed): `test/zz-pin-probe.test.ts` = the
    pins test with a `vi.mock` that appends one space to `RUBRIC_TEXT`: 2
    failed | 3 passed - "RUBRIC_TEXT changed: bump RUBRIC_VERSION (now r1)
    and add its pin" and "the system text changed: bump RUBRIC_VERSION or
    EXAMPLES_VERSION (whichever part changed; now r1/e1) and add the pin";
    the framing, schema and examples pins stayed green. Probe deleted; `git
    status` showed only the new pins test.
19. eslint (1 file) exit 0.
20. S4.12 step 1, root `npm run typecheck`, bare: exit 0 (app src, scripts
    and test configs; dashboard; e2e; fake-twilio; fake-twilio-web).
21. S4.12 step 2, the slice's 13 files together: 13 passed, 306 tests -
    rankingBandsCap 48, rankingCost 7, rankingSchema 20, rankingParse 30,
    rankingRubric 14, rankingExamples 18, rankingPrompt 26, rankingFake 17,
    rankingDriver 18, rankingVersionPins 5, tenantMatchingInputsReaders 3,
    extractionSchema 67, extractionAdapter 33.
22. S4.12 step 3, `npx eslint` on the slice's 23 files from the worktree
    root: exit 0, no output.
23. S4.12 step 4, ASCII: each of the 22 new files prints 0; the added lines
    of `scripts/extraction-schema-compile-check.ts` and `RUNBOOK.md`
    (`git diff -U0 main...HEAD`) print 0.
24. S5 shape probe (NOT committed): a temporary `test/zz-s5-shape-probe.ts`
    passing S3's `AssembledRanking` (verified candidates filtered, `anchor:
    { card, missing }`, `homes`) to `buildRankingPrompt`; `tsc -p
    tsconfig.test.json` exit 0. Deleted.
25. The plan's fingerprint print command: section 5.

Byte compare against the plan (`cmp` / `diff` with `sed -n '<range>p'`):

| File | Plan lines | ASCII bad | vs plan |
|---|---|---|---|
| `test/helpers/rankingBatchFixture.ts` | 19318-19422 | 0 | identical |
| `test/rankingPrompt.test.ts` | 19428-19749 | 0 | header comment lines 3-4 (G3) |
| `src/services/ranking/prompt.ts` | 19765-20115 | 0 | WL-S4-1 (one import added, two lines become one) |
| `test/rankingFake.test.ts` | 20152-20353 | 0 | identical |
| `src/services/ranking/driverTypes.ts` | 20369-20411 | 0 | identical |
| `src/adapters/rankingFake.ts` | 20417-20645 | 0 | identical |
| `test/rankingDriver.test.ts` | 20682-20932 | 0 | identical |
| `src/adapters/ranking.ts` | 20948-21167 | 0 | identical |
| `test/rankingSchema.test.ts` (S4.10 part) | 21211, 21217-21228 | 0 | identical (import below the existing imports; one blank line, then the block) |
| `scripts/extraction-schema-compile-check.ts` | 3a-3d new text | 0 added | identical to each "new" block |
| `RUNBOOK.md` | 21315-21334 | 0 added | identical; replaces the old 1545-1551 (now 1545-1564) |
| `test/rankingVersionPins.test.ts` | 21378-21425 | 0 | the five `PIN-ME` lines filled (fixture-only) |

Every block was written with `sed -n` from the plan (G2) and checked
(backslash count, line count, `cmp`, ASCII); edits afterwards used the Edit
tool on lines with no escape (no `\u` sequence exists in any S4b file; the
counts of lines holding a backslash held after every edit: prompt.ts 5,
rankingPrompt.test.ts 11, rankingSchema.test.ts 1; rankingFake.ts was never
edited). The RUNBOOK subsection was replaced as a line
range (`head` / the plan block / `tail`), so no byte outside it moved.

## 3. Watch items

- WI7 (S4 half: no network, no key) - MET.
  - `git grep -n "from '@anthropic-ai/sdk'" -- app/src`:
    `app/src/adapters/extraction.ts:20` and `app/src/adapters/ranking.ts:21`
    only.
  - `git grep -n "process\.env" -- app/test/rankingDriver.test.ts app/test/rankingFake.test.ts`:
    nothing (exit 1).
  - Wider: `process\.env|ANTHROPIC|fetch(|@anthropic-ai` over the nine S4b
    files finds only `ranking.ts:21` (the import), `ranking.ts:202` (an error
    message that NAMES the variable; nothing reads it), `driverTypes.ts:3`
    (comment), `rankingDriver.test.ts:2` (comment), `:21` (`vi.mock` of the
    SDK) and `:42` (the stub's import).
  - The driver test stubs the SDK (`rankingDriver.test.ts:21-39`): the stub
    constructor only records its options (`:34-35`); every key is the fake
    string `'sk-test-not-a-real-key'` (`:50`); the one base URL is
    `http://127.0.0.1:9999`, handed to the stub. "makes no call until
    rankBatch" (`:236`).
  - `rankingSchema.test.ts:22` imports the compile-check script: its `main`
    runs only when invoked directly
    (`scripts/extraction-schema-compile-check.ts:110-111`), so the import
    builds no client and calls nothing; its other import
    (`extractionProbeNeverWritten.ts`) imports types only.
  - No S4 task ran the compile-check script or any model; both `tsx -e`
    print commands import pure modules and call nothing. No `ANTHROPIC_*`
    value was read or printed (G6).
- WI8 (the fake driver half; the reader scan over the adapters) - MET.
  - The fake finds its inputs THROUGH THE LIST: `fakeInputLabels()`
    (`src/adapters/rankingFake.ts:59`) takes the one `kind: 'dollars'` entry
    (maximum portion) and the one `kind: 'text'` entry with `completeness:
    true` (area preference) from `TENANT_MATCHING_INPUTS`, and reads the card
    by their LABELS; it throws when the list no longer has exactly one of
    each, and it is called in the two driver constructors (`:196`, `:213`),
    never at module load or in `rankBatch` (R2F12). Pinned by
    `test/rankingFake.test.ts:39-45` ("the list finders").
  - S3.1's reader scan reads both adapters through `RANKING_DRIVERS`
    filtered by `existsSync` (`test/tenantMatchingInputsReaders.test.ts:41-46,
    :51`); `test/rankingDriver.test.ts:245-250` pins that BOTH files exist, so
    that half of the scan is never vacuous. The scan ran green after S4.8,
    S4.9 and at the close (3 passed).
  - `git grep -n "area_preference\|max_tenant_portion\|accessibility_need\|preferences_constraints" -- app/src/adapters/ranking.ts app/src/adapters/rankingFake.ts app/src/services/ranking/rubric.ts app/src/services/ranking/prompt.ts app/src/services/ranking/examples.ts app/src/services/ranking/driverTypes.ts`:
    nothing (exit 1).
- WI12 (one card definition per record) - MET for S4. `git grep -n
  "function tenantCard\|function propertyCard("` over `app/src` lists only
  `cards.ts:147` (`propertyCard`) and `cards.ts:290` (`tenantCard`). S4 builds
  no card: `prompt.ts` copies the cards it is given and replaces only each
  properties-seen entry's `home` reference (`rewriteSeen`, `prompt.ts:186`;
  "never mutates the cards it was given", `rankingPrompt.test.ts:233`); the
  fake reads card keys; S4.6's examples test runs S3's real
  `propertyMissing` / `tenantMissing`.
- WI13 (one cap function) - MET for S4's half.
  `git grep -n "function capOf\|new Set(CAP_ELIGIBLE_KEYS)" -- app/src` lists
  only `app/src/services/ranking/cap.ts:35` (the set) and `:84` (`capOf`).
  `capOf(` callers outside `cap.ts` in `app/src` and `app/scripts`: NONE yet
  (S5's `cappedAtRun`, S6's read and S8's check are the planned callers);
  in tests, `test/rankingBandsCap.test.ts` (11 lines) and
  `test/rankingExamples.test.ts` (1 line) call it.
- WI21 (the schema shape) - MET (S4.3, S4a): `test/rankingSchema.test.ts:61`
  `describe.each([false, true])` runs, for BOTH switch states, "has at most
  five object nodes (root, candidate, two reasons, flag)" (`:64`, exactly 5),
  "sets additionalProperties:false on every object and requires every key
  (zero optional parameters)" (`:68`), "carries no numeric or length bounds
  anywhere" (`:76`), "is the spec D5 shape" (`:84`) and "returns the same
  object on every call" (`:104`). S4.10's two new cases (`:188`, `:192`) pin
  that the compile check sends those same objects.
- WI22 (the unlawful-flag free-text fields are strings on `UnitItem`) - MET.
  Re-grepped: `app/src/repos/unitsRepo.ts`, `export interface UnitItem` at
  :383 (closing brace :591); the lines are unchanged since main @404e039d
  (`git show main:...` prints the same eleven lines at the same numbers):

  ```
  :449    utilities?: string;
  :451    accessibility?: string;
  :457    notes?: string;
  :464    lease_terms?: string;
  :471    pets?: string | boolean;
  :498    tour_process?: string;
  :507    application_process?: string;
  :519    evictions_notes?: string;
  :525    qualifications?: string;
  :529    pet_fee?: string;
  :535    deposit_notes?: string;
  ```

  Ten are `string`; `pets` is the legacy `string | boolean`. Resolution (plan
  C2): the unlawful rule reads the CARD's text
  (`propertyFacts(...).freeTextByField`, S3; in a batch
  `RankingBatchInput.freeTextByHandle`, `prompt.ts` sets it from each
  candidate's `propertyFacts`), and the card reads `pets` through
  `unitItemValue` (a legacy `false` reads as blank text, so a flag on it is
  dropped; `true` reads "Allowed"); no S4 code reads `UnitItem.pets`. The
  compile-time tie is `test/rankingSchema.test.ts` `STRING_TYPED_FREE_TEXT ...
  satisfies` over the ten (S4a's negative probe proved it fires; S4a report
  section 2 item 10).

## 4. WORKLIST items

- G1 - honored: no `npm ci` / `npm install` / `npm run db:start`; no `AWS_*`
  exported.
- G2 - honored (section 2, the byte table).
- G3 - APPLIED once: the plan's `rankingPrompt.test.ts` header (plan
  19430-19431) said `promptFingerprint (sha256 of the system text)`,
  contradicting PR18. It now reads "promptFingerprint (PR18: sha256 over the
  system text, a newline and the stable JSON of the schema sent)" (comment
  only; `rankingPrompt.test.ts:3-5`). A grep of plan 19299-21585 for
  fingerprint / failedBatches / unwritten / grouping finds no other comment
  that contradicts a ruling; `prompt.ts:19-22` and `:167` already state PR18;
  the RUNBOOK text says "sha256 over the system text and the schema sent".
- G4 - every RED was the stated reason (section 2 items 1, 5, 8, 12, 15);
  the vitest 3.2.6 wording is "Cannot find module ... / Failed to load url
  ... Does the file exist?". No case behaved differently from the plan.
- G5 / WL-S4-1 - APPLIED in S4.7 (5c702299), after the RED and a GREEN on the
  verbatim text: `prompt.ts` no longer defines `PROPERTIES_SEEN_KEY`; it
  imports it from `./cards.js` (`prompt.ts:24`), and the local block became
  `/** The entry key naming a seen home on S3's tenant card
  (PropertiesSeenEntry.home, PR20). */ export const SEEN_HOME_KEY = 'home';`
  (D4 reference section 3, verbatim). `grep -rn "PROPERTIES_SEEN_KEY = "
  app/src` finds only `cards.ts:207`. No cycle: `cards.ts` does not import
  `prompt.ts`; nothing in `app/src` imports `prompt.js` at runtime (only
  `driverTypes.ts`, type-only). 26 cases green before and after.
- G6 - honored (WI7 above). G7 - every command ran in the foreground and
  finished in my turn; no e2e run; no edit while any suite ran.
- WL-S4-2, WL-S4-3 - S4a's (applied in 4c5f8fa1 and 213dc326, before the
  pins).
- WL-S4-4 - the six pins computed with S4.11's print command AFTER both
  edits; all six equal S4a's predicted values (section 5).
- WL-S4-5 (SDK typing) - PASSED, no STOP: the exact S4.9 request
  (`thinking: { type: 'adaptive' }`, `output_config: { effort, format: {
  type: 'json_schema', schema } }`, options `{ timeout, maxRetries: 1 }`;
  `src/adapters/ranking.ts:79-92`) and `Anthropic.APIConnectionTimeoutError`
  (`:95`) compile against @anthropic-ai/sdk 0.129.0: root `npm run typecheck`
  exit 0 after S4.9 and again at the close. No cast anywhere.

## 5. The version pins (PR32 / R2F3) and the fingerprints

Versions: `RUBRIC_VERSION` 'r1', `EXAMPLES_VERSION` 'e1'. Printed with
S4.11's command (calls nothing) after WL-S4-2 and WL-S4-3, and pinned in
`app/test/rankingVersionPins.test.ts:16-20`:

```
rubric      2fdf3c3e189b172210362180dd2a6851416fea3a11389e77207081bbdeeda538   RUBRIC_PINS.r1
framing     1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef   FRAMING_PINS.r1
schema off  14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb   SCHEMA_PINS.r1.off
schema on   587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba   SCHEMA_PINS.r1.on
examples    c1bd64e7a42ecf1da7eb2b512d788698083b44414559fe103b389edb46be5fb8   EXAMPLES_PINS.e1
system      a4d00efd999b11ef8eded27d74225366113fd9dfaa5eebd4f7ac184ad7e1cb6a   SYSTEM_PINS['r1/e1']
```

`rankingPromptFingerprint` (the plan's S4.12 print command): landlord off
`33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9`, on
`420d26d2cb9b99b47ca64ad9ce8e12c9a43ea7548ef758323fa0ba15d6c8a4e5`. System
text 28,926 characters.

All eight equal S4a's cross-check values (S4a report section 4, WL-S4-4).
framing and both schemas also equal the D4 reference's verbatim-plan values;
rubric, examples, system and both fingerprints differ from those, as
WL-S4-4 expects. A change without a bump fails with a message naming the
version to bump (section 2 item 18). Bumping is Cameron's decision: any
later S5-S9 edit to the rubric, framing, schema or examples fails this test
- stop and ask through the orchestrator; r1 / e1 were never deployed, so the
planner may instead re-pin before the merge with Cameron's go.

## 6. Contradictions C1-C13 as built

- C1 / PR18 - `rankingPromptFingerprint({ landlordCard })`
  (`prompt.ts:166-180`): the FULL 64-hex sha256 over the system text, one
  newline, and `stableJson(rankingSchema({ landlordCard }))` (`stableJson`,
  `:156`, sorts keys at every depth, drops undefined, keeps array order),
  cached per switch state - two fingerprints (section 5).
  `buildRankingBatch` stamps it on every batch (`:255`); every S4 driver copies
  it to `meta.promptFingerprint` (`rankingFake.ts:173`, `ranking.ts:76`).
  Pinned by `rankingPrompt.test.ts:87`. RUNBOOK.md:1558-1561: an enum change
  bumps `RUBRIC_VERSION`. (Departs from spec D4's text; PR18 lists it for
  Cameron.)
- C2 / WI22 - section 3.
- C3, C4, C5, C11 - S4a's (schema, parse, cost); see S4a report section 5.
- C6 - the driver reads only `stop_reason` (`ranking.ts:128`, `:131`), as
  extraction does; no `stop_details`.
- C7 - WL-S4-5 above: compiled clean, no STOP.
- C8 - `RANKING_MAX_RETRIES = 1` (`ranking.ts:36`, sent at `:91`); the
  timeout message says "(one retry included)" (`:98`); one call's wall clock
  is bounded at twice `RANKING_CALL_TIMEOUT_MS`.
- C9 - `createRankingDriver` imports `RANKING_SUPPORTED_MODELS` from
  `lib/config.ts` (`ranking.ts:22`; never re-defined) and re-asserts it for
  driver `anthropic` (`:195-199`, message "AI_RANKING_MODEL must be one of
  claude-sonnet-5-5, claude-opus-5-5 ..."); a missing or empty key throws
  "requires an apiKey" (`:201-202`). Fake and console ignore the model and
  need no key. Pinned by `rankingDriver.test.ts:216-240` (the set is exactly
  `['claude-sonnet-5-5', 'claude-opus-5-5']`).
- C10 / PR20 - `buildRankingBatch`'s `handleFor` (`prompt.ts:210`): a seen
  home that is the property ANCHOR (for `tenants_for_property`, the first
  candidate's `unitId`, `:206`) becomes `"anchor"` and is never written to
  `homesSeen`; one that is a candidate of a tenant anchor becomes its `c`
  handle; any other gets `h1..hn` in first-reference order, written once; a
  home the batch does not carry throws `RankingPromptError` (`:226`). Pinned
  by `rankingPrompt.test.ts:160-231`, including "no unitId reaches the user
  text, whichever of the three references an entry gets" (`:206`).
- C12 - every name S5 codes against exists: `buildRankingPrompt` /
  `RankingPrompt` (`batchInput`, `userText`, `promptFingerprint`, `handles`
  with `display`, `snapshotOf(candidateId)` throwing on an unknown id)
  (`prompt.ts:305-351`); `RankingCallMeta`, `RankingBatchInput` (re-exported
  type-only from `driverTypes.ts`); `createRankingDriver(settings, logger?,
  opts?)` with `RankingDriverSettings = Pick<AppConfig, ...>` so `config`
  passes as is; `ParsedRanking` constructible as `{ byHandle,
  droppedUnlawfulFlags }` (S4a).
- C13 - S4b's parts: R2F12 (the fake's labels resolve in the driver
  constructors, `rankingFake.ts:196`, `:213`), FB23 (RUNBOOK.md:1562-1564:
  the compile check cannot validate `claude-opus-5-5`), R2F3 (S4.11 pins the
  bytes as sent), the S4.12 greps (section 3). The rest is S4a's.

## 7. S4 coverage (the rows S4.7-S4.12 own)

| Coverage row | Evidence |
|---|---|
| D4 the call: system = rubric then examples, byte-stable | `rankingPrompt.test.ts:48-85`; pinned by S4.11 |
| D4 user = anchor with missing, `homesSeen` once `h1..hn`, candidates `c1..cn` pool order, a seen candidate by its `c` handle | `rankingPrompt.test.ts:105-191` |
| D4 `promptFingerprint` as PR18; RUNBOOK enum rule | `rankingPrompt.test.ts:87`; RUNBOOK.md:1558-1561 |
| PR20 `home`: `anchor` / `c` / `h` | `rankingPrompt.test.ts:160-219`, snapshot `:276-295` |
| D8.1 the per-pair snapshot | `rankingPrompt.test.ts:258-295`, `:319` |
| D5 compile check gains two `ranking` variants; RUNBOOK names the schema | `rankingSchema.test.ts:187-196`; RUNBOOK.md:1545-1564 |
| D5 every failure kind gives no match (driver side) | fake fail seam `rankingFake.test.ts:113-127`; refusal, truncation, timeout, SDK error, parse `rankingDriver.test.ts:166-213` |
| D5 unlawful flag on a checkbox dropped and counted, through the fake | `rankingFake.test.ts:146` |
| D6 `RankingCall` discriminated, never throws, meta model / raw text / usage / latency | `rankingFake.test.ts:157`, `rankingDriver.test.ts:133`, `:166-213` |
| D6 request: model, `max_tokens`, adaptive thinking, effort + json_schema, timeout, `maxRetries: 1`, no fallback | `rankingDriver.test.ts:96-130` |
| D6 supported models; refusal / truncation / timeout / SDK error mapped; usage with cache read | `rankingDriver.test.ts:133-240` |
| D6 `model` stamped `fake` / `console` | `rankingFake.test.ts:157`, `:173` |
| D6 fake rules and the three seams | `rankingFake.test.ts:47-153` |
| D6 console driver logs counts and sizes only | `rankingFake.test.ts:183` |
| D6 prompt caching off; `cache_read_input_tokens` recorded when present | `rankingDriver.test.ts:133`, `:150` |
| FB27 / R2F12 labels in the constructors; rankBatch never throws | `rankingFake.ts:59-68`, `:196`, `:213` |
| FB23 the compile check cannot validate opus | RUNBOOK.md:1562-1564 |
| PR32 / R2F3 the pins | `rankingVersionPins.test.ts`; section 5 |
| WI7, WI8, WI13, WI21, WI22 | section 3 |

## 8. Deviations from the plan text

- G3 (comment only): the `rankingPrompt.test.ts` header states PR18
  (section 4). Carried in the S4.7 commit body.
- WL-S4-1: `prompt.ts` imports `PROPERTIES_SEEN_KEY` from `./cards.js`
  (section 4). Carried in the S4.7 commit body.
- S4.11's five `PIN-ME` lines hold the printed hex (the plan's own
  fixture-only step 3). The WL-S4-4 line is in the S4.11 commit body; the
  WL-S4-5 result is in the S4.9 commit body.
- S4.10's import sits directly below the existing imports and the appended
  block follows one blank line, as the plan words it.
- The MERGE_HEAD check used the brief's `test -e "$(git -C ... rev-parse
  --git-path MERGE_HEAD)"` form (printed `ok` before every commit) instead of
  the plan's `ls`; equivalent.
- Extra verification beyond the plan (none committed): a GREEN on the
  verbatim `prompt.ts` before WL-S4-1, tsc after every task, the PR32
  negative probe, the S5 shape probe.
- No one-value test fix: every hand-worked expected value held as written
  (the fake's 70 / 80 / 45 / 0 / 55 / 80, latencies 7 and 420, the request
  shape, every message string).

## 9. What the plan got wrong / tree notes

- The two WORKLIST items above (the duplicate `PROPERTIES_SEEN_KEY`, the
  PR18-contradicting test header). Nothing else: every S4b block compiled,
  linted and passed as written against the real tree (S2's config, S3's
  cards, the SDK 0.129.0 types).
- The S4.7 RED note "(the helper imports it too)" is inaccurate but harmless:
  the helper's `prompt.js` import is type-only and erased (section 2 item 1).
- The S4.12 WI7 grep (`git grep`) sees tracked files only: before the S4.9
  commit it lists `extraction.ts` alone. Run it after the commit (done).
- Tests that build the anthropic driver without a logger write the
  counts-only "anthropic ranking usage" line to stdout (the default logger)
  - batchIndex, candidates, input and output tokens; no card text. Noise in
  the run output, not a defect.

## 10. QUESTIONS

None.

## 11. For the handback (Cameron)

- PR18 (already listed): the fingerprint covers the system text AND the
  schema sent, so the two landlord-switch states have two fingerprints
  (section 5).
- PR32: r1 / e1 are pinned by sha256 (section 5); a later edit to the
  rubric, the framing strings, the schema or the examples fails
  `rankingVersionPins.test.ts` until he decides a bump (a bump marks every
  stored match out of date).
- D17 item 1 (his run): `npx tsx app/scripts/extraction-schema-compile-check.ts
  --model claude-sonnet-5-5` with the testing key now makes FIVE calls; both
  `ranking-off` and `ranking-on` must print COMPILES. It cannot validate
  `claude-opus-5-5` (RUNBOOK.md:1562-1564).

## 12. For S5 (and S6, S8) - what S4 shipped

- `prompt.ts` (`app/src/services/ranking/prompt.ts`):
  - `buildRankingPrompt({ direction, batchIndex, landlordCard:
    config.rankingLandlordCard, anchor: { card, missing }, candidates, homes })`
    (PR19). S3's `AssembledRanking` passes AS IS: filter the candidates to
    `unverified === false` (`VerifiedCandidate` carries `candidateId`,
    `unitId`, `card`, `missing`, `pairHistory`, `propertyFacts`, `display`),
    `anchor: { card: r.anchor.card, missing: r.anchor.missing }`, `homes:
    r.homes` - type-checked (section 2 item 24). Batch order = pool order.
  - It THROWS `RankingPromptError` when a properties-seen entry names a home
    `homes` does not carry: record that batch failed (`driver`).
  - `prompt.batchInput` goes to `driver.rankBatch`; `prompt.userText` is the
    user message to gzip onto the run (D11); `prompt.promptFingerprint`;
    `prompt.handles` = `{ handle, candidateId, display }[]` (c1..cn);
    `prompt.snapshotOf(candidateId)` = `{ direction, anchor: { card,
    missing: string[] }, candidate: { handle, card, missing, pairHistory },
    homes: { handle, label, card }[] }` - the D8.1 JSON to pass to
    `encodeSnapshot`; it throws `RankingPromptError` for an id not in the
    batch. The match row adds `promptFingerprint`, `rubricVersion`,
    `examplesVersion` beside it (D8.1).
  - For a property anchor the anchor unit is read from the FIRST candidate's
    `unitId`, so every candidate of a `tenants_for_property` batch must carry
    the anchor's unitId (S3 does).
  - Also exported: `buildRankingBatch(src)` (no display; S8's counterfactual
    check), `snapshotOf(batch, handle)`, `buildRankingSystemPrompt()`,
    `renderUserContent`, `renderExamplesText`, `PROMPT_FRAMING`,
    `stableJson`, `rankingPromptFingerprint`, `ANCHOR_HOME_HANDLE`
    ('anchor'), `SEEN_HOME_KEY` ('home'), the wire types (`RankingWire`,
    `WireHome`, `WireCandidate`, `RankingBatchInput`, `RankingHandle`,
    `RankingPairSnapshot`, `PropertyFactsLike`, `RankingBatchSource`,
    `RankingBatchCandidateSource`, `RankingPromptInput`).
- `driverTypes.ts`: `RankingDriverKind`, `RankingFailure` ('refusal' |
  'parse' | 'truncated' | 'timeout' | 'driver'), `RankingUsage`
  (`inputTokens`, `outputTokens`, `cacheReadInputTokens?`), `RankingCallMeta`
  (`driver`, `model`, `promptFingerprint?`, `rawText?`, `usage?`,
  `latencyMs`), `RankingCall`, `RankingDriver`; type-only re-exports of
  `RankingEffort` and `RankingBatchInput`. No SDK import.
- `createRankingDriver(config, logger)` (`app/src/adapters/ranking.ts`):
  build it at boot - it throws for an unsupported model or a missing key
  (anthropic only), which stops startup. `rankBatch` never throws. `meta.model`
  is the model id or the literal 'fake' / 'console' (store it on the run and
  the match); `meta.usage` is undefined for fake / console and for an SDK
  error; `meta.rawText` is PII - never log it. Cost: `costUsd(call.meta.model,
  call.meta.usage, config.aiPriceTable)`. `output.byHandle` is a Map keyed by
  handle, in handle order - map back through `prompt.handles`.
  `output.droppedUnlawfulFlags` is the run's count.
- Driver log lines (counts only): anthropic "anthropic ranking usage" `{
  batchIndex, candidates, inputTokens, outputTokens }` once per call whose
  response carries usage counts (a refusal or truncation included);
  console "console ranking driver: scoring with the fake rules (offline)" `{
  batchIndex, candidates, homesSeen, userChars }`. Pass the job's logger so
  WI14's requestId context reaches them.
- The fake (hermetic stack, every e2e spec): start 70; -25 for rent
  (`final_rent`, else `rent_min`, else `rent_max`) above the tenant's maximum
  portion, for a recorded `no_pets` with tenant `pets` text
  (failedRequirements `no_pets`), for a recorded `no_evictions_on_program`
  with tenant `evictions` text; +10 when the area preference appears in the
  property's `area` or address; clamped 0-100. Seams read each CARD's
  `notes`: `[fake:fail-batch]` on the anchor or any candidate fails the batch
  (`driver`); `[fake:omit]` on a candidate leaves it out (not scored);
  `[fake:unlawful:<field>]` on the PROPERTY raises an unlawful flag on that
  field for every pair - through the production parser, so a checkbox or an
  empty field is dropped and counted. A tenant card's `notes` is the Notes
  box AFTER S3's attach step: put a seam on a Notes line that names no seen
  home.
- WI13: `capOf` has no production caller yet - S5's `cappedAtRun`, S6's read
  and S8's check call it from `cap.js` (it reads `landlord:<key>` as `<key>`).
- PR32: never edit `rubric.ts`, `examples.ts`, `schema.ts` or
  `PROMPT_FRAMING` without the orchestrator; `rankingVersionPins.test.ts`
  fails.
- `app/test/helpers/rankingBatchFixture.ts`: `propertyCardFixture`,
  `tenantCardFixture`, `factsOf`, `missing`, `NO_HISTORY`,
  `tenantsForPropertySource` (candidates `tenant-1..n`, unitId
  `unit-anchor`), `propertiesForTenantSource` - S5, S6 and S8 tests may
  import it.

## 13. Untrimmed input

None new. `prompt.ts` sends the cards as built (S3 trims every value); the
fake trims `notes`, `pets`, `evictions` and the area text before it tests
them and folds case for the area match; `parseRankingText` (S4a) trims every
returned text and handle. No typed user input enters an S4b code path.
