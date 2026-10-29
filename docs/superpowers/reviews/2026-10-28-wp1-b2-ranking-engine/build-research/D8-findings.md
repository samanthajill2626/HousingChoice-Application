# D8 findings - S8 The merge-gate scripts and the docs (S8.1-S8.11)

- Reader: D8 (read-only delta reader, B2a build Phase 1).
- Scope: plan section 12, S8: the counterfactual check (records.ts,
  swaps.ts, evaluate.ts, the cards.ts / plan.ts adapters, report.ts, the CLI
  with `--timing` and `--dry-run`), the env example files (PR35 / PR39 and
  the S8.6 layout test), gate-run-commands.md, RUNBOOK "AI ranking (WP1
  B2a)" and the dev-modes edit, GLOSSARY, the issue registry, the S8.11
  close. Spec D17, D19, spec 5 docs; watch items WI7, WI12, WI13 (S8 parts).
- Read: plan lines 1-590 (binding) and 35514-39630; the S2-S4 text S8
  consumes (S2.1 / S2.2 config incl. PR30 rules, S3 Published shapes and
  S3.1 / S3.6 / S3.7 registries and cards, S4.1 cap, S4.2 cost, S4.3 schema,
  S4.4 parse, S4.7 prompt, S4.8 driverTypes, S4.9 adapters/ranking.ts,
  S4.10 compile check, S5 job messages); spec D16, D17, D19, sections 2 and
  5. Code: app tsconfig / tsconfig.scripts / tsconfig.test, vitest.config,
  eslint.config.mjs, package.json scripts, lib/config.ts, lib/logger.ts,
  lib/orgStartingList.ts, lib/address.ts, lib/requirements.ts,
  contactsRepo / unitsRepo item types, extraction-prompt-probe.ts and
  extraction-schema-compile-check.ts (CLI conventions), scripts/
  secrets.mjs, secretsSync.mjs, lib/secretsCore.mjs, dev.mjs,
  lib/devMode.mjs, deploy.mjs hydrate, docker-compose.yml, the three env
  examples, RUNBOOK.md, documentation/GLOSSARY.md, docs/issues README /
  _TEMPLATE / the five edited issues, scripts/issues.mjs.
- Method beyond reading (scratch only, outside the worktree; details in
  `.superpowers/sdd/research/D8-reference.md`): every S8 code block
  extracted with S8.5's edits applied (all six anchors unique); compiled with
  the repo's options against stubs of the published S2-S4 shapes (S4's
  cap / cost / schema / parse / driverTypes are the plan's own code):
  `tsc` exit 0, ESLint (repo rule set) exit 0; run in a simulation with
  production-keyed card / prompt stubs: S8.1 17/17, S8.2 14/14, S8.3 14/14,
  S8.4+S8.5 29/29 cases pass; S8.6 edits applied to copies of the env
  examples: layout cases pass, real `syncEnvFromExample` run on them.
- Verdict: S8 is buildable as written - no BLOCKER; the code compiles and
  every hand-worked expectation checked out. One MAJOR: S8.11's PR1 check
  (`printenv ANTHROPIC_API_KEY`) prints the key if it is set. The rest are
  MINOR precision fixes (watch-item and citation greps that hit the wrong
  files, two RED claims, doc drift S8 leaves beside its new text).

## Findings

### D8-1 - MAJOR - the PR1 dry-run check prints the API key when it is set

- Plan: S8.11 step 3 (plan 39543-39551): "check first; it must print
  nothing" then `printenv ANTHROPIC_API_KEY`.
- Fact: `printenv NAME` writes the variable's VALUE to stdout. Plan section 1
  (line 75-76) and PR1 say no agent reads `ANTHROPIC_API_KEY`; WI7 the same.
  If the builder's shell carries a key (agent harness or operator profile),
  the check copies it into the transcript and possibly the S8 report.
