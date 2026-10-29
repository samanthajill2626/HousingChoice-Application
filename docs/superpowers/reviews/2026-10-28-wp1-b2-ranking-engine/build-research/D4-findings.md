# D4 delta-reader findings - B2a S4 "The model call"

- Reader: D4 (read-only, Phase 1 delta reader).
- Scope: plan section 8, S4 (tasks S4.1-S4.12): bands.ts, cap.ts
  (PR29 / PR40 / PR44 / PR45), cost.ts, schema.ts + the offline shape test,
  parse.ts, rubric.ts (r1), examples.ts (e1, PR31), prompt.ts (handles,
  homesSeen, PR18 fingerprint, PR20), driverTypes.ts, adapters/ranking.ts,
  adapters/rankingFake.ts (fake + console, PR8), the compile check's two
  `ranking` variants, the RUNBOOK subsection, the PR32 / R2F3 version pins.
  Watch items WI7 (S4 half), WI8 (fake half), WI13, WI21, WI22.
- Read: plan lines 1-590 (binding), 16252-21585 (S4) in full; S2's config
  and S2.3 completeness edits (3833-3910, 4405-4760, 5336-5432); S3's
  published shapes and the S3.1 / S3.4 / S3.6-S3.8 / S3.10-S3.11 code S4
  consumes (10010-10545, 10930-11000, 11080-11465, 12634-12664,
  13700-13818, 14140-14270, 14289-14580, 15125-15165, 15880-16030); S5's
  S4 call sites (22405-22660, 24040-24112, 24600-24700); spec D4-D6, D9
  and section 6; plan-drafts/S4-findings.md; plan-adjudications.md. Tree:
  main @404e039d + docs (node_modules installed: @anthropic-ai/sdk 0.129.0,
  TypeScript 5.9.3, vitest 3.2.6).
- Method: every S4 code block was extracted verbatim and compiled, linted
  and RUN in a scratch project outside the worktree against the real SDK,
  vitest and pino types, the live lib modules S4/S3 touch, S3's planned
  code verbatim where S4 depends on it, and stubs of S2's published shapes
  (details: `.superpowers/sdd/research/D4-reference.md` section 1).
- Verdict: S4 compiles, lints clean and goes green as written (191 of 196
  cases pass; the other 5 are the deliberate S4.11 `PIN-ME` REDs). No
  BLOCKER, no MAJOR. Five MINOR items; D4-2 and D4-3 change pinned prompt
  text, so they are cheapest before S4.11 pins r1 / e1.

## Findings

### D4-1 - MINOR - prompt.ts re-defines S3's `PROPERTIES_SEEN_KEY`

- Plan: S4.7 Step 3, prompt.ts (plan 19793-19795).
- Code fact: S3 publishes `PROPERTIES_SEEN_KEY = 'propertiesSeen'` from
  `services/ranking/cards.ts` (plan 10109, 14164); S4.6's test imports it
  from there (plan 18249). prompt.ts declares and exports its own copy.
- Problem: two homes for one card key - the key `rewriteSeen` relies on to
  replace every `home` unitId before anything reaches the model (PR20). A
  rename on one side would silently stop the rewrite (unitIds in the user
  text); today only S4.6's key-membership case would notice. No later slice
  imports prompt.ts's copy (grepped plan 21586-end).
- Correction: import `PROPERTIES_SEEN_KEY` from `./cards.js` in prompt.ts and
  drop the local export (keep `SEEN_HOME_KEY`). cards.ts does not import
  prompt.ts, so no cycle. Text in the reference, section 3. No pin changes.

### D4-2 - MINOR - the rubric's tenant-card list omits `created_at`

- Plan: S4.5 Step 3, rubric.ts, the `- A tenant card can hold:` element
  (plan 18147); FB25 "the rubric matches the cards".
- Code fact: S3's tenant card includes `created_at` ('Created',
  TENANT_BASE_FIELDS, plan 11215; written YYYY-MM-DD, plan 13741-13745), and
  every example tenant card carries it. Every other included tenant and
  property field IS named by the rubric (checked field by field against
  plan 11199-11217 and 11341-11373).
