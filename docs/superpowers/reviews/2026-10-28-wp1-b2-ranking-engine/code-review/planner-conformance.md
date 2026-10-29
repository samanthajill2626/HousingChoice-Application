# Planner spec-conformance review - WP1 B2a Ranking engine

Reviewer: independent spec-conformance reviewer (planner dispatch, read-only).
Branch: feat/wp1-b2-ranking-engine at 486e726c (code identical to 542e6874),
base main @404e039d. Diff read: `git diff main...486e726c`.
Contract: spec rev 6 (docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md),
mission-block.md (S1-S9), intent.md (Cameron verbatim), plan section 4 (PR1-PR45).
The build's own review records (code-review/R*, FW*, slices/, build-research/,
handback.md, self-qa.md) were NOT read.

## Summary

D1-D19: 19 CONFORMS (5 of them through a named PR ruling), 0 PARTIAL, 0 MISSING,
0 DEVIATES without a ruling. Human-decision checks: 12 of 12 hold in code.
Repo rules: all hold. Findings: 0 blocking, 0 high, 0 medium, 2 low.

Verification done beyond reading: ran seven fake-only test files
(rankingFingerprintInvariants, rankingPrompt, rankingTenantCard, rankingAssemble,
rankingReadDerive, contactNotesGuard, extractionNoteLines) with
ANTHROPIC_API_KEY unset: 171 tests passed. Disclosure: vitest's globalSetup
still created and then dropped the worktree key's `hc-local-` tables in
DynamoDB Local (22 created, 23 dropped) even though no test used them. No
throwaway test was added; nothing was committed; no key was read; no model ran.

## D1-D19 verdicts