- Correction: drop `printenv`; run the dry run with the key removed for the
  child only: `cd W:/tmp/wp1-b2-ranking-engine; env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL npx tsx app/scripts/ranking-counterfactual-check.ts --model claude-sonnet-5-5 --dry-run`.
  The CLI never reads the key in a dry run (plan 38218-38219), so nothing
  is lost. A presence check, if wanted, must not echo the value (reference
  file, D8-1).

### D8-2 - MINOR - S8.11's WI7 / WI12 / WI13 greps will not print what the plan expects

- Plan: S8.11 step 6 (plan 39564-39575): WI7 grep "prints nothing", WI12
  grep "lists only ... cards.ts", WI13 grep "lists only ... evaluate.ts".
- Fact (greps run on the extracted files): WI7 hits the S8.4 test's own
  header comment "reads ANTHROPIC_API_KEY from process.env" (plan 37257).
  WI12 also lists `ranking-counterfactual-check.ts` (header comment
  "(tenantCard / propertyCard)", plan 37940). WI13 also lists the CLI
  header "cap (capOf)" (plan 37942), records.ts's C3 comment "in capOf
  (PR45)" (plan 36268) and report.ts's rule string "production's capOf"
  (plan 37900). All are comments or strings, not code calls.
- Correction: grep calls, not names: `"tenantCard(\|propertyCard("` and
  `"capOf("` (verified: only cards.ts and evaluate.ts), and reword the S8.4
  test comment to "from the environment" (or accept that one comment hit in
  the report). Exact commands in the reference file.

### D8-3 - MINOR - two RED claims are wrong (cases that already pass)

- Plan: S8.5 Step 2 (plan 38313-38320) "the three new cases fail";
  S8.6 Step 2 (plan 38651-38654) "the per-file cases fail".
- Fact (run): on S8.4's code the third S8.5 case (`--timing --dry-run`)
  PASSES - `runCheck`'s dry-run branch (plan 38189-38191) prints "Dry run:
  no call made." and returns 0. Only the first two fail. In S8.6 the
  per-file "never sets a ranking variable to a blank value ... or the worker
  poll to off" case passes on the unchanged files (no ranking key to check;
  `RANKING_WORKER_POLL` is undefined, not 'off'): 6 of 9 per-file cases
  fail, 3 pass.
- Correction: reword both expectations (each task still has real RED
  cases), so the builder does not stop on an "unexpected pass".

### D8-4 - MINOR - S8.10's citation greps list the Staff notes guard's files

- Plan: S8.10 step 3 (plan 39342-39349) and 3b ("Pinned by <the app/test
  file(s) the notes_stale grep lists> and <the e2e spec the second grep
  lists>", plan 39416-39417).
- Fact: today `git grep -l "notes_stale" -- app/test` prints
  `app/test/contactStaffNotes.test.ts` and
  `app/test/landlordRequirementsPatch.test.ts` (both `staff_notes_stale`);
  the second grep prints `dashboard/src/api/types.ts`,
  `StaffNotesCard.tsx`, `StaffNotesCard.test.tsx` and
  `e2e/tests/dashboard-next/tenant-staff-notes.spec.ts` - the Staff notes
  card already says "These notes were changed since this page loaded."
  (StaffNotesCard.tsx:186, asserted at tenant-staff-notes.spec.ts:140). A
  builder citing "what the grep lists" cites the wrong tests in a committed
  issue.
- Correction: `git grep -lw "notes_stale" -- app/test` and
  `git grep -lw -e "notes_stale" -e "since you opened this form" -- e2e/tests dashboard/src`
  (both exit 1 today, so after S1 / S7 they list only the new files).

### D8-5 - MINOR - the closed issue misquotes S1's conflict copy

- Plan: S8.10 3b resolution (plan 39414-39416) quotes "These notes were
  changed since you opened this form. ... Nothing was saved." and says the
  form shows the current notes "beside the box".
- Fact: S1's copy (plan 716, 3293) begins "Nothing was saved. These notes
  were changed since you opened this form. The current notes are below,
  ...".
- Correction: quote the built text (cross-check ContactEditForm.tsx the way
  S8.8 cross-checks RUNBOOK copy); "below", not "beside".

### D8-6 - MINOR - stale ANTHROPIC_API_KEY guidance left beside S8's new text

- Plan: S8.6 3b / 3c (plan 38727-38738, 38779-38791: the key is "REQUIRED
  whatever AI_EXTRACTION_ENABLED says") and S8.8 "The API key" (plan
  39056-39060). Neither edits the existing statements.
- Fact: `.env.dev.example:209-212` and `.env.prod.example:234-237` still
  say the key is "The ONLY operator SECRET this feature needs" and "Required
  only when AI_EXTRACTION_ENABLED=true with EXTRACTION_DRIVER=anthropic";
  `RUNBOOK.md:1470` says "Required when `AI_EXTRACTION_ENABLED` and
  `EXTRACTION_DRIVER=anthropic` in production". After S2.2 (production
  requires the key whatever the extraction flag) these contradict the new
  block 20 lines below, and `secrets:sync` copies the stale comment into the
  real `.env.dev` / `.env.prod`.
