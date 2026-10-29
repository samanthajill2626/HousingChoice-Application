# S4a slice report - The model call, tasks S4.1-S4.6 (WP1 B2a)

- Implementer: S4a child (Claude Opus 5.5), 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Range: 9dc940ee (the S3 report, the commit before S4.1) .. 213dc326, plus
  this report's commit.
- Scope: plan section 8 - the slice head (Scope, Contradictions C1-C13,
  Cross-slice notes; plan 16252-16602) and tasks S4.1-S4.6 (plan
  16603-19298): `bands.ts`, `cap.ts`, `cost.ts`, `schema.ts` and its offline
  shape test, `parse.ts`, `rubric.ts` (r1), `examples.ts` (e1). S4.7-S4.12
  (prompt, drivers, compile check, version pins, close) are S4b's; the S4
  slice report (S4.12) is S4b's and links this file.
- Spec: D4 (the rubric, the worked examples), D5, D6 (price table and
  cost), D9 (bands and the Weak cap). Watch items: WI13, WI21, WI22, WI8
  (the reader scan over these files), WI7 (this range's half). WORKLIST:
  section G (G3 and G5 named by the dispatch), WL-S4-2, WL-S4-3, and a
  cross-check for WL-S4-4.
- Verdict: six tasks, one commit each, each RED for its stated reason
  (the missing module) and then GREEN. Every shipped file is byte-identical
  to its plan block (checked with `cmp` against `sed -n` of the plan ranges,
  section 2 item 23) except the two sanctioned WORKLIST edits: one line of
  `rubric.ts` (WL-S4-2) and the key-line order of the 22 example cards in
  `examples.ts` (WL-S4-3). No one-value test fix. No QUESTION. Close
  evidence: the six new files plus the reader scan, 138 tests green; root
  `npm run typecheck` exit 0; eslint on the 12 files exit 0; ASCII 0.

## 1. Tasks and commits

All paths under `app/`.

| Task | Commit | Files |
|---|---|---|
| S4.1 bands and the one Weak cap function | 1174c487 | `src/services/ranking/bands.ts`, `src/services/ranking/cap.ts`, `test/rankingBandsCap.test.ts` |
| S4.2 the cost of one call over config's price table | b5b1cbb6 | `src/services/ranking/cost.ts`, `test/rankingCost.test.ts` |
| S4.3 the output schema, its enums and the offline shape test | ad84caeb | `src/services/ranking/schema.ts`, `test/rankingSchema.test.ts` |
| S4.4 parseRankingText | 9c49e05f | `src/services/ranking/parse.ts`, `test/rankingParse.test.ts` |
| S4.5 the rubric, version r1 (+ WL-S4-2) | 4c5f8fa1 | `src/services/ranking/rubric.ts`, `test/rankingRubric.test.ts` |
| S4.6 ten synthetic worked examples, version e1 (+ WL-S4-3) | 213dc326 | `src/services/ranking/examples.ts`, `test/rankingExamples.test.ts` |
| report | this commit | `docs/.../slices/S4a-report.md` |

Every file is NEW; no existing file was edited. All twelve are on PR2's
S4 list (`services/ranking/{rubric,examples,schema,parse,bands,cap,cost}.ts`)
or are their tests.

## 2. Test commands and counts (every run, in order)

Command form, as the plan writes it (Bash `&&` for the plan's `;`):
`cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`.
DynamoDB Local was up (G1; `hc-dynamodb-local` running), so no
`ALLOW_SKIP_DYNAMO_TESTS` was needed (D4-4 moot). `env | grep -c '^AWS_'`
printed 0, so no `env -u` prefix.

1. S4.1 RED, `rankingBandsCap.test.ts`: 1 file failed, no tests ran -
   "Error: Cannot find module '../src/services/ranking/bands.js' imported
   from ...", caused by "Failed to load url ... Does the file exist?" (G4:
   vitest 3.2.6 wording; the stated reason - neither module exists, bands.js
   is the first import).
2. S4.1 GREEN: 1 file, 48 passed.
3. `npx eslint` (the 3 files) exit 0; `tenantMatchingInputsReaders.test.ts`
   3 passed; `tsc -p tsconfig.json --noEmit` exit 0; `tsc -p
   tsconfig.test.json` exit 0.
4. S4.2 RED, `rankingCost.test.ts`: "Cannot find module
   '../src/services/ranking/cost.js'".
5. S4.2 GREEN: 7 passed - including the last case (`loadConfig({
   CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' })` prices the default
   model at 2), which the D4 reader could not run against S2's real config.
6. eslint (2 files) exit 0.
7. S4.3 RED, `rankingSchema.test.ts`: "Cannot find module
   '../src/services/ranking/schema.js'".
8. S4.3 GREEN: 18 passed (the D4 reader's 20 includes S4.10's two
   appended cases).
9. eslint (2 files) exit 0; tsc src exit 0; tsc test exit 0 (the WI22
   `satisfies` tie compiles); reader scan 3 passed.
10. WI22 negative probe (not committed): a temporary
    `test/zz-wi22-probe.ts` with the test's `satisfies` shape over
    `'utilities' | 'pets'`; `tsc -p tsconfig.test.json` exit 2,
    "test/zz-wi22-probe.ts(3,41): error TS2322: Type 'true' is not
    assignable to type 'never'." - the tie really rejects a field that is
    not string-typed. The probe was deleted before the commit (`git status`
    showed only the two task files).
11. S4.4 RED, `rankingParse.test.ts`: "Cannot find module
    '../src/services/ranking/parse.js'".
12. S4.4 GREEN: 30 passed.
13. eslint (2 files) exit 0; tsc src and test exit 0 - TypeScript 5.9.3
    narrows `field` at `flags.push({ kind, field })`, so the plan's fallback
    cast note was NOT applied; reader scan 3 passed.
14. S4.5 RED, `rankingRubric.test.ts`: "Cannot find module
    '../src/services/ranking/rubric.js'".
15. S4.5 GREEN on the VERBATIM plan text: 14 passed. WL-S4-2 applied;
    GREEN again: 14 passed.
16. eslint (2 files) exit 0; tsc src exit 0; reader scan 3 passed.
17. S4.6 RED, `rankingExamples.test.ts`: "Cannot find module
    '../src/services/ranking/examples.js'".
18. S4.6 GREEN on the VERBATIM plan text: 18 passed. WL-S4-3 applied;
    GREEN again: 18 passed; the WL-S4-3 scratch check PASS (section 4).
19. eslint (2 files) exit 0; tsc src and test exit 0; reader scan 3
    passed.
20. Close run, the six new files plus the reader scan together: 7 files,
    138 passed (48 + 7 + 18 + 30 + 14 + 18 = 135, plus 3).
21. Root `npm run typecheck`, bare, from the worktree root: exit 0 (app
    src, scripts and test configs; dashboard; e2e; fake-twilio;
    fake-twilio-web).
22. `npx eslint` on all 12 S4a files, from the worktree root: exit 0.
23. Byte compare and ASCII sweep (`cmp` against `sed -n '<range>p'` of the
    plan; `tr -d '\11\12\15\40-\176' < FILE | wc -c`):

| File | Plan lines | ASCII bad | vs plan |
|---|---|---|---|
| `test/rankingBandsCap.test.ts` | 16616-16785 | 0 | identical |
| `src/services/ranking/bands.ts` | 16800-16821 | 0 | identical |
| `src/services/ranking/cap.ts` | 16827-16924 | 0 | identical |
| `test/rankingCost.test.ts` | 16959-17006 | 0 | identical |
| `src/services/ranking/cost.ts` | 17021-17055 | 0 | identical |
| `test/rankingSchema.test.ts` | 17091-17272 | 0 | identical |
| `src/services/ranking/schema.ts` | 17287-17419 | 0 | identical |
| `test/rankingParse.test.ts` | 17454-17705 | 0 | identical |
| `src/services/ranking/parse.ts` | 17720-17939 | 0 | identical |
| `test/rankingRubric.test.ts` | 17978-18092 | 0 | identical |
| `src/services/ranking/rubric.ts` | 18108-18191 | 0 | one line differs (WL-S4-2) |
| `test/rankingExamples.test.ts` | 18226-18514 | 0 | identical |
| `src/services/ranking/examples.ts` | 18529-19280 | 0 | key lines moved (WL-S4-3); same line multiset |

Every file was written with `sed -n` from the plan (G2), never through a
heredoc or the Write tool; the WORKLIST edits were applied after (section
4). `rubric.ts` carries the plan's 20 backslashes (the `\'` escapes),
counted in both; `examples.ts` carries none.

## 3. Watch items

- WI13 / PR7 (one cap function, one band function) - MET for S4's half.
  `grep -rn 'function capOf\|function bandOf\|new Set(CAP_ELIGIBLE_KEYS)\|CAP_ELIGIBLE_KEYS = ' app/src`
  matches only `bands.ts:17` (`bandOf`), `cap.ts:25` (the key list),
  `cap.ts:35` (its set) and `cap.ts:84` (`capOf`). `capOf` has PR3's
  signature (four `readonly string[]` fields, `{ capped, capReason }`); it
  reads `landlord:<key>` as `<key>` itself (`baseField`), so S5, S6 and S8
  pass flag fields as stored. 48 cases pin its contract, including every
  PR29 / PR40 / PR45 suppression and non-suppression case (section 5).
- WI21 (the schema shape) - MET. `rankingSchema.test.ts` runs, for BOTH
  landlord-switch states: exactly five object nodes (root, candidate, two
  inlined reasons, flag); `additionalProperties: false` and `required` equal
  to the property keys on every object (zero optional parameters); none of
  the eleven bound keywords (`minimum` .. `maxProperties`) anywhere; the
  spec D5 shape; the same object returned on every call. Enums pinned: 16
  sources, 13 requirement keys, 18 flag fields off / 32 on, 11 unlawful
  fields off / 18 on (the 7 free-text landlord twins).
- WI22 (the free-text fields are strings on `UnitItem`) - MET. The type
  line of each unlawful-flag free-text field, `app/src/repos/unitsRepo.ts`,
  `export interface UnitItem` at :383 (lines unchanged from the plan's C2):

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

  Ten are `string`; `pets` is the legacy `string | boolean` (plan C2: the
  unlawful rule reads the CARD's text through `unitItemValue`, never
  `UnitItem.pets`). The tie is a compile-time test:
  `rankingSchema.test.ts` `STRING_TYPED_FREE_TEXT ... satisfies { [K in
  FreeTextField]: UnitItem[K] extends string | undefined ? true : never }`
  over the ten, plus the runtime case "the free-text list is the
  string-typed set plus the legacy pets (WI22)". The negative probe
  (section 2 item 10) proves the tie fires. The S4 report (S4.12) can carry
  this block as is.
- WI8 (the reader scan) - MET for these files. `bands.ts`, `cap.ts`,
  `cost.ts`, `schema.ts`, `parse.ts` and `rubric.ts` are scanned the moment
  they exist (the scan lists `services/ranking/` at run time); `examples.ts`
  is the one exemption. `tenantMatchingInputsReaders.test.ts` 3 passed after
  every task. A grep of all seven S4a source files for `area_preference`,
  `max_tenant_portion`, `accessibility_need`, `preferences_constraints`
  finds nothing (examples.ts included - it keys the inputs by their labels).
  The rubric names the four inputs by LABEL; the case "names each tenant
  matching input by its list label" pins that.
- WI7 (S4a half: no network, no key) - MET. A grep of the seven source files
  for `process.env`, `ANTHROPIC`, `fetch(`, `@anthropic-ai` finds nothing;
  of the six test files, only `rankingCost.test.ts:40` calls `loadConfig`,
  with an EXPLICIT env object (`{ CF_ORIGIN_SECRET: 's', NODE_ENV:
  'development' }`), so it reads no `ANTHROPIC_*` from the shell. The
  scratch hash scripts (section 4) import only pure modules and call
  nothing. No `ANTHROPIC_*` value was read or printed (G6).

## 4. WORKLIST items

- G1 - honored: no `npm ci` / `npm install` / `npm run db:start`;
  DynamoDB Local and MinIO already running; no `AWS_*` exported.
- G2 - honored: every block written with `sed -n '<first>,<last>p' <plan> >
  <target>`, then line count, ASCII count and `cmp` (section 2 item 23).
  The WL-S4-2 edit was a single `sed -i 's/.../.../'` with no backslash on
  either side; WL-S4-3 moved whole lines with a scratch script (below). No
  `\u` escape exists in any S4a file.
- G3 (capOf's comments follow PR40 / PR45) - MET with no edit: the plan's
  S4.1 text already writes the rulings' meaning. `cap.ts:9-15` (b): an
  ACCOMMODATION is matched by requirement ITEM (PR29), with
  `qualifications` joining every cap-eligible item for accommodation only
  (PR45); `cap.ts:16-18` (c): an open UNLAWFUL flag lifts only a failure on
  its OWN field (PR40); `cap.ts:62` (`itemsOf`) and `:76`
  (`accommodationCovers`) are used for accommodation only.
  `rankingBandsCap.test.ts:96-104` says the same. `parse.ts:15` and
  `:145-149` (PR44: an accommodation is kept on any enum field; only an
  item field affects the cap, PR40) agree. No S4a comment says unlawful
  flags group by item, that `failedBatches` holds calls only, that an
  unwritten match throws, or that `promptFingerprint` is the system text
  only.
- G4 - every RED was the stated reason (the missing module); the vitest
  3.2.6 wording is "Cannot find module ... / Failed to load url ... Does
  the file exist?". No case behaved differently from the plan.
- G5 - honored: no S4a file defines `PROPERTIES_SEEN_KEY` (only
  `cards.ts:207` does); `rankingExamples.test.ts` imports it,
  `LANDLORD_DEFAULTS_KEY` and `LAST_HEARD_FROM_KEY` from `cards.js`. The
  card-field constants are imported from `cardFields.js` (PR33): `cap.ts`
  (`LANDLORD_FIELD_PREFIX`, `requirementItemOfField`), `schema.ts`
  (`LANDLORD_DEFAULT_KEYS`, `LANDLORD_FIELD_PREFIX`,
  `PROPERTY_FREE_TEXT_FIELDS`, `RANKED_REQUIREMENT_KEYS`), `parse.ts`
  (`EXCLUDED_REQUIREMENT_KEYS`, `RANKED_REQUIREMENT_KEYS`); a grep of the
  five logic files for `'landlord:'`, `'credit_requirements'`,
  `'income_requirements'` finds nothing. (WL-S4-1, prompt.ts's import, is
  S4.7's.)
- G6 - honored (WI7 above). G7 - every command ran in the foreground and
  finished in my turn; no e2e run.

- WL-S4-2 (the rubric's tenant-card line) - APPLIED in S4.5 (4c5f8fa1),
  after the RED and a GREEN on the verbatim text. Exactly: in `rubric.ts`
  line 40 (plan 18147), the `- A tenant card can hold:` element, the text
  `pets, evictions, status, voucher dates, customFields,` became
  `pets, evictions, status, created_at (when the record was made), voucher dates, customFields,`
  - one `sed -i` substitution whose pattern matched exactly once
  (`grep -c` = 1 before). `diff` against the plan block shows that one line
  and nothing else; `RUBRIC_TEXT` grows by 39 characters (10762 -> 10801).
  The 14 rubric cases stay green; no rubric case pins this line, so no test
  changed. sha256 of the verbatim plan rubric reproduces the D4 reference
  value `51c2cb4e...`, so the WL-S4-2 line is the only rubric delta. The
  commit body carries a "WORKLIST WL-S4-2: ..." line.
- WL-S4-3 (every example card in production key order) - APPLIED in S4.6
  (213dc326), after the RED and a GREEN on the verbatim text. Exactly:
  - A scratch script (`reorder-example-cards.mjs`, in the session
    scratchpad, not committed) read the verbatim `examples.ts`, found each
    `card: {` block, split its TOP-LEVEL entries (a key line, its
    continuation lines, and any comment lines directly above it - the one
    such comment, example 2's "PR20 / PR31: one seen home ..." block, stays
    above `propertiesSeen`) and stably sorted them by the production order:
    the property registry's included keys (address, status, beds, baths,
    area, subzone, rent_min, rent_max, final_rent, payment_standard,
    utilities, accessibility, washer_dryer, same_day_rta, application_fee,
    deposit, deposit_one_month, deposit_flexible, deposit_notes, no_pets,
    pets, pet_fee, no_evictions_on_program, evictions_notes,
    qualifications, lease_terms, tour_type, tour_process,
    application_process, notes, created_at) then voucherSizes,
    voucherSizesInferredFromBeds, authorities, landlordDefaults; the tenant
    registry's included keys (firstName, lastName, status, voucherSize,
    housingAuthority, voucher_expiration_date, rta_expiration_date,
    porting, address, tenure, pets, evictions, preferences_notes,
    customFields, created_at, staff_notes, notes, then the four inputs by
    label in list order) then lastHeardFrom, propertiesSeen. It throws on a
    key outside the order. It never edits a line; nested objects (address,
    authorities, seen entries, pair history) keep their order.
  - Result: all 22 cards moved (12 property, 10 tenant); each card's new
    order equals D4 reference section 5 line for line (the script lists
    example 2's cards in file order anchor, h1, c1, c2 where the reference
    lists anchor, c1, c2, h1 - per card the orders are equal).
  - Checks: line count 752 both; `diff <(sort verbatim) <(sort new)` empty
    (the same multiset of lines - only moves); ASCII 0; and a tsx check
    (`verify-example-order.mts`, scratch) that (a) takes the production
    order from the REAL registries (`includedFields(...)`, `cardKey ?? key`,
    then the derived-key constants from `cards.ts`) and finds all 22 cards
    in order, and (b) after putting each card's keys back in the verbatim
    card's order, `JSON.stringify` of the whole set equals the verbatim
    plan text's - key membership and every value unchanged. Control: the
    same check over the verbatim file flags all 22 cards out of order, so it
    is not vacuous.
  - The R2F13 membership test is unchanged (the WORKLIST says so); the
    optional order pin the D4 reference offers was NOT added - no committed
    test pins the order until S4.11 pins the rendered examples' sha256. The
    commit body carries a "WORKLIST WL-S4-3: ..." line.
  - The order reaches the model: S4.7's `renderExample` (plan 19898-19906)
    writes each example's input through `renderUserContent`, which is
    `JSON.stringify(wire)` (plan 19895) - insertion order kept, never
    re-sorted.
- WL-S4-4 (S4b computes the six pins) - NOT mine; cross-check values for
  S4b below. Computed with the plan's own S4.7 framing / render /
  fingerprint code (plan 19882-19943, copied byte-exact into a scratch
  module that imports the shipped `rubric.ts`, `examples.ts` and
  `schema.ts`; it calls nothing). Run over the VERBATIM plan rubric and
  examples, it reproduces every D4 reference section 2 value (rubric
  51c2cb4e..., framing 1f4690fb..., examples 4f87397c..., system
  9194048a..., fingerprints ae60986b... / b3868fa7..., 28,887 characters),
  so the replica is exact. Over the SHIPPED files (WL-S4-2 + WL-S4-3):

  ```
  rubric      2fdf3c3e189b172210362180dd2a6851416fea3a11389e77207081bbdeeda538
  framing     1f4690fb12bfceb3f15a61b831b16325648d546b3281b33a2f7c674ee88749ef
  schema off  14169f30e27245c76a3f5ee50807a73ff359999ac429b471d657694f0d5758eb
  schema on   587274585ffcac596cc1e1305c459ee9d4597c9f7523e9b5dca51bc5129022ba
  examples    c1bd64e7a42ecf1da7eb2b512d788698083b44414559fe103b389edb46be5fb8
  system      a4d00efd999b11ef8eded27d74225366113fd9dfaa5eebd4f7ac184ad7e1cb6a
  ```

  `rankingPromptFingerprint`: landlord off
  `33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9`, on
  `420d26d2cb9b99b47ca64ad9ce8e12c9a43ea7548ef758323fa0ba15d6c8a4e5`;
  system text 28,926 characters (28,887 + the 39 of WL-S4-2). framing and
  both schemas equal the D4 reference (no S4a change touches them); rubric,
  examples, system and both fingerprints differ, as WL-S4-4 expects. These
  are CROSS-CHECKS: S4.11's print command over the real `prompt.ts` is the
  authority. A mismatch on examples / system / fingerprints with rubric and
  framing matching points at `prompt.ts`, not at S4a's files.
- WL-S4-1 (prompt.ts imports `PROPERTIES_SEEN_KEY`) and WL-S4-5 (SDK
  typing) - S4b's; untouched.

## 5. Head contradictions and rulings applied in this range

- C2 / WI22: section 3.
- C3 (landlord twins): the twins are `landlord:<each of the 13 reportable
  requirement keys>` plus `landlord:notes` (14); the unlawful twins are the
  seven free-text ones; 18 / 32 flag fields - derived in `schema.ts` from
  S3's `LANDLORD_DEFAULT_KEYS` and pinned by its tests.
- C4 (unknown enum values): a reason with an unknown source is dropped,
  never re-labelled; the cut to three counts only valid reasons; unknowns
  cut to five after empties are dropped - `rankingParse.test.ts` "keep the
  first 3 VALID reasons" and "keep the first 5 non-empty strings".
- C5 (a non-finite score): no parsed result, listed in `unscoredHandles` -
  the "a string / null / absent score" cases.
- C11 (one home for the price table): `cost.ts` takes the table as an
  argument (`costUsd(model, usage, priceTable)`) and imports only the TYPE
  `AiPrice` from `lib/config.ts`; the cases run over S2's
  `DEFAULT_AI_PRICE_TABLE` and `loadConfig`'s `aiPriceTable`.
- C12 (S5's names, this range's part): `ParsedRanking` is constructible as
  `{ byHandle, droppedUnlawfulFlags }` - `duplicateHandles`,
  `unknownHandles`, `unscoredHandles` are optional in the type and always
  set by `parseRankingText`.
- C13 (this range's part): PR29 as amended by PR40, PR44, PR45 in `capOf`
  (48 cases: cross-key accommodation suppression both ways inside the Pets
  and Evictions items, `landlord:` twins, PR45's qualifications join both
  ways and its "both places" shape, unlawful flags per field only, a field
  of no item suppresses nothing); PR33 (S4 defines no field constant;
  section 4 G5); PR44 (an accommodation flag on any enum field is kept -
  the parse case "PR44: keeps an accommodation flag on ANY field of the
  enum"); the rubric matches the cards (FB25), scopes eligibility to
  candidates (R2F14), says card text is data (FB26) and gives ONE
  accommodation instruction (PR41, PR45); PR31 / R2F13: the examples carry
  the production `missing` labels (S3's real `propertyMissing` /
  `tenantMissing` run in the test), seen entries with `label` and `home`,
  and all three home references (`h1` in example 2, `c2` in example 2,
  `anchor` in example 7).
- C1 and C6-C10 are S4.7-S4.9's.
- D4-5 (WORKLIST "Not adopted"): `priceOf` returns `Readonly<AiPrice> |
  undefined` as the code block writes it; the export-list line's `AiPrice |
  undefined` was not chased.

## 6. Deviations from the plan text

- WL-S4-2 and WL-S4-3 (binding WORKLIST items; section 4). Each commit
  body carries one "WORKLIST WL-S4-n: ..." line under the plan's subject
  (the S3 precedent).
- S4.5 and S4.6 each ran GREEN twice: on the verbatim plan text and after
  the WORKLIST edit (extra evidence that the edit changes no test result).
- The MERGE_HEAD check used the brief's `test -e "$(git -C ... rev-parse
  --git-path MERGE_HEAD)"` form (it resolves to `W:/AI Projects/Housing
  Choice/HC Application/.git/worktrees/wp1-b2-ranking-engine/MERGE_HEAD`;
  printed `ok` before every commit) instead of the plan's `ls`; equivalent.
- S4.4's fallback cast note (`field: field as string`) was not needed and
  not applied: tsc narrows `field` (section 2 item 13).
- Extra verification beyond the plan: `cmp` of every block, tsc and the
  reader scan after every task, the WI22 negative probe, the WL-S4-3
  registry check, and the WL-S4-4 cross-check hashes. None of it is
  committed (scratchpad only).
- No one-value test fix: every hand-worked expected value held as written.

## 7. QUESTIONS

None.

## 8. For the handback (Cameron)

- PR28: the rubric r1 (`app/src/services/ranking/rubric.ts`) and the ten
  worked examples e1 (`app/src/services/ranking/examples.ts`) are for his
  reading. Two orchestrator changes to the plan's text, both made before
  any version pin: the rubric's tenant-card line also names `created_at
  (when the record was made)` (every tenant card carries it; WL-S4-2), and
  every example card lists its keys in the order a real card does
  (WL-S4-3; content unchanged).

## 9. For S4b (S4.7-S4.12) - what S4a shipped

- Exports (names and shapes as the Cross-slice notes block, plan
  16436-16477):
  - `bands.ts`: `Band`, `BAND_FLOORS` (80 / 60 / 40, frozen), `BAND_ORDER`
    (strong, good, possible, weak), `bandOf(score)`.
  - `cap.ts`: `CAP_ELIGIBLE_KEYS` (readonly tuple of the five),
    `CAP_REASON` ('requirement not met'), `baseField(field)`,
    `flagFieldsOfKind(flags, kind)`, `CapInput`, `CapResult`,
    `capOf(input)`.
  - `cost.ts`: `priceOf(priceTable, model): Readonly<AiPrice> | undefined`
    (own keys only), `costUsd(model, usage | undefined, priceTable)` - 0 for
    model `fake` / `console` or no usage; throws "no price for model <id> in
    AI_PRICE_TABLE" for an unpriced billed model; rounded to 1e-6.
  - `schema.ts`: `RANKING_SOURCES` (16), `RankingSource`,
    `flagFieldsFor(landlordCard)`, `unlawfulFieldsFor(landlordCard)`,
    `rankingSchema({ landlordCard })` - the SAME object per state, built
    once at module load (`toBe` holds), so S4.10's `VARIANTS` must
    reference `rankingSchema(...)` itself.
  - `parse.ts`: `MAX_REASONS` 3, `MAX_REASON_CHARS` 80, `MAX_UNKNOWNS` 5,
    `FlagKind`, `RankingReason`, `RankingFlag`, `ParsedCandidate`,
    `ParsedRanking` (three handle lists optional in the type, always set),
    `RankingParseContext` (`handles`, `freeTextByHandle`, `landlordCard`),
    `RankingParseResult`, `parseRankingText(text, ctx)` - never throws;
    whole-output messages are fixed strings ("ranking output is not valid
    JSON", "ranking output has no candidates list") carrying none of the
    text; `byHandle` is in `ctx.handles` order.
  - `rubric.ts`: `RUBRIC_VERSION` 'r1', `RUBRIC_TEXT` (10,801 characters,
    LF-joined).
  - `examples.ts`: `EXAMPLES_VERSION` 'e1', `ExampleHome`,
    `ExampleCandidate`, `ExampleOutputEntry`, `RankingExample`,
    `RANKING_EXAMPLES` (10). Each example's `anchor` is `{ card, missing }`,
    `homesSeen` entries `{ handle, label, card }`, candidates `{ handle,
    card, missing, pairHistory }` - the wire's member names.
- Runtime import graph of the S4a files (no cycle): `bands.ts`,
  `rubric.ts` import nothing; `cap.ts` -> `cardFields`; `schema.ts` ->
  `cardFields`; `parse.ts` -> `cardFields`, `schema`; `cost.ts` and
  `examples.ts` import types only (`lib/config`; `schema`, `types`). None
  imports `cards`, `assemble` or a later S4 file, so `prompt.ts` and the
  drivers may import any of them.
- S4.10 APPENDS to `app/test/rankingSchema.test.ts` (and adds the
  `VARIANTS` import below the existing imports): re-read it first; its 18
  current cases must stay green.
- WL-S4-4: compute the six pins with S4.11's print command AFTER S4.7;
  the expected values are in section 4 (WL-S4-4). Record all six and both
  fingerprints in the S4 report.
- WI22: the S4 report can carry section 3's quote block as is.
- The reader scan already covers `bands.ts` .. `rubric.ts`; `prompt.ts`
  and the drivers must not spell the four input keys (the fake finds them
  through the list by `kind` / `completeness`, WI8).
- WI13: S5's `cappedAtRun`, S6's read and S8's check call `capOf` from
  `cap.js`; `capOf` reads `landlord:<key>` as `<key>`, so flag fields pass
  as stored.

## 10. Untrimmed input

None new. `parseRankingText` trims every reason text (before and after the
80-character cut), every unknown and every returned handle (" c3 " matches
c3; case is kept, so "C2" is an unknown handle, as the plan's case pins);
an unlawful flag needs non-empty TRIMMED text on its field. `capOf` and the
schema compare enum keys exactly (they are code-defined keys, not typed
input).