- Problem: the one card field the rubric does not describe; the model sees
  an unexplained `created_at` on every tenant.
- Correction (before S4.11 pins r1): add `created_at (when the record was
  made)` after `status` in that line (reference, section 4). The rubric
  tests stay green; the r1 rubric / system pins and both fingerprints
  change, which is expected before pinning.

### D4-3 - MINOR (optional, Cameron's call) - example cards are not in production key order

- Plan: S4.6 Step 3, examples.ts (plan 18579-19280); spec D4 / PR31 "the
  exact wire shape of a real call"; the R2F13 case (plan 18440-18452)
  checks key MEMBERSHIP only.
- Code fact: `propertyCard` / `tenantCard` emit keys in registry order then
  the derived keys (plan 13787-13800, 14247-14256; registries plan
  11199-11217, 11341-11373). All 22 example cards differ from that order
  (e.g. example 1's anchor puts `status` after `tour_type`; every example
  tenant puts `address` third instead of after `porting`).
- Problem: the worked examples show the model a different key order than
  every real call; semantics are unaffected and every test passes.
- Correction (only if wanted, and before S4.11 pins e1): reorder each card
  to the production order (exact per-card orders in the reference, section
  5) and optionally pin order in the R2F13 case. Otherwise leave it and say
  so in the handback beside "the examples for Cameron's reading".

### D4-4 - MINOR - pure S4 red/green steps hit globalSetup when DynamoDB Local is down

- Plan: every S4.n Step 2 / Step 4 command (e.g. plan 16791, 16930) runs
  plain `npx vitest run test/<file>`; plan section 0 says DynamoDB Local
  must be running; S3 (plan 10312-10316) tells the builder its pure files
  may use `ALLOW_SKIP_DYNAMO_TESTS=1`, S4 does not.
- Code fact: `app/test/globalSetup.ts:14-17, 72-86` THROWS when DynamoDB
  Local is unreachable unless `ALLOW_SKIP_DYNAMO_TESTS=1`.
- Problem: every S4 test file is pure (no DynamoDB), but with Docker down
  each RED fails in globalSetup, not for the stated "Cannot find module"
  reason, and each GREEN cannot pass.
- Correction: one line in the brief - S4's red/green runs either have
  DynamoDB Local up or prefix `ALLOW_SKIP_DYNAMO_TESTS=1` (never for the
  S4.12 slice run, which is a gate step).

### D4-5 - MINOR - `priceOf`'s return type differs between the export list and the code