- Correction: S8.6 / S8.8 (S8 owns both files) replace the three passages;
  suggested ASCII text in the reference file.

### D8-7 - MINOR - the shared poll interval's docs omit the ranking poll

- Plan: S5 runs the ranking poll on `WORKER_POLL_INTERVAL_MS` (plan
  21672-21676); S2.1 fixes only config.ts's comment; S8.8 does not touch
  RUNBOOK's poll-cadence text.
- Fact: `RUNBOOK.md:1334-1335` "One interval drives **five** due-row polls
  ... and group guardrails" (already short of the journal sweep), and
  `.env.dev.example:234-236` / `.env.prod.example:259-261` list the same five.
  S8.8's section never says a pressed job waits up to one poll tick (30 s)
  before a worker claims it.
- Correction: name the journal sweep and the ranking poll in all three, and
  add one line to S8.8's section (reference file, D8-7).

### D8-8 - MINOR - the deploy checklist's key pattern misses RATE_LIMIT_RANK_PER_MIN

- Plan: S8.8 checklist (plan 39157-39158): "give each new `RANKING_*` /
  `AI_*` key the value its example line carries".
- Fact: `RATE_LIMIT_RANK_PER_MIN` matches neither prefix, yet the real
  `syncEnvFromExample` adds it empty like the rest (run on the edited
  copies: dev 20 new keys, prod 21, every one `KEY=`). `secrets:push`
  would refuse and name it (secrets.mjs:163-169), so this costs a retry,
  not a bad push.
- Correction: "each new key (the `RANKING_*` lines, `AI_RANKING_MODEL`,
  `AI_PRICE_TABLE`, `RATE_LIMIT_RANK_PER_MIN`)".

### D8-9 - MINOR - gate sheet: the compile check prints no endpoint line

- Plan: S8.7 "Before you start" (plan 38875-38877): "each command prints
  the endpoint host it will use and whether a token is set".
- Fact: `app/scripts/extraction-schema-compile-check.ts:83` prints only the
  model, the key tail and the call count; only the counterfactual CLI prints
  `endpointLine` (plan 38181, 38443). The SDK still honors
  `ANTHROPIC_BASE_URL` for the compile check.
- Correction: "the counterfactual check prints it - read it on the dry run
  (the first command), which runs in the same shell as the compile check".

### D8-10 - MINOR - GLOSSARY drift S8.9 leaves

- Plan: S8.9 (plan 39247-39315) appends the ranking nouns only.
- Fact: `documentation/GLOSSARY.md:281-282` still says of the requirements
  "Nothing filters or ranks on them yet (Work Package 1's AI ranking reads
  them)" - stale once B2a ships (AGENTS.md: fix glossary drift in the same
  change). The new "Pool" and "Match" sit beside "pool number" (relay,
  :307, :319) and "Matching" (the sends section, :117) with no clause that
  tells them apart.
- Correction: update :281-282 (reference file) and add "(not a relay pool
  number)" / "(not the Matching send section)".