| D | Verdict | Evidence (code) | Ruling |
|---|---|---|---|
| D1 Pool | CONFORMS | app/src/services/ranking/pool.ts:36-51 (checkScalarWrite mapping), :59-61 (bedroomSizesOfFilter), :75-81 (normalizeOrgText both sides), :84-91 (sendable, consent not a rule), :100-126 (window, imported_from never falls back), :339-359 (property pool, includeOlder), :361-389 (tenant pool, hasActivePlacementForOtherTenant), :269-276 + :341 (org list failure fails the pool), :355 / :377 (ceiling); app/src/repos/placementsRepo.ts:373-383 | PR21 (one anchor-exists rule, pool.ts:253-262) |
| D2.1 Classification | CONFORMS | app/src/services/ranking/cardFields.ts:116-224 (tenant registry; lifEligible :146, voucher_program :191, agency :190, notes_updated_at :189), :234-256 (matching inputs mapped by list, keyed by label), :258-317 (property registry; lif :298, priority :295, credit/income :296-297), move_in_date unclassified :223 | PR28 (move_in_date listed for Cameron) |
| D2.2 Shape/order | CONFORMS | app/src/services/ranking/cards.ts:64-112 (trim, registry order, sorted nested keys), :147-161 | - |
| D2.3 Properties seen / attach | CONFORMS | app/src/services/ranking/seenSet.ts:79-110 (unbounded seen set, placeholders), app/src/services/ranking/seenFeedback.ts:26-55 (whole lines, staff lines included), cards.ts:246-287 (outcome entries first, bound, unlisted feedback back to notes), assemble.ts:94-124 (FULL propertyCard per seen home), :314-325 (one listByContact, one listByTenant, one complete units read) | PR20, PR23 |
| D2.4 Classification test | CONFORMS | app/test/rankingCardFields.test.ts:122-360 (type level, writer keys, seed worlds, unclassified listed) | - |
| D2.5 Pair history | CONFORMS | app/src/services/ranking/pairHistory.ts:43-99 (stored decline, tour projection, never the derived outcome) | - |
| D3 Completeness | CONFORMS | app/src/services/ranking/completeness.ts:47-62 (property list), :78-98 (tenant list via `completeness`), :105-124 (merge, folded de-dup); app/src/lib/tenantMatchingInputs.ts (completeness flags) | PR6 |
| D4 Rubric, examples, prompt | CONFORMS | app/src/services/ranking/rubric.ts (r1, every required element), examples.ts (10 synthetic examples, e1), prompt.ts:197-261 (homesSeen once per call, h/c/anchor handles, candidates c1..cn in pool order) | PR18 (fingerprint over system text + schema, prompt.ts:168-179), PR20 |
| D5 Schema and parse | CONFORMS | app/src/services/ranking/schema.ts:89-133 (5 object nodes, all required, no bounds), parse.ts:126-218 (clamp, cuts, enum drops, credit/income dropped, unlawful on checkbox or empty field dropped and counted, duplicates and unknown handles get nothing) | PR44 (accommodation on any enum field) |
| D6 Drivers and config | CONFORMS | app/src/adapters/ranking.ts:79-92 (model, max_tokens, adaptive thinking, effort, json_schema format, timeout, maxRetries 1, no fallback, NO tools), :184-220; app/src/adapters/rankingFake.ts:173 (model stamped fake/console), :216-227 (console logs counts only); app/src/lib/config.ts:586 (supported set), :594-597 (prices), :853-882 (fake/console and poll-off refused in production, key required) | PR30 (real-table defaults, config.ts:792-797) |
| D7 Job: claim, poll, lease, takeover | CONFORMS | app/src/services/ranking/job.ts:211-223 (claim, retry once, join, 409), :470-542 (guard before every call/write, renewal every lease/3, never throws), :565-571 (fresh context with press requestId + traceparent), :589-668 (expiry mark, slots reserved before claim, takeover once then failed); app/src/repos/rankingRunsRepo.ts:275-288, :309, :336, :367, :410 (conditional writes); app/src/worker.ts:527 (own poll, not the SQS queue); app/src/routes/dev.ts:813 (tick, local only); scripts/e2e-session.mjs:271-272 | PR13, PR36, PR38, PR42, PR43 |
| D8 Matches store | CONFORMS | app/src/repos/matchesRepo.ts:139 (schema 2 only), :180-247 (BatchWrite, consistent complete getPairs); runBatch.ts:120-148 (row fields, inputSnapshot, TTL); lean seed row removed (app/src/lib/seed/lean.ts) | PR37 (partial write keeps landed rows) |
| D9 Read | CONFORMS | app/src/services/ranking/readRanking.ts:161-188 (out of date = card / pairHistory fingerprints, age, rubric/examples/model version, failedBatch, unverified; NO prompt fingerprint), :190-216 (band, cap), :261-311 (sorts), :372-405 (poolTooLarge 200 with anchor block), :470-475 (cardChanged) | PR13, PR16, PR17 |
| D10 Unlawful flags | CONFORMS | app/src/services/ranking/flags.ts:41-127 (open = current text hashes; merge once per property+field; reason from against/unknown else default); rankingRunsRepo.ts:890-912 (no TTL, overwrite only when closed); cap.ts:122-136 | PR40; reason source is Cameron's open Q1, not a conformance gap |
| D11 Run log and cost | CONFORMS | app/src/services/ranking/runLog.ts:85-120 (every listed field, results[] with cappedAtRun, inputGzip), rankingRunsRepo.ts:515, :675-679 (350 KB guard), :733-745 (two pointers, same TTL); cost.ts:27-35 | PR14, PR15, PR34, PR36 (see PC-2) |
| D12 Endpoints, roles, event | CONFORMS | app/src/routes/rankings.ts:105-112 (per-user limiter ahead of the handler), :112-189; app/src/routes/adminRankings.ts:183 (requireRole admin); app/src/routes/api.ts (mounts, SSE handler); app/src/lib/events.ts (RankingUpdatedEvent, ids and counts only); dashboard/src/api/EventStreamProvider.tsx | - |
| D13 Fingerprints | CONFORMS | app/src/services/ranking/fingerprints.ts:47-89 (unitCard as sent; pairHistory = decline + tours only; tenantCard = fields minus notes/propertiesSeen + stored Notes text + outcome homes only, sorted by unitId); assemble.ts:96-117 | - |
| D14 Notes box | CONFORMS | app/src/lib/singleLine.ts:20-22; app/src/services/extraction/apply.ts:353 (collapse before the cut), :357-372 (duplicate counted, model and system), :995 (stamp in the same write); app/src/jobs/extraction.ts:721, :775; app/src/lib/import/apply.ts:1196-1203; app/src/routes/contacts.ts:325 (server-owned), :1268-1270 (create), :1987-1989 (PATCH), :2051-2055, :2086-2095 (guard rule, staff_notes_stale wins); dashboard/src/routes/contact/ContactEditForm.tsx:137, :449-454, :704-726; dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:76-84 | PR10 |
| D15 Staff notes comment | CONFORMS | app/src/repos/contactsRepo.ts:170-180; app/src/services/possibleCaseworkers.ts:12-14 | - |
| D16 Spend / testing key | CONFORMS | app/test/rankingDriver.test.ts:21 (SDK mocked); app/test/rankingCounterfactual.test.ts:121-147 (stub driver injected); no counterfactual record committed | PR1 |
| D17 Real-model runs | CONFORMS | app/scripts/extraction-schema-compile-check.ts (ranking-off / ranking-on variants); app/scripts/ranking-counterfactual-check.ts:399-427 (key required except --dry-run; record target checked first), :195-214 (production driver, cards, prompt), rankingCounterfactual/swaps.ts:26-66 (nine swaps), evaluate.ts:21-25, :74-81 (production capOf); gate-run-commands.md present | PR25, PR41 |
| D18 Rankings page | CONFORMS | dashboard/src/routes/settings/settingsTabs.ts:28; dashboard/src/App.tsx:234 (inside AdminRoute); rankings/useAnchorRanking.ts:62 (5 s job poll), :376 (event), RankAnchorPanel.tsx:153 | PR26 |
| D19 Configuration | CONFORMS | app/src/lib/config.ts:789-906 (every variable, fail-fast, PAIR_TTL >= MAX_AGE); all 21 variables in .env.example, .env.dev.example, .env.prod.example and RUNBOOK | PR22, PR30, PR39 (commented lines) |