- Plan: Cross-slice notes (plan 16452) say `priceOf(...): AiPrice |
  undefined`; S4.2's code (plan 17035) returns `Readonly<AiPrice> |
  undefined`.
- Problem: precision only - `Readonly<AiPrice>` reads and assigns as
  `AiPrice`, and S8's `priceOf` import compiles either way.
- Correction: align the export-list line to the code (or vice versa).

## Checked and fine

- SDK 0.129.0: the exact S4.9 request (model, max_tokens, `thinking:
  { type: 'adaptive' }`, `output_config: { effort, format: { type:
  'json_schema', schema } }`, system, messages) and options `{ timeout,
  maxRetries: 1 }` type-check against `MessageCreateParamsNonStreaming` and
  `RequestOptions` (request-options.d.ts:74, :82); `RankingEffort` equals
  the SDK effort union exactly (messages.d.ts:2115); `ThinkingConfigAdaptive`
  (messages.d.ts:2465); `Anthropic.APIConnectionTimeoutError` is a static of
  the default export (client.d.ts:349); 'refusal' and 'max_tokens' are
  `stop_reason` members; the `unknown` read of `cache_read_input_tokens`
  compiles; `message` narrows by assignment as in extraction.ts:304-325. A
  deliberate bad thinking type / effort errors TS2769, so C7's STOP rule
  will not fire and the S4.4 narrowing note needs no cast (TS 5.9.3).
- SDK runtime: `messages.create` sends `output_config` untouched (no schema
  mutation, messages.js:19-48); the per-request `timeout` skips the SDK's
  10-minute non-streaming guard (messages.js:29), so any
  RANKING_MAX_OUTPUT_TOKENS is accepted.
- All 22 S4 src/test files compile with 0 errors under the repo's strict
  base options and lint with 0 problems under the repo's TS rules (the `_`
  convention covers `_id`; no `import/first` rule, so the driver test's
  top-level `await import` before static imports matches
  extractionAdapter.test.ts:8-27).
- Run results: bands/cap 48, schema 20 (incl. the S4.10 cases), parse 30,
  rubric 14, examples 18 (with S3's real propertyMissing / tenantMissing /
  mapAuthorities and the live org starting list), prompt 26, fake 17,
  driver 18 - all pass; the 5 PIN-ME cases fail with their messages.
- Hand-worked values recomputed and executed: band floors 80/60/40; clamp
  and round (-0.4 gives +0, so `Object.is` holds); 80-char cut, first 3
  VALID reasons, 5 unknowns; dropped-unlawful count 6; enums 13 / 18 / 32
  and the landlord-twin order; 5 object nodes in both states; cost 12, 4,
  3, 0.008138, 0.000012, 0, 0, 2 and the haiku throw; fake 70 / 80 / 45 /
  0 / 55 / 80, latencies 7 and 420; every example's `missing` list (all
  five authority names are on lib/orgStartingList.ts; 'Stone Mtn HA' is
  not).
- PR32 print command (S4.11) runs as written via tsx from `app/`, calls
  nothing, prints six hashes; the values for verbatim plan text are in the
  reference (section 2) as a cross-check.
- Anchors byte-exact, unique, LF: compile-check 3a (lines 6-7), 3b
  (16-17), 3c (20), 3d (63-64); RUNBOOK.md 1545-1551. `VARIANTS` is
  exported and `main` is guarded by `invokedDirectly`, so importing the
  script in rankingSchema.test.ts runs nothing (WI7); the probe module it
  imports is side-effect free; no other test pins `VARIANTS`.
- ASCII: plan 16252-21585 has 0 non-ASCII bytes; no `\u` escape in any S4
  code (the Write tool decodes `\u` but keeps `\'`, `\n`, `\x..` -
  probed).
- WI22: UnitItem lines 449, 451, 457, 464, 471 (`pets?: string | boolean`),
  498, 507, 519, 525, 529, 535 match the tree; the `satisfies` tie compiles.
- WI7 / WI8 / WI13 greps over the extracted files: no `process.env`, no
  matching-input key in any S4 src file, `capOf` / `new Set(CAP_ELIGIBLE_KEYS)`
  only in cap.ts; S3's WI12 grep still matches only the two card builders.
- Cross-slice names: S2 (`RankingEffort`, `RANKING_SUPPORTED_MODELS:
  readonly string[]` so `.includes(model)` compiles, `DEFAULT_AI_PRICE_TABLE`
  2/10 and 4/20, `AiPrice`, `loadConfig(env)` config.ts:546,
  `anthropicApiKey?` / `anthropicApiBaseUrl?` config.ts:387/393, S2.3
  `completeness` literals); S3 (types, cardFields exports typed `readonly
  string[]`, completeness labels and order, cards.ts keys,
  PropertiesSeenEntry key order plan 14234-14242, `homes` holds missing
  units and the anchor unit plan 15159-15162 / 15946 / 16020).
- Later slices' imports from S4 (S5, S6, S8) all name exported S4 symbols;
  S5 passes `batchIndex` and `landlordCard` (plan 24657-24664, PR19) and
  calls `costUsd(model, usage, table)` in S4's order.
- RED / GREEN sequencing: each S4.n test fails on its own new module and
  needs nothing a later task adds; test and helper names collide with
  nothing in the tree or other slices.
- Smoke: every S4 relative import carries `.js`, no directory import;
  type-only re-exports in driverTypes.ts are elided.