### D8-11 - MINOR - slice text that still contradicts PR39 / PR41

- Plan: CLI header comment (plan 37954-37957) "Two controls run three times
  in each direction" - PR41 made three (C3). S8 scope bullet (plan
  35533-35534) "the D19 variables, uncommented with their defaults" - PR39
  comments two of them (S8.6 itself implements PR39 correctly).
- Correction: "Three controls ... (C3: an assistance animal against a pets
  rule written only in qualifications)"; the scope bullet should cite PR39's
  two commented keys.

### D8-12 - MINOR - C12 overstates what the record holds

- Plan: C12 (plan 35626-35628) "Every run's score, cap and flag count is in
  it"; spec D17 "It writes the full result, verbatim".
- Fact: `renderCheckRecord` (plan 37887-37928) writes per-run SCORES, a cap
  COUNT per group (not per run), and flag counts for controls only - no
  per-run cap state and no flags for base or variant runs (an unexpected
  flag on, say, the religion swap would not appear).
- Correction: either fix C12's sentence (and the gate sheet's reading
  notes) or add per-run "capped / flags" to the swap rows; Cameron should
  know which before the run.

### D8-13 - MINOR - a bad --out path loses the whole paid run

- Plan: `appendRecord` runs only after every call (plan 38203, 38454; the
  default is `appendFileSync`, plan 38093) and before the verdict is printed
  (plan 38204-38206).
- Fact: a missing directory (for example the command run from a checkout
  without `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/`, which
  main does not have before merge) throws ENOENT after ~414+ calls; `main`
  prints only "FAILED: ENOENT ..." - no verdict, no table.
- Correction: before `createDriver`, refuse (exit 2) when
  `dirname(resolve(out))` does not exist; or, on an append failure, print the
  rendered record to stdout before returning 1.

## Checked and fine

- Compile: the 7 S8 script files and 5 test files (S8.5 edits applied)
  type-check under the repo's strict / NodeNext / noUncheckedIndexedAccess
  options against the published S2-S4 shapes; ESLint (repo rule set) clean;
  `_unused` params pass the `^_` ignore pattern.
- Simulation: every S8.1-S8.5 case passes, including the nth-based policies
  (sequential `pool(..., 1)`, group A before B before missed swaps in stage
  two), the record rows and the reasons text.
- Hand values: 414 = 6 x 2 x 33 + 18 (207 per direction); worst stage two
  660 = 6 x 2 x 11 x 5; SMALL 42 (21 per direction); 62 = 42 + 2 x 10
  (rescue, over-tolerance, noise); mean move 3 (584 / 8 = 73); evaluate:
  5.0 within, 5.33 over, mean 72, cap diffs 1-of-3 pass / 2 miss, 3-of-8 pass
  / 4 fail, noise 5 / 6; key tail "...wxyz"; "C1/tenants_for_property/control/2".
- Anchors: every quoted S8 old text exists exactly once - `.env.example`
  (:199-200), `.env.dev.example` (:231-232), `.env.prod.example` (:256-257),
  RUNBOOK `### What the health-check gate does` (:1700), the dev-modes table
  (:75-80), `**CAVEAT - SMS kill-switch.**` (:103), GLOSSARY (:855-856, then
  `---` and "## For the future AI layer"), all five issue frontmatters; the
  six S8.5 anchors in S8.4's check.ts. No env file has CRLF.
- PR1: the CLI's import graph constructs no Anthropic client and calls no
  `loadConfig()` at import (config.ts has none; adapters/ranking.ts builds
  the client only in `AnthropicRankingDriver`'s constructor; logger.ts makes
  only a pino logger); a dry run reads no key and builds no driver.