Spec section 5 surfaces (matches, AI runs families, tenant contact,
hermetic lane, units/placements, B1 list, extraction, events, worker,
config, dashboard, scripts, docs): each found in the diff at the places
above; GLOSSARY carries the listed terms; the three Notes issues are
updated (two resolved, notes-guard-stale-reread-vs-flip-back kept open).

## Human-decision checks

| # | Decision (intent.md) | Holds? | Evidence |
|---|---|---|---|
| 1 | Each home a tenant was sent appears on the tenant card as that home's FULL property card, each distinct home written ONCE per model call, referenced by a handle | YES | assemble.ts:96-107 builds the full `propertyCard` (same classification, landlord defaults when on) for every seen home; prompt.ts:207-233 writes each distinct referenced home once in `homesSeen` (h handles), uses the c handle for a home that is a candidate in the same call and "anchor" for the property anchor (PR20); tenant entries carry `home: <handle>` (prompt.ts:186-195). Note: the card lists at most RANKING_SEEN_MAX (8) homes (cards.ts:268), which is the approved spec Q2 answer ("lists at most 8 homes"), not a gap. |
| 2 | Both LIF fields off the cards; voucher_program off | YES | cardFields.ts:146 (`lifEligible` exclude), :298 (`lif` exclude), :191 (`voucher_program` exclude); cards copy only `include` keys (cards.ts:149-151, :293-296). |
| 3 | A whole Notes line naming a home moves under that home, staff-typed lines included | YES | seenFeedback.ts:26-55 splits the whole box into physical lines with no author filter; cards.ts:270-276 removes a line that names a listed home from `notes` and lists it under each home it names. |
| 4 | Pool ceiling 300 is config (RANKING_MAX_POOL) | YES | config.ts:817; pool.ts:355, :377. |
| 5 | Seen homes enter the tenant fingerprint only with a stored decline or tour; a bare send never marks a match out of date | YES | fingerprints.ts:71-79 (filter on declined or tours); :74-84 (send dates, bound, order not hashed); pairHistory fingerprint is decline + tours only (fingerprints.ts:47-49). |
| 6 | The ranker has no tools | YES | adapters/ranking.ts:79-92: no `tools`, no `tool_choice`, no server tools on the request. |
| 7 | Prices default $2/$10 Sonnet 5.5, $4/$20 Opus 5.5 | YES | config.ts:594-597; env examples carry the same JSON. |
| 8 | No prompt fingerprint feeds the out-of-date test; an extraction prompt/format change cannot by itself mark a match out of date | YES | readRanking.ts:161-188 compares only card and pairHistory fingerprints, computedAt age, rubricVersion, examplesVersion and model (plus failedBatch/unverified, which are job-read facts). `promptFingerprint` is only stored (runBatch.ts:138, runLog.ts:99) and shown (RankingRunDetail.tsx:77). Extraction bookkeeping it writes (`notes_updated_at`, every `*_source`) is excluded from the card (cardFields.ts:175-189, :243); extraction's prompt reads the B1 list's `key` and `promptGuidance`, never the `label` the card keys on (services/extraction/prompt.ts:96). |
| 9 | Contact edit form Notes save: stale-save guard, 409 plus a reload message that keeps the typed text | YES | contacts.ts:2051-2095 (409 `notes_stale` with the current contact); ContactEditForm.tsx:449-454 (sends the opened stamp with notes), :704-726 (keeps typed fields, re-bases, shows the current notes, NOTES_STALE_COPY :137). |
| 10 | AI Notes lines with line breaks collapsed; duplicate drops counted on the run record (notesDuplicate) | YES | apply.ts:353 (toOneLine before the cut), :357-372 (`duplicate`); jobs/extraction.ts:721, :775; aiRunsRepo.ts:88; AiRunDetail.tsx:84. |
| 11 | B2b seams: each run keeps the exact model input; an examples version exists | YES | runLog.ts:111 (`inputGzip` of the user message; system text is reconstructible from the pinned versions); runBatch.ts:145 (per-pair `inputSnapshot`); examples.ts `EXAMPLES_VERSION = 'e1'`, pinned by test/rankingVersionPins.test.ts:41. The 350 KB guard may omit `inputGzip` (spec D11 allows it). |
| 12 | No agent-run real model; anthropic never the default driver in tests | YES, with PC-1 | Driver tests mock `@anthropic-ai/sdk` (rankingDriver.test.ts:21); counterfactual tests inject a stub driver; the script refuses to run without a key except `--dry-run`; e2e lane sets RANKING_DRIVER=fake (e2e-session.mjs:271). See PC-1 for the config default under PR30. |

## Repo rules (AGENTS.md)

- Vocabulary: staff copy says "property" / "tenant" (rankingFormat.ts:55-62,
  job.ts:45-67, readRanking anchor notes); code says `unit`. The model-facing
  rubric says "home", which is not user-facing copy. No drift found.
- ASCII: every added line in the diff is ASCII (the only non-ASCII bytes in
  the unified diff are pre-existing context in hunk headers).
- Message catalog: no new automated tenant/landlord message; the new strings
  are staff page copy (job.ts:15-18 says so).
- Vendor SDK: the only new `@anthropic-ai/sdk` import is
  app/src/adapters/ranking.ts:21; repos import the DynamoDB SDK as the
  existing repos do.
- Dependencies: no package.json changed.
- Job traffic: ranking runs on its own poll (worker.ts:527), not
  `jobs.enqueue`; this is spec D7 / charter 10.2 (the extraction precedent),
  and the job restores the press's requestId and traceparent (job.ts:565-571).

## Findings

### PC-1 (low, CONFIRMED default; harm PLAUSIBLE) The ranking driver config defaults to `anthropic` in a test process without a local DYNAMODB_ENDPOINT

- Location: app/src/lib/config.ts:792-797; app/test/rankingWiring.test.ts:71
  (`loadConfig({ NODE_ENV: 'test' })` is "real tables").
- Contract: Cameron's rule "the anthropic driver is never the default in
  tests" (D16, PR1). PR30 (approved at launch) makes `anthropic` the default
  on real tables outside production.
- Code: any `loadConfig` in a vitest process whose env has no localhost
  DYNAMODB_ENDPOINT resolves `rankingDriver: 'anthropic'`. Today nothing
  turns that into a live call: the dev tick, the only app-side driver
  constructor, is mounted only on a local endpoint (routes/dev.ts:813, where
  the default is `console`); the worker is not started by tests; the driver
  tests mock the SDK.
- Failure scenario: a future test (or helper) that calls
  `createRankingJobDeps(loadConfig(process.env))` in a shell where Cameron
  still has the testing key exported from a gate run (the gate sheet has him
  set `$env:ANTHROPIC_API_KEY` in PowerShell) builds a live anthropic driver
  and the first `rankBatch` spends on the testing key. Suggested guard (not
  applied): refuse `anthropic` under NODE_ENV=test unless a test opts in, or
  have the test env set a local DYNAMODB_ENDPOINT.

### PC-2 (low, CONFIRMED) A model call made by a job that is superseded or loses its lease mid-call is billed but never reaches the cost totals

- Location: app/src/services/ranking/runBatch.ts:230-247.
- Contract: spec D11 "Every model call (one per batch) is a ranking run" and
  the cost page totals runs; spec D7 "before every model call and every
  write ... on a different generation the job exits quietly"; PR36 "never
  loses a paid call ... the usage and cost are logged so spend is never
  invisible".
- Code: after the call returns, a failed generation check writes no run; the
  usage and cost go only to a WARN log line. The build followed D7 and PR36,
  so this is a spec-internal tension, resolved toward D7.
- Failure scenario: a lease renewal throws during a two-minute call
  (DynamoDB throttling) and the job stops; the call's tokens are paid but
  GET /api/admin/rankings/cost and the Rankings page totals omit them; the
  takeover then re-runs and bills the batch again, and only that second
  call is counted. Cameron watches testing-key and production spend from
  that page, so totals read low by the stopped calls. For Cameron to accept
  or ask for a run write that skips the generation check (a run is a log,
  not a score).

No medium-or-higher finding.