- Cross-slice names: `tenantCard` / `propertyCard` / `propertyFacts`,
  `TenantCardCtx { now, seenMax, seen }`, `PropertyCardCtx { orgEntries,
  landlordCard, landlord? }`, `tenantMissing(contact)`,
  `propertyMissing(unit, ctx)`, `PropertyFactsLike`, `RankingBatchInput`
  (`wire`, `handles`, `freeTextByHandle`, `user`, `system`),
  `buildRankingBatch`, `rankingPromptFingerprint`,
  `buildRankingSystemPrompt()`, `parseRankingText(text, ctx)`,
  `ParsedCandidate`, `capOf` / `flagFieldsOfKind` / `baseField`,
  `costUsd(model, usage, table)`, `priceOf(table, model)`, `RankingCall` /
  `RankingCallMeta` / `RankingFailure` ('refusal' included),
  `createRankingDriver(settings, logger)`, `isSupportedRankingModel`,
  `RankingDriverSettings`, `RUBRIC_VERSION`, `EXAMPLES_VERSION`,
  `DEFAULT_AI_PRICE_TABLE`, `RANKING_SUPPORTED_MODELS` - all match.
- Card keys: the tenant card keys are the stored keys (`firstName`, `pets`,
  `notes`, `address`, `housingAuthority`) and the property card's include
  `qualifications`, `no_pets`, `pets`, so the stub driver's detectors work
  and every swap changes the call text.
- Cap facts the tests rely on: `pets` and `qualifications` are
  CAP_ELIGIBLE_KEYS; P1's `pets: 'Cats welcome'`, C2 / C3 `qualifications`
  and C1's two Pets keys are recorded through `unitItemValue`; `deposit` and
  `pet_fee` are in the landlord-off flag enum (C3 deposit case parses).
- loadConfig: development without a key does not throw under S2.2 (key
  required only in production), so the COUNTERFACTUAL_REQUEST pin and both
  S8.6 loadConfig cases hold; `parseAiPriceTable` accepts the example JSON.
- Synthetic data: every authority name used is verbatim in
  lib/orgStartingList.ts (DBHDD :28, DeKalb, Atlanta, East Point, College
  Park, Decatur); `buildStartingEntries(now, newId)` signature matches;
  ContactItem and UnitItem carry index signatures and UnitItem declares
  `no_pets?: true`, `pet_fee`, `qualifications`, `deposit`; `Address` type ok.
- Secrets / deploy facts PR35 / PR39 / C13 state: sync adds new keys as
  `KEY=` (secretsCore.mjs `syncEnvFromExample`, verified by running it);
  secrets.mjs:163-169 refuses empty values for push and check; deploy.mjs
  gates on `secrets check`; `parseDotenv` keeps the unquoted JSON verbatim;
  push uses one `--value=<v>` token, no shell; the hydrate writes
  `KEY=value`; docker-compose.yml takes the whole file via `env_file: .env`;
  dev.mjs loads `.env.dev` then `.env` (`.env` wins); devMode.mjs refuses
  `hc-prod-`; secretsSync handles dev | prod only.
- Tooling: `app/tsconfig.scripts.json` includes `scripts`; tsconfig.test
  pulls the scripts in through the tests' imports; the smoke build compiles
  `src` only; vitest has no include override, so `app/test/*.test.ts` are
  collected and nothing is placed under scripts; the main guard is
  extraction-schema-compile-check.ts:102's form (vitest's argv[1] never
  matches); tsx 4.22.4 is at the root `node_modules/.bin`.
- Docs: RUNBOOK section lands under "## Daily operations" between "### AI
  extraction" (:1442) and the health-check gate, with "Changing a
  structured-output schema" (:1545) and "Dev modes" (:69) above as the text
  says and `[Secrets](#secrets)` resolving to `### Secrets` (:772); RUNBOOK
  job messages match S5's builders; issue files exist, carry no `updated:`
  yet, and the README order (created / updated / resolved / refs) and
  statuses (`resolved` + `resolved:`) are followed; S2.4's
  `TODO(units-contacts-batchget-walk-duplicated)` and S1.7's `importedAt`
  stamp exist as the update texts say; no test reads the env examples,
  RUNBOOK, GLOSSARY or docs/issues.
- ASCII: the S8 plan section has 0 non-ASCII bytes, so every added line it
  carries is ASCII; the edited env-example copies add none.
