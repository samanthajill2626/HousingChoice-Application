# R1 - spec-conformance code review, WP1 B2a Ranking engine

- Reviewer: spec-conformance reviewer (Claude Opus 5.5), 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine` @ a1077128 (merge base main @404e039d,
  126 commits, 192 files, +28803 / -203).
- Contract: spec rev 6 (APPROVED), plan sections 0-4 and 13 (WI1-WI22,
  PR1-PR45), WORKLIST (WL-S3-3, WL-S4-3 checked as build rulings),
  intent.md.
- Method: every row below was checked against the CODE at HEAD; the slice
  reports were read only as claims. Nothing was executed: no test, no
  script, no npm command (the e2e gate was running in this worktree; the
  app vitest globalSetup sweeps shared DynamoDB Local databases, and no
  check needed execution). No throwaway test was written. No `.env*` file
  other than `*.example` was read; no `ANTHROPIC_*` value was read.
- Two read-only opus sub-agents read the S7 (dashboard + e2e) and S8
  (gate scripts + docs) scopes against the spec; their load-bearing claims
  were spot-verified here against the code (the run detail's current-match
  cell, the GLOSSARY vs the edit form's layout, the counterfactual dry-run
  key path, the e2e capped-row assertions, the useAnchorRanking job
  adoption, the RUNBOOK extraction text).
- Paths below are relative to the worktree root; `file:line` is at HEAD.

## Counts

| Status | Rows |
|---|---|
| CONFORMS | 158 |
| DEVIATES-BY-RULING | 9 |
| PARTIAL | 1 |
| MISSING | 0 |

Findings: MUST-FIX 0, SHOULD-FIX 2, NOTE 14 (section 5).

Verdict: the branch delivers the approved spec and every binding ruling.
No spec decision, ruling or watch item is unmet. One spec sub-point is
partial (the run detail does not LINK a pair to its current match), and
one new GLOSSARY sentence misstates the shipped form.

## 1. Conformance table

### 1a. Decisions D1-D19

| Item | Status | Evidence | Absent / note |
|---|---|---|---|
| D1.1 One pool module, computed at call time by the job and the read | CONFORMS | services/ranking/pool.ts:397-401; assemble.ts:336-338 (both job and read go through assembleRanking) | |
| D1.2 Property anchor: searching tenants via listByType, paged to the end, deleted excluded | CONFORMS | pool.ts:279-298 | |
| D1.3 Sendable = not opted out, not unreachable, has a phone (audienceResolution.ts:197-199's three tests); consent a flag (`hasConsent`), never a rule | CONFORMS | pool.ts:84-91, 348; assemble.ts:371 | |
| D1.4 Voucher size: acceptedVoucherSizes clamped 0-4 and de-duplicated as the prefill, compared with voucherSizeMatches (4 = 4 or more; no size never matches a non-empty list; none takes every size) | CONFORMS | pool.ts:59-72, 349, 367; lib/blastAudienceRules.ts:218-243 | |
| D1.5 Authority: checkScalarWrite(entries,'audience_filter',name,undefined) mapping, {mapped, unmapped} in property order, normalizeOrgText on both sides, none recorded / none mapped = unlimited, some mapped = limited; parity test with the prefill's cases | CONFORMS | pool.ts:36-51, 75-81; test/rankingPoolRules.test.ts:1-80 (prefill entries verbatim) | |
| D1.6 Org list read once per pool; a failed read fails the ranking with a message, never unlimited | CONFORMS | pool.ts:222-226, 269-276, 340-341, 362-363 | |
| D1.7 Recency window RANKING_POOL_WINDOW_DAYS; created_at fallback; imported_from never falls back; includeOlder lifts; property anchor only | CONFORMS | pool.ts:100-126, 351; tenantPool takes no window (361-389); job.ts:213 forces includeOlder false for a tenant anchor | |
| D1.8 Tenant anchor: available units, deleted excluded, no active placement for a DIFFERENT tenant; size and authority from the property's side | CONFORMS | pool.ts:301-319, 361-375; repos/placementsRepo.ts:373-383 | |
| D1.9 Any record can be the anchor; anchorNotes; never refused for the anchor's state | CONFORMS | pool.ts:128-139, 253-262 (PR21's one rule) | |
| D1.10 RANKING_MAX_POOL ceiling: "Pool too large to rank (N candidates)"; the read answers poolTooLarge with no rows | CONFORMS | pool.ts:225, 321-337, 355-357, 377-379; readRanking.ts:374-401 (PR16 shape) | |
| D2.1a Two registries in cardFields.ts, each key `include {label}` or `exclude {reason}` | CONFORMS | cardFields.ts:28-30, 116-317 | |
| D2.1b Runtime allowlist: a card copies only `include` keys of the STORED record | CONFORMS | cards.ts:147-152, 290-296 | |
| D2.1c Tenant card include list (the 17 named attributes, the field-source matching inputs keyed by list label) plus derived lastHeardFrom bucket and propertiesSeen | CONFORMS | cardFields.ts:118-134, 234-256; cards.ts:209-218, 297-298 | |
| D2.1d Tenant card exclude list (ids/refs, phones/emails, lifEligible, relationships, consent, opt-out/unreachable, provenance `*_source`, agency, voucher_program, sign-up bookkeeping, landlord-only keys, both stamps) | CONFORMS | cardFields.ts:136-221 | park_reason sits under the landlord-only reason; it is the landlord park reason (routes/contacts.ts), so the citation is right |
| D2.1e Any unnamed attribute -> EXCLUDE "unclassified at B2a", listed for the handback | CONFORMS | cardFields.ts:35, 223 (move_in_date), 378-383 | the handback list itself is S9.4 work, not yet written |
| D2.1f Property card include list (31) + derived voucherSizes / voucherSizesInferredFromBeds / authorities; requirement items through unitItemValue (legacy boolean pets = No pets); a checkbox recorded only when true | CONFORMS | cardFields.ts:258-290; cards.ts:114-120, 150-157; lib/requirements.ts:174-198 | |
| D2.1g Property card exclude list (priority, credit, income, lif, ids, contacts, media, provenance, tombstones, legacy, derived-replaced) | CONFORMS | cardFields.ts:291-316 | |
| D2.1h Landlord switch (default false): defaults via landlordItemValue minus credit/income, plus landlord notes; property value wins; counts as recorded for the cap; plain key; `landlord:<key>` = `<key>` | CONFORMS | cards.ts:58-60, 129-144, 158-178; cap.ts:37-40, 85-94 | |
| D2.2 Fixed key order, free text trimmed only, no record id on a card; tenantCard / propertyCard pure with ctx | CONFORMS | cards.ts:63-112, 147, 290; lib/requirements.ts:163-171 (canonical = trim); prompt.ts:185-195 replaces seen-home ids with handles | |
| D2.3a Seen set: listByContact (isListed rows) + listByTenant; sent vs signed up (flyer share); unbounded | CONFORMS | assemble.ts:314-325; seenSet.ts:53-103; pairHistory.ts:38-49; repos/listingSendsRepo.ts:483, 497 | |
| D2.3b Bound RANKING_SEEN_MAX: outcome entries first (newest activity), bare sends fill (newest send); an outcome entry past the bound is not listed and its lines return to notes | CONFORMS | cards.ts:246-287 | |
| D2.3c One listByContact, one listByTenant, one getManyByIds(requireComplete) per tenant card | CONFORMS | assemble.ts:319-322; repos/unitsRepo.ts:1353-1379 | |
| D2.3d Incomplete read scoped to its card: the job leaves the candidate out with the count message; the read shows it `unverified`; the anchor's own card -> 503 | CONFORMS | assemble.ts:373-386, 429-433; job.ts:49-52, 388-401, 436; readRanking.ts:149-151, 356-361, 372-405 | the anchor case in the job follows PR38 / PR43 |
| D2.3e Listed entry: label + that home's FULL card (written once per call, by handle); sends with kinds + daysSinceLastSend; declined {by, at}; tour projection; feedback | CONFORMS | cards.ts:190-201, 277-285; assemble.ts:96-122; prompt.ts:197-233; pairHistory.ts:51-66 | |
| D2.3f Attach step alone in seenFeedback.ts: physical lines, labelMatches over the whole seen set, under each home it names, whole lines incl. staff lines, no polish | CONFORMS | seenFeedback.ts:26-55 | |
| D2.3g Soft-deleted seen unit listed; a complete-read miss -> "a property no longer on file" with its sends, decline and tours; its lines stay in notes | CONFORMS | seenSet.ts:21-22, 81-101; unitsRepo.ts:1355-1376 | |
| D2.4 Classification test: type level, writer keys, seed worlds; a second test for the runtime allowlist | CONFORMS | cardFields.ts:109-114, 224, 317 (`satisfies Record<...>`); test/rankingCardFields.test.ts:122-360; test/rankingTenantCard.test.ts:64, 102; test/rankingPropertyCard.test.ts:72, 124 | |
| D2.5 Pair history from stored facts (sends + kind, declined, tours, daysSinceLastSend), never the derived outcome | CONFORMS | pairHistory.ts:38-84 | |
| D3a Property gaps: rent, payment_standard, voucher_sizes (inferred counts as missing), authorities_unmapped, pets, accessibility | CONFORMS | completeness.ts:47-64 | |
| D3b Tenant gaps: voucher_size, housing_authority, every list entry with `completeness` (true for area_preference, max_tenant_portion); dashboard mirror + drift test | CONFORMS | completeness.ts:76-95; lib/tenantMatchingInputs.ts:48, 59, 70, 81; dashboard/src/routes/contact/tenantMatchingInputs.ts and its mirror test (MIRRORED gains `completeness`) | |
| D3c Missing to the model as labels; match missing[] = code flags (with keys) then unknowns not equal to a label (folded); missing never stops a ranking | CONFORMS | prompt.ts:238, 242; completeness.ts:97-120; runLog.ts:50-52 | |
| D4a rubric.ts: RUBRIC_VERSION 'r1', RUBRIC_TEXT with every D4 element in order | CONFORMS | rubric.ts:13-84; test/rankingRubric.test.ts | |
| D4b examples.ts: EXAMPLES_VERSION 'e1', ten synthetic examples across the bands incl. capped, accommodation, unlawful, maybe, missing | CONFORMS | examples.ts:15, 54-750; test/rankingExamples.test.ts:80-286 | |
| D4c The call: system = rubric then examples; user = anchor card + missing, homesSeen written once (h1..hn), candidates c1..cn in pool order; a candidate home referenced by its c handle | CONFORMS | prompt.ts:130-153, 197-261 (PR20's "anchor" reference added) | |
| D4d promptFingerprint recorded on every run | DEVIATES-BY-RULING (PR18) | prompt.ts:166-179 (system text + newline + stable schema JSON); runLog.ts:99; runBatch.ts:138 | |
| D5a output_config json_schema; every key required; additionalProperties false; empty-array sentinels | CONFORMS | schema.ts:72-133; adapters/ranking.ts:84-87 | |
| D5b Source enum (16 values) | CONFORMS | schema.ts:25-42 | |
| D5c Requirement enum = REQUIREMENT_UNIT_KEYS less credit/income; code drops them if they arrive | CONFORMS | cardFields.ts:320-325; parse.ts:113-122 | |
| D5d Flag-field enum (+ landlord twins when on); an unlawful flag off a free-text field, or on an empty one, dropped and counted | CONFORMS | schema.ts:46-70; parse.ts:124-158 (PR44 for accommodation) | |
| D5e At most five object nodes; offline shape test | CONFORMS | test/rankingSchema.test.ts:64-104 | |
| D5f Compile check gains `ranking` off/on; RUNBOOK "Changing a structured-output schema" names the ranking schema | CONFORMS | app/scripts/extraction-schema-compile-check.ts:66-71, 110; RUNBOOK.md:1563-1582 | |
| D5g parseRankingText never throws: clamp + round, 3 reasons cut to 80, 5 unknowns, enum drops; omitted / duplicate / unknown handle -> no match; a failed call -> none | CONFORMS | parse.ts:84-220 | |
| D6a adapters/ranking.ts (the only new SDK import) + adapters/rankingFake.ts; RankingDriver; RankingCall discriminated, never throws | CONFORMS | services/ranking/driverTypes.ts:13-43; adapters/ranking.ts:21; `git grep @anthropic-ai/sdk` finds no other import | |
| D6b Request: model, max_tokens, adaptive thinking, effort + json_schema; timeout + maxRetries 1; no refusal fallback | CONFORMS | adapters/ranking.ts:79-92 | |
| D6c Supported models only; any other AI_RANKING_MODEL stops startup | CONFORMS | lib/config.ts:801-806; adapters/ranking.ts:195-200 | |
| D6d RANKING_DRIVER default: production anthropic, else console | DEVIATES-BY-RULING (PR30) | config.ts:792-797 (anthropic outside production on real tables) | |
| D6e fake and console refused under NODE_ENV=production; ANTHROPIC_API_KEY required in production whatever AI_EXTRACTION_ENABLED says; ANTHROPIC_API_BASE_URL still refused | CONFORMS | config.ts:854-882, 1267-1272 | |
| D6f Every match and run records the model actually used (`fake` / `console` literal) | CONFORMS | adapters/ranking.ts:76; rankingFake.ts:173; runBatch.ts:274; runLog.ts:96; readRanking.ts:136-138 | |
| D6g Fake rules (70; -25 rent / No pets / no_evictions; +10 area) and the three seams | CONFORMS | rankingFake.ts:105-164 | |
| D6h Console driver: counts and sizes only, fake rules and seams, model `console` | CONFORMS | rankingFake.ts:204-229 | |
| D6i AI_PRICE_TABLE default ($2/$10, $4/$20), fail-fast override, an unpriced ranking model stops startup; cost formula rounded to 1e-6, stored on the run | CONFORMS | config.ts:592-597, 718-781, 838-843; cost.ts:25-35; runLog.ts:107 | |
| D6j Prompt caching off; cache-read tokens recorded when present | CONFORMS | adapters/ranking.ts:109-114; runLog.ts:100-104 | |
| D7a Job record `rjob#<kind>#<id>` with the D7 fields; expires_at = requestedAt + RANKING_PAIR_TTL_DAYS | CONFORMS | rankingRunsRepo.ts:59-60, 93-123, 251-272; job.ts:187-201 (+ notScored, PR13) | |
| D7b Claim: one conditional put (none / done / failed / queued past expiry); the loser reads consistent; finished -> retry once; same window -> 202 joined; else 409 ranking_running with the spec copy | CONFORMS | rankingRunsRepo.ts:273-288; job.ts:40, 211-223; routes/rankings.ts:129-142 | |
| D7c queuedExpiresAt = requestedAt + RANKING_QUEUE_EXPIRY_MS; the tick first fails expired queued records (conditional on status, generation, expiry; index keys removed); the read derives `expired` with the message | CONFORMS | job.ts:41, 197, 251-268, 583-598; rankingRunsRepo.ts:406-429 | |
| D7d Sparse index keys (queued by requestedAt, running by leaseExpiresAt, none when finished) | CONFORMS | rankingRunsRepo.ts:61-63, 269-270, 308, 366, 409, 472 | |
| D7e Own `startPoll('ranking', ...)` in worker.ts, no switch; queued oldest first + expired leases; RANKING_MAX_CONCURRENT_JOBS in-process counter over overlapping ticks | CONFORMS | worker.ts:527-539; job.ts:79-99, 583-616; rankingRunsRepo.ts:221-237, 297-303 | the PR30 non-production default is under D19c |
| D7f Claim queued (conditional, running, startedAt, lease); takeover once (new generation, attempts + 1, from the start); second expiry -> failed with the spec copy; renewal every lease/3 on the generation; a failed renewal stops the job | CONFORMS | rankingRunsRepo.ts:305-404; job.ts:42, 497-514, 617-643 | |
| D7g Each job in a FRESH runWithContext with the press's requestId and traceparent | CONFORMS | job.ts:552-558; lib/context.ts:57-59 (`als.run({...ctx})` replaces the store); routes/rankings.ts:123-128 | |
| D7h Consistent generation read before every model call and write | CONFORMS | runBatch.ts:160, 230, 283, 301, 312; job.ts:366, 394, 463-495 | the finish write is generation-CONDITIONED instead of read-guarded (rankingRunsRepo.ts:467-490; plan R2B5) - stronger than a read; NOTE N8 |
| D7i The run: pool + cards; batches of RANKING_BATCH_SIZE in pool order; up to RANKING_BATCH_CONCURRENCY in parallel; each batch writes run, matches, flags, then progress + event; done with or without failed batches; a zero pool is done | CONFORMS | job.ts:388-444; runBatch.ts:150-339 | |
| D7j Never throws; failures recorded on the record | CONFORMS | job.ts:320-345, 358-386, 516-528 | |
| D7k Hermetic lane: RANKING_WORKER_POLL=off (refused in production), fake driver, POST /__dev/ranking/tick runs one pass to completion | CONFORMS | config.ts:870-875; scripts/e2e-session.mjs:271-272; routes/dev.ts:813-827 | |
| D7l One job per anchor; rankAnchor is the one entry point | CONFORMS | job.ts:457 (signature `rankAnchor(job, deps)` per PR3's module map) | |
| D8a Row fields (schema 2, score, reasons, missing, failedRequirements, flags, stage 1, versions, model, runId, jobGeneration, computedAt, anchorSide, fingerprints, inputSnapshot, expires_at); nothing derived stored | CONFORMS | repos/matchesRepo.ts:47-79; runBatch.ts:120-148 | |
| D8b putMatches BatchWrite with retries; a write that fails is the batch's failure | DEVIATES-BY-RULING (PR37) | matchesRepo.ts:180-217; runBatch.ts:280-336 (landed rows stay; only unwritten candidates listed) | |
| D8c getPairs(requireComplete) by key, consistent, base table; listByUnit / listByTenant exist | CONFORMS | matchesRepo.ts:219-277 | listByUnit / listByTenant have no caller (NOTE N11) |
| D8d A non-schema-2 row is ignored; the lean legacy row removed with no replacement | CONFORMS | matchesRepo.ts:139-141, 236, 261, 276; lib/seed/lean.ts (row and MATCH_EXPIRES_AT removed); test/seedNoLegacyMatch.test.ts:12-16 | |
| D8.1 inputSnapshot (anchor + candidate as sent with missing, pair history, every referenced seen home resolved) gzip + base64, plus promptFingerprint and both versions on the row; the run stores the batch user message gzipped | CONFORMS | prompt.ts:275-299; runBatch.ts:136-145; matchesRepo.ts:154-172; runLog.ts:114 | |
| D9a GET returns anchor (display, anchorNotes, missing, cardChanged), job (expired derived), rows (hasConsent / priority; match null notRankedYet / notScored, or the match with band, capped, capReason, outOfDate), flags | CONFORMS | readRanking.ts:58-120, 465-498; routes/rankings.ts:155-185 (+ poolWindowDays PR26, poolTooLarge PR16) | |
| D9b Bands 80 / 60 / 40 as constants in bands.ts | CONFORMS | bands.ts:8-22 | |
| D9c Cap: a failed cap-eligible key, recorded on the current card, not covered by the pair's accommodation, no open unlawful flag on it; Weak with capReason | DEVIATES-BY-RULING (PR29 as amended by PR40, PR45) | cap.ts:25-97; readRanking.ts:190-205 | |
| D9d Out of date: card, pairHistory, age, version (rubric, examples, model), failedBatch only when computedAt < the last job's startedAt, unverified | CONFORMS | readRanking.ts:161-188 | |
| D9e notScored vs match decided by the same test | CONFORMS | readRanking.ts:141-147, 218-232 (PR13 lists) | |
| D9f Sort: property anchor band, score, last heard from (else created_at); tenant anchor band after the priority strength, priority, score, label; capped last within Weak, no lift; unmatched last | CONFORMS | readRanking.ts:240-311 | |
| D9g The read computes the current pool and cards at RANKING_READ_CONCURRENCY; the 150-tenant budget measured | DEVIATES-BY-RULING (PR24) | assemble.ts:345, 364, 435; test/rankingRead.integration.test.ts:187-201; S6 report: 224 / 175 / 164 ms isolated, vs 5000 ms | measured on DynamoDB Local through the production read path, as PR24 rules |
| D9h The full read is not polled; the job read is; one re-read per finished batch and at the end | CONFORMS | dashboard/src/routes/settings/rankings/useAnchorRanking.ts:28, 166-201 | |
| D10a Flag record `uflag#<unitId>#<field>` with textHash, reason, runId, raisedAt, index keys, no TTL; dismissal fields reserved | CONFORMS | rankingRunsRepo.ts:851-917 | |
| D10b Raised once per property and field across a job's batches; written only when none is open; an open one keeps its first raising run | CONFORMS | flags.ts:92-118; runBatch.ts:197-205, 311-320; rankingRunsRepo.ts:890-917 | |
| D10c Open = on the current card with the same text hash; closed otherwise (incl. landlord-twin cases); a closed record is overwritten when raised again | CONFORMS | flags.ts:24-59; rankingRunsRepo.ts:907 | |
| D10d While open, the field caps no pair of that property, incl. pairs the model missed | CONFORMS | readRanking.ts:422-455, 195-200 | |
| D10e Accommodation flags stay on the match only | CONFORMS | flags.ts:100; runBatch.ts:134 | |
| D11a One run per model call: `rrun#<runId>`, kind ranking, every D11 field | CONFORMS | rankingRunsRepo.ts:566-604, 732-765; runLog.ts:84-121 | |
| D11b The 350 KB guard (inputGzip dropped, inputOmitted) | CONFORMS | rankingRunsRepo.ts:514-515, 670-679 | |
| D11c results[] = this run's own output with cappedAtRun (and merged missing, PR14); matchesWritten by a second conditional update (PR15) | CONFORMS | runLog.ts:54-82; runBatch.ts:299-308; rankingRunsRepo.ts:767-776 | |
| D11d Run detail renders results[], LINKS each pair to its current match, marks "since re-scored" | PARTIAL | server: routes/adminRankings.ts:254-263, 286-309 (currentRunId, sinceRescored); page: dashboard/src/routes/settings/rankings/RankingRunDetail.tsx:119 and rankingFormat.ts:140-144 render plain text | no link from a pair to its current match (or that match's run) - SF1 |
| D11e Pointers `ptr#rankings#global` / `ptr#rankings#<kind>#<id>` with the run's TTL; rankingRunsRepo is their reader; the extraction log never sees a ranking row (pinned) | CONFORMS | rankingRunsRepo.ts:501-512, 732-765, 783-846; routes/aiRuns.ts:30-31; repos/aiRunsRepo.ts:170; test/rankingRunsExtractionLogExclusion.integration.test.ts:127-158 | |
| D11f The tables.ts ai_runs comment names the new families | CONFORMS | lib/tables.ts:624-661 | |
| D12a POST rank -> 202 {job, joined} / 404 / 409; admin + va; per-user limit RATE_LIMIT_RANK_PER_MIN via createUserRateLimit, in-router before the handler | CONFORMS | routes/rankings.ts:105-143; routes/api.ts:912-921 | |
| D12b GET read, admin + va | CONFORMS | rankings.ts:155-185 | |
| D12c GET job: one consistent key read, expired derived | CONFORMS | rankings.ts:98-101, 145-153 | |
| D12d Admin only: runs (from, to, anchor, cursor), run detail, cost by ISO week and environment | CONFORMS | adminRankings.ts:183-386 (cost defaults per PR34) | |
| D12e Event `ranking.updated` {anchorKind, anchorId, generation, status, batchesDone, batchCount}; AppEventMap, ALL_APP_EVENTS, SSE, EventStreamProvider; a hint, the page polls 5 s | CONFORMS | lib/events.ts:356-376, 399; routes/api.ts:2828-2841, 2876; runBatch.ts:76-93; dashboard EventStreamProvider.tsx:67, 244-248 | |
| D13a unitCard = the property card as sent | CONFORMS | fingerprints.ts:43-46; assemble.ts:86 | |
| D13b tenantCard = card fields minus notes / propertiesSeen + the stored Notes text + outcome homes {unitId, label, unitCard, declined, tours} sorted by unitId | CONFORMS | fingerprints.ts:64-88; assemble.ts:109-117 | |
| D13c pairHistory = declined + tours, never sends | CONFORMS | fingerprints.ts:48-51 | |
| D14.1 CR / LF / U+2028 / U+2029 runs -> " / " by ONE exported helper shared with the transcript, before the clamp and the retry guard | CONFORMS | lib/singleLine.ts:20-22; services/extraction/apply.ts:353, 367; services/extraction/prompt.ts:244-245 | |
| D14.2 `duplicate` counted (model and system); notesDuplicate on the run, its dashboard twin and the detail's "N already in the notes" (counted) | CONFORMS | apply.ts:347-378, 1009; jobs/extraction.ts:365-367, 721, 775; repos/aiRunsRepo.ts:84-88; dashboard/src/api/types.ts:395; AiRunDetail.tsx:77, 84 | |
| D14.3a notes_updated_at stamped in the same write by every Notes writer (PATCH, create, extraction apply, importer) | CONFORMS | routes/contacts.ts:1266-1270, 1984-1989; apply.ts:992; lib/import/apply.ts:1196-1203 | |
| D14.3b notes_expected_updated_at (string or null), only with notes; 409 notes_stale (only guard, or the stamp moved) vs contact_changed; staff_notes_stale wins | CONFORMS | contacts.ts:683-695, 2048-2058, 2080-2097 | |
| D14.3c Server-owned (a client write refused) | CONFORMS | contacts.ts:319-326 | |
| D14.3d Edit form: sends the opened stamp only with notes; on notes_stale keeps every field, re-bases, shows the spec copy + current text; "Nothing was saved." | CONFORMS | dashboard/src/routes/contact/ContactEditForm.tsx:137-138, 256-259, 442-445, 698-710, 1264-1287 (copy byte-identical to spec D14.3 after the "Nothing was saved. " prefix) | |
| D14.3e Importer and extraction stay unguarded | CONFORMS | lib/import/apply.ts:1196-1203; apply.ts:988-992 | |
| D15 staff_notes comments corrected (nothing machine-WRITES it; the ranking card READS it) | CONFORMS | repos/contactsRepo.ts:170-180; services/possibleCaseworkers.ts:12-14 | |
| D16 No agent runs a real model; tests and the hermetic stack use the fake driver | CONFORMS | test/rankingDriver.test.ts:21 (SDK mocked); test/rankingWiring.test.ts:53 (console); scripts/e2e-session.mjs:271 | process history is not auditable; no counterfactual record exists in the worktree |
| D17.1 Compile-check command with both ranking variants | CONFORMS | extraction-schema-compile-check.ts:66-71; gate-run-commands.md | Cameron's run pending |
| D17.2 Counterfactual check: synthetic records, the production path (cards, prompt, driver, parse, capOf), 9 swaps on 6 base pairs, both directions, twin never beside twin, per-run caps, controls, two-stage tolerance, noise / INCONCLUSIVE, verbatim record, exit 0 only on a pass, plan + cost printed first | CONFORMS | app/scripts/ranking-counterfactual-check.ts:316-346, 400-420; rankingCounterfactual/evaluate.ts:21-89; plan.ts:26-234; report.ts:110-186; records.ts:1-329 (PR25, PR41 applied; `--out` per plan C12) | |
| D17.3 `--timing`: one synthetic 40-candidate batch three times | CONFORMS | ranking-counterfactual-check.ts:349-397 | |
| D17.4 Offline stub-driver tests (over tolerance, majority cap, noisy base, both directions, missing control, ungraded run, exit codes) | CONFORMS | test/rankingCounterfactual*.test.ts | |
| D17.5 gate-run-commands.md sheet | CONFORMS | docs/superpowers/reviews/.../gate-run-commands.md:10-137 | `<commit>` / `<fingerprint>` are S9.1's to fill (NOTE N10) |
| D18a Tab {rankings, Rankings, /settings/rankings, adminOnly} inside AdminRoute | CONFORMS | dashboard/src/routes/settings/settingsTabs.ts:28; App.tsx:233-240 | |
| D18b Runs list: newest first; anchor, direction, model, candidates, cost, latency, time, outcome; date and anchor filters; weekly cost totals with the environment; cursor paging | CONFORMS | RankingRunList.tsx:57-122; RankingCostTotals.tsx:44-71; useRankingRuns.ts:80-105 | |
| D18c Run detail: fields, raw output and decompressed input collapsed, pairs with candidate, score, band, cap, sourced reasons, missing, flags | CONFORMS | RankingRunDetail.tsx:60-156 | the current-match LINK is D11d |
| D18d Rank this anchor: existing contact and unit search, include-older checkbox, Rank, per-batch status (event + 5 s job poll), the plain ranking table | DEVIATES-BY-RULING (PR26) | RankAnchorPanel.tsx:126-202; useAnchorRanking.ts:115, 134, 166-201; RankingTable.tsx:17-57 | copy names the configured window N, not "90" |
| D18e Full width; plain short copy | CONFORMS | RankingsSection.module.css:6 | raw field keys in some cells (NOTE N4) |
| D19a The 21 variables, their defaults, fail-fast parsing | CONFORMS | config.ts:551-907; test/configRanking.test.ts:82-423 (PR22's extra refusal at 821-826) | |
| D19b Each variable uncommented with its default in the env examples and RUNBOOK | DEVIATES-BY-RULING (PR39) | .env.example:209-241; .env.dev.example:246-271; .env.prod.example:272-292; test/rankingEnvExamples.test.ts:15-118 | |
| D19c RANKING_DRIVER / RANKING_WORKER_POLL defaults | DEVIATES-BY-RULING (PR30) | config.ts:792-797, 845-847, 863-869; worker.ts:527-539 | |
| D19d No RANKING_REFINE_TOP / AI_RANKING_REFINE_MODEL; `stage: 1` on the row | CONFORMS | `git grep REFINE` finds none in app/src; matchesRepo.ts:58 | |

### 1b. Spec section 5 surfaces

| Surface | Status | Evidence | Note |
|---|---|---|---|
| `matches`: only the ranking job writes; legacy lean row removed; readers = the read, the run detail; legacy rows ignored | CONFORMS | runBatch.ts:285 is the only putMatches caller; `tableName('matches'` only at matchesRepo.ts:176; readRanking.ts:413-416; adminRankings.ts:259 | |
| AI runs table: rjob#, rrun#, ptr#rankings#..., uflag#; extraction readers never return them; writers = claim + poll; new reader; table comment | CONFORMS | rankingRunsRepo.ts:1-16; aiRuns.ts:30-31; aiRunsRepo.ts:170; jobs/journalSweep.ts and lib/performanceSeed.ts do not touch ai_runs by prefix; lib/devReset.ts:49 clears every table whole; tables.ts:624-661 | |
| Tenant contact: read by pool and card; notes_updated_at written by every Notes writer, read by the guard and the form, server-owned; staff_notes comment | CONFORMS | see D14.3a-c, D15; grep of app/src finds no other contact `notes` writer (import/apply.ts:1562-1564 writes a UNIT's notes) | |
| Hermetic lane: fake driver + poll off for both children; POST /__dev/ranking/tick | CONFORMS | e2e-session.mjs:198, 271-272 (childEnv reaches app and worker); dev.ts:813-827 | |
| Units, listing_sends, tours, placements, org list read only; hasActivePlacementForOtherTenant; getManyByIds; checkScalarWrite per name | CONFORMS | placementsRepo.ts:373-383; unitsRepo.ts:1353-1379 (getDisplaysByIds untouched); pool.ts:43 | |
| B1 list gains `completeness`; dashboard mirror and drift test | CONFORMS | tenantMatchingInputs.ts:35-37, 48-81; dashboard mirror + test | |
| Extraction: filterNoteLines, notesDuplicate (record, twin, detail), apply stamping; prompt text unchanged | CONFORMS | apply.ts:334-379, 992; extraction/prompt.ts:223-245 (renderer only) | |
| Events: ranking.updated in the map, ALL_APP_EVENTS, SSE, provider | CONFORMS | see D12e | |
| Worker: the ranking poll started (no switch in production) | CONFORMS | worker.ts:527-539 | PR30 default off on real tables outside production |
| Config and startup: the D19 variables; the key required in production | CONFORMS | config.ts:789-907 | |
| Dashboard: Rankings tab, routes, components; the edit form's Notes guard; the run detail's new count | CONFORMS | see D14.2, D14.3d, D18 | |
| Scripts: compile check (two ranking variants); ranking-counterfactual-check.ts | CONFORMS | see D5f, D17 | |
| Docs: RUNBOOK ranking operations (+ schema section, WORKER_POLL_INTERVAL_MS comment), GLOSSARY terms, env examples, the three issues | CONFORMS | RUNBOOK.md:1349-1369, 1488, 1563-1582, 1731-1924; config.ts:408-418; GLOSSARY.md:870-937; docs/issues/* | wording findings SF2, N12 |

### 1c. Spec section 6 test bullets

| Bullet | Status | Evidence |
|---|---|---|
| Pool (fences, consent, sizes, authority parity, org-list failure, window, tenant anchor incl. own placement, anchor notes, ceiling) | CONFORMS | test/rankingPool.test.ts:38-261; rankingPoolRules.test.ts:35-203; placementsRepoActiveForOther*.test.ts |
| Cards (classification, allowlist, exclusions, legacy pets, landlord switch, properties seen incl. incomplete reads, tour projection, attach step, stable serialization, seed attributes) | CONFORMS | rankingCardFields.test.ts; rankingTenantCard.test.ts:102-210; rankingPropertyCard.test.ts:124-227; rankingSeenSet.test.ts:22-175; rankingSeenFeedback.test.ts:21-58; rankingAssemble.test.ts:137-210, 273-292 |
| Completeness (every key, inferred sizes, unmapped authorities, merge and de-dup) | CONFORMS | rankingCompleteness.test.ts:27-140 |
| Schema and parse (shape, clamp, cuts, enum drops, credit/income dropped, unlawful on checkbox / empty counted, duplicate / unknown handles, failure kinds) | CONFORMS | rankingSchema.test.ts:64-196; rankingParse.test.ts:39-248; rankingDriver.test.ts:167-207 |
| Driver (request shape, unsupported model, failure mapping, usage and cost, config fail-fast, production refusals, model stamps, console logs, fake rules and seams) | CONFORMS | rankingDriver.test.ts:96-246; configRanking.test.ts:82-423; rankingFake.test.ts:40-183; rankingCost.test.ts |
| Job (claim cases, join, retry, 409 rules, poll race, in-process limit, renewal, takeover, generation stop, request id in logs, parallel batches, zero pool, never throws, expired) | CONFORMS | rankingClaim.test.ts:50-185; rankingPoll.test.ts:78-229; rankingRankAnchor.test.ts:107-397; rankingJob.integration.test.ts:103-142 |
| Matches (put and read by key, requireComplete throws, legacy ignored, TTL, snapshot round-trip) | CONFORMS | matchesRepo.test.ts:112-277; matchesRepo.integration.test.ts:85-130 |
| Read (bands, cap conditions, out-of-date reasons and the WI11 invariants, sort with each strength, not ranked / not scored, ceiling, budget) | CONFORMS | rankingReadDerive.test.ts:51-296; rankingRead.test.ts:68-348; rankingBandsCap.test.ts:16-161; rankingFingerprintInvariants.test.ts:78-171; rankingRead.integration.test.ts:187-336 |
| Flags (once per property and field, closed on edit, re-raised after close) | CONFORMS | rankingFlags.test.ts:26-123; rankingRunBatch.test.ts:283-333 |
| Run log (never in the extraction log, cost, pointers + TTL, 350 KB, own results and the re-scored mark) | CONFORMS | rankingRunsExtractionLogExclusion.integration.test.ts; rankingRunLog.test.ts:77-166; rankingRunsRepoRuns.integration.test.ts:98-294; adminRankingsApi.test.ts:174-206 |
| Endpoints (va can rank and read, only admin on the Rankings API, 429, 404s) | CONFORMS | rankingsApi.test.ts:72-211; adminRankingsApi.test.ts:93-167 |
| Notes (collapse incl. U+2028/9 and guard after collapse, notesDuplicate counted and shown, the PATCH guard cases, client write refused, every writer stamps, the form) | CONFORMS | singleLine.test.ts; extractionNoteLines.test.ts:22-239; extractionJob.test.ts:2020-2035; contactNotesGuard.test.ts:42-269; contactsCrud.test.ts:559; extractionApply.test.ts:1921-1939; importApply.integration.test.ts:517-532; ContactEditForm.test.tsx (11 new cases) |
| Counterfactual check offline | CONFORMS | rankingCounterfactual.test.ts, ...Evaluate, ...Plan, ...Data |
| e2e (fixtures through the API; not ranked yet before the tick, ranked after, capped last; failed batch; card edit out of date; tenant anchor; VA cannot open; run in the list with cost and own results; Notes conflict with two pages) | CONFORMS | e2e/tests/dashboard-next/rankings.spec.ts:108-281 (capped row asserted per cell, 140-146); contact-notes-conflict.spec.ts:76-110; e2e/fixtures/ranking.ts:25-103 |

### 1d. Watch items

| WI | Status | Evidence |
|---|---|---|
| WI1 matches writers / readers / legacy rows | CONFORMS | runBatch.ts:285 sole writer; matchesRepo.ts:176 the only table-name use; readers readRanking.ts:413, adminRankings.ts:259; isCurrentMatchRow at every read (matchesRepo.ts:139-141, 236, 261, 276) |
| WI2 the four families never returned by the extraction readers; sweeps checked | CONFORMS | aiRuns.ts:30-31; aiRunsRepo.ts:170; exclusion integration test:127-158; journalSweep / performanceSeed do not scan ai_runs; devReset clears whole tables |
| WI3 every Notes writer stamps; every other writer listed | CONFORMS | contacts.ts:1266-1270, 1984-1989; apply.ts:992; import/apply.ts:1196-1203; no other contact `notes` writer in app/src |
| WI4 notes_updated_at server-owned and off the card | CONFORMS | contacts.ts:325; cardFields.ts:189 |
| WI5 extraction prompt text byte-unchanged | CONFORMS | extraction/prompt.ts diff is the renderer only; extractionAdapter / extractionPromptProbe tests unchanged; extractionSchema.test.ts only adds folding cases |
| WI6 production refusals, fail-fast, key, base URL; fixtures gain the key | CONFORMS | config.ts:854-882, 1267-1272; nine production-boot fixtures in the diff |
| WI7 no network, no key read by any test or build-run script | CONFORMS | rankingDriver.test.ts:21; rankingWiring.test.ts:53; compile check runs main only when invoked directly (extraction-schema-compile-check.ts:110); counterfactual dry run never reads the key (ranking-counterfactual-check.ts:407-408, 326-329) |
| WI8 reader scan widened; examples.ts sole exemption; fake via the list | CONFORMS | test/tenantMatchingInputsReaders.test.ts (RANKING_DIR, RANKING_EXEMPT, RANKING_DRIVERS); rankingFake.ts:59-68 |
| WI9 getDisplaysByIds and callers unchanged | CONFORMS | unitsRepo.ts diff adds only getManyByIds |
| WI10 lean seed stable apart from the match row; no seed notes or stamp | CONFORMS | lean.ts diff; seedNotesStamp.test.ts:22; seedNoLegacyMatch.test.ts |
| WI11 fingerprint invariants as named tests | CONFORMS | rankingFingerprintInvariants.test.ts:78-171; rankingRead.integration.test.ts:316-336 |
| WI12 one card definition | CONFORMS | call sites: assemble.ts:85, 101, 108; scripts/rankingCounterfactual/cards.ts:65, 72 - no other |
| WI13 one cap function | CONFORMS | capOf call sites: readRanking.ts:195, runLog.ts:74, rankingCounterfactual/evaluate.ts:75 - no other |
| WI14 the press's requestId on every job line | CONFORMS | job.ts:552-558; rankingPoll.test.ts:210 |
| WI15 overlapping ticks and two pollers | CONFORMS | job.ts:79-99, 600-615; rankingPoll.test.ts:172, 199; rankingJob.integration.test.ts:113 |
| WI16 exact six-key event payload | CONFORMS | events.ts:356-363; runBatch.ts:76-85; rankingRankAnchor.test.ts:387; rankingRunBatch.test.ts:359 |
| WI17 roles | CONFORMS | api.ts:912-929; adminRankings.ts:183; rankingsApi.test.ts:72, 169, 204; adminRankingsApi.test.ts:93; settingsTabs.ts:28; rankings.spec.ts:255-281 |
| WI18 150-tenant read under 5 s | DEVIATES-BY-RULING (PR24) | rankingRead.integration.test.ts:187-201; S6 report: 224 / 175 / 164 ms isolated |
| WI19 e2e fixtures via the API, unique names, tick only; no spec reads the legacy row | CONFORMS | e2e/fixtures/ranking.ts:25-103; rankings.spec.ts (VA test ranks the seeded tenant, plan C6 - NOTE N9) |
| WI20 the anchor's own placement never excludes | CONFORMS | pool.ts:370-375; placementsRepo.ts:381; rankingPool.test.ts:202 |
| WI21 schema bounds | CONFORMS | rankingSchema.test.ts:64-104 |
| WI22 free-text fields are strings on UnitItem | CONFORMS | unitsRepo.ts:449-535 (ten `string`, legacy `pets?: string \| boolean` read through unitItemValue); rankingSchema.test.ts:180-183; S4 report quotes each line |

## 2. Rulings PR13-PR45

- PR13 applied: `notScored {candidateId, reason}` typed and reset on takeover (rankingRunsRepo.ts:88-91, 335); omissions never in failedBatches (runBatch.ts:323-326); the read uses both lists (readRanking.ts:141-147); the page's count follows PR42.
- PR14 applied: merged `missing` beside `unknowns` in results[] (runLog.ts:70-73); wire names missing, cappedAtRun, currentRunId, top-level anchorDisplay (adminRankings.ts:286-329); band by bandOf (297).
- PR15 applied: `matchesWritten {count, at}` (rankingRunsRepo.ts:596, 767-776; runBatch.ts:303); the page reads `count` (RankingRunDetail.tsx:57, 76-80).
- PR16 applied: 200 with the anchor block, `rows: []`, `poolTooLarge {size}` (readRanking.ts:374-401; rankings.ts:175); the page checks it first (RankAnchorPanel.tsx:27-29, 53-57).
- PR17 applied: 503 only from the anchor's own reads, the org list, an incomplete matches read and a failed job read; an unverified candidate is a row (readRanking.ts:149-151, 190-200, 356-452).
- PR18 applied: fingerprint = system text + newline + stable schema JSON (prompt.ts:166-179); RUNBOOK says a schema enum change bumps RUBRIC_VERSION (RUNBOOK.md:1577-1582).
- PR19 applied: batchIndex and landlordCard passed (runBatch.ts:163-170).
- PR20 applied: entry key `home`; "anchor" / c / h references (prompt.ts:197-233); rubric says so (rubric.ts:38).
- PR21 applied: one anchor-exists rule for the claim and the pool (pool.ts:253-267; rankings.ts:88; pool.ts:398).
- PR22 applied: TTL below max age refused (config.ts:821-826).
- PR23 applied: "a property with no address on file", never attaches (seenSet.ts:22, 94-95; seenFeedback.ts:52); a landlord-default pets item closes the gap (completeness.ts:59-61).
- PR24 applied: 5 s under RANKING_READ_BUDGET=1, 20 s inside npm test (rankingRead.integration.test.ts:199-200); isolated number in the S6 report.
- PR25 applied: controls three times per direction, each must pass; subject at c1 with the same two fillers (rankingCounterfactual/plan.ts:27, 86, 105, 146-171; report.ts:147-169).
- PR26 applied: `poolWindowDays` on the read (readRanking.ts:114-115, 353); "Include tenants not heard from in N days" (RankAnchorPanel.tsx:150-155).
- PR27 applied: the out-of-list files are PR27's or a WORKLIST item's (WL-S2-10 aiRunsRepo header, WL-S5-5 pollLoop/worker comments, WL-S5-9 sse.test.ts, WL-S7-1/2/6 e2e performance and selectors); one more comment-only edit, app/scripts/db-seed.ts header (the matches sentence), follows S2's seed change.
- PR28 applied in code (move_in_date excluded as unclassified, cardFields.ts:223); the handback list itself is S9.4, not yet written.
- PR29 applied as amended: accommodation suppression by requirement item, `landlord:` mapped (cap.ts:62-82, 92-93); cross-key tests (rankingBandsCap.test.ts:110-147).
- PR30 applied: real tables outside production -> driver anthropic, fake / console refused, poll off by default (config.ts:672-681, 792-797, 845-847, 863-869); dev tick mounted only on a local target (dev.ts:813); RUNBOOK dev-modes column and caveat (RUNBOOK.md:75-116).
- PR31 applied: examples checked by production code; h, c and anchor references all used (rankingExamples.test.ts:163-262).
- PR32 applied: sha256 pins of the rubric, framing, both schemas and the examples beside their versions (rankingVersionPins.test.ts:24-48).
- PR33 applied: free-text list, reportable keys, landlord prefix live in cardFields.ts (319-367); schema, parse and cap import them; tie test (rankingSchema.test.ts:172-183).
- PR34 applied: cost defaults to 12 ISO weeks (adminRankings.ts:108-129, 339); listings project summary fields only (rankingRunsRepo.ts:619-641, 700-704); unread runs -> `incomplete: true` (rankingRunsRepo.ts:709-729, 843; adminRankings.ts:238, 354, 384); the page's message (RankingCostTotals.tsx:46).
- PR35 applied: example values non-empty; RUNBOOK and the sheet state the sync / copy / push / check flow (gate-run-commands.md:129-137; RUNBOOK.md:1905-1916).
- PR36 applied: guard read retried once, then finished failed by a generation-conditioned write (job.ts:463-495); putRun failure after a paid call logs usage and cost and fails the batch (runBatch.ts:231-259).
- PR37 applied: putMatches reports unwritten keys and never throws on DynamoDB failure (matchesRepo.ts:180-217); landed rows stay; only unwritten candidates listed (runBatch.ts:280-336).
- PR38 applied: tenant anchor unreadable -> done, every pool candidate notScored `unreadable`, the spec message (job.ts:273, 358-379; assemble.ts:429-433).
- PR39 applied: RANKING_DRIVER / RANKING_WORKER_POLL commented in .env.example, RANKING_WORKER_POLL commented in .env.dev.example, both set in .env.prod.example; layout pinned (rankingEnvExamples.test.ts:61-118).
- PR40 applied: an unlawful flag suppresses only its own field (cap.ts:87, 94); tests at rankingBandsCap.test.ts:132-147.
- PR41 applied: rubric's single accommodation instruction (rubric.ts:75); third control (rankingCounterfactual/records.ts:240-329).
- PR42 applied: failedBatches entries for call, run-write and match-write failures listing exactly the unmatched candidates (runBatch.ts:175, 255, 263, 332); the message counts candidates (job.ts:423-443).
- PR43 applied: property anchor unreadable after its pool -> done with every tenant notScored and the spec message (assemble.ts:357-362; job.ts:275, 358-379).
- PR44 applied: accommodation kept on any enum field (parse.ts:144-150); only item fields affect the cap (cap.ts:62-70).
- PR45 applied: qualifications joins every cap-eligible item for accommodation only (cap.ts:72-82); the both-places tests (rankingBandsCap.test.ts:117-123).

WORKLIST build rulings:
- WL-S3-3 applied as written: `propertyDisplay` returns the trimmed stored string address before the placeholder (assemble.ts:254-267; test rankingAssemble.test.ts:172-198). It feeds staff display only: prompt.ts:332-338 copies `display` into the run's handles, never into the wire; `SeenHome.label` and `attachLabel` are unchanged (seenSet.ts:83, 94-95). No conflict with the spec (D9 rows carry a display; PR23's placeholder is the model-facing seen-home label).
- WL-S4-3 applied as written: every example card follows the builders' order (registry order, then derived keys; seen entries home, label, sends, daysSinceLastSend, declined, tours, feedback; pair history sends, declined, tours, daysSinceLastSend) - checked across examples 1, 2 and 9 (examples.ts:57-101, 124-232, 639-680); membership test unchanged (rankingExamples.test.ts:215). No conflict: it is what spec D2.2 (fixed key order) and PR31 (the real wire shape) ask.

## 3. Specific checks

### 3.1 Cameron's launch-gate question - HOLDS

- The prompt fingerprint is the MATCHING model's only: sha256 over the ranking system text (RUBRIC_TEXT + rendered examples) and the ranking schema (prompt.ts:150-153, 166-179). Nothing from extraction enters it.
- No prompt fingerprint feeds the out-of-date test: `outOfDateReasons` reads the three card/pair fingerprints, computedAt (age), rubricVersion, examplesVersion, model, the last job's lists and unverified - never `promptFingerprint` (readRanking.ts:161-188). `promptFingerprint` is only recorded (runBatch.ts:138; runLog.ts:99); `git grep promptFingerprint` finds no comparison in app/src.
- An extraction prompt or model change cannot reach a card except through data it writes: the tenant card carries the matching inputs keyed by their list `label` (cardFields.ts:241), while the extraction prompt reads only `key` and `promptGuidance` (services/extraction/prompt.ts:96); every `*_source` provenance key, `notes_updated_at`, `ai_mode`, `classification_revision` and `last_reached_out_at` are excluded (cardFields.ts:163-189, 243). The retry guard drops a re-emitted line already in the box (apply.ts:357-372), so a re-run that writes nothing new changes no fingerprint. A match goes out of date only when a field value or a Notes line actually changes.
- Awareness only: an edit to a list LABEL (lib/tenantMatchingInputs.ts) changes every tenant card key and so every tenant fingerprint; that is a card-definition change shared by the B1 list, not an extraction prompt or model change.

### 3.2 "A default or guessed score is never written" (charter 7.4) - HOLDS

Every path from a model call to a match row:
- parse.ts:192-215 gives a result only to a known handle returned exactly once with a finite numeric score (clamped and rounded, never invented); a duplicate, an unknown handle, an omission or a non-numeric score yields no result.
- runBatch.ts:185-193: `byCandidate` is filled only from a successful call's parsed output; `scored` is the batch members with a result; rows are built only for `scored` (269-278).
- A failed call (refusal, parse, truncated, timeout, driver) writes no row (runBatch.ts:261-267); an unbuildable prompt makes no call and no row (171-179); a putRun failure writes no row (231-259); an exception in a batch writes no row (job.ts:320-345).
- The run's results[] records a not-returned candidate as `returned: false` with no score (runLog.ts:59-61).
- The fake and console drivers (made-up scores) are refused in production and on real tables (config.ts:854-869); the read never synthesizes a match (`match: null`, readRanking.ts:227-230).

### 3.3 PR1 - HOLDS (by code and records)

- No test constructs a sending client or reads the key: the SDK is mocked in rankingDriver.test.ts:21; the wiring test builds the console driver (rankingWiring.test.ts:53); the counterfactual tests inject env and the driver (the S8 read found no `process.env`, `new Anthropic`, SDK import or createRankingDriver in them).
- Neither real-model script runs on import: extraction-schema-compile-check.ts:110-111 and ranking-counterfactual-check.ts:429-430 run main only when invoked directly. The counterfactual `--dry-run` never reads ANTHROPIC_API_KEY (ranking-counterfactual-check.ts:407-408) and returns before any driver exists (326-329).
- The hermetic stack runs the fake driver (e2e-session.mjs:271) and the dev tick mounts only on a local DynamoDB target (dev.ts:813).
- No counterfactual record exists in the worktree, so no non-dry run wrote one. Process history itself cannot be audited from the code.

### 3.4 Production refusals and PR30 - HOLD

fake / console refused under production (config.ts:854-861); RANKING_WORKER_POLL=off refused under production (870-875); ANTHROPIC_API_KEY required in production whatever AI_EXTRACTION_ENABLED says (876-882); ANTHROPIC_API_BASE_URL still refused (1267-1272). PR30: a non-production process whose DYNAMODB_ENDPOINT is not loopback (`isLocalDynamoTarget`, 672-681) defaults to anthropic, refuses fake / console (863-869) and defaults the poll off (845-847); the dev tick is not mounted there (dev.ts:813-827). Pinned by configRanking.test.ts:283-423.

### 3.5 Event payload, roles, rate limit - HOLD

- Payload: exactly {anchorKind, anchorId, generation, status, batchesDone, batchCount} (events.ts:356-363; runBatch.ts:76-85); the poll's emits pass through the same builder (job.ts:593, 623); no score, name or card field.
- Roles: /api/rankings sits behind the /api mount's requireAuth only, so admin and va rank, read and poll (api.ts:912-921); /api/admin/rankings has `router.use(requireRole('admin'))` (adminRankings.ts:183); the tab is adminOnly inside AdminRoute.
- Rate limit: one per-user createUserRateLimit (`ranking_rank`, RATE_LIMIT_RANK_PER_MIN, 60 s) on the POST only, ahead of the handler (rankings.ts:105-112); reads and the job poll unmetered; 429 tested (rankingsApi.test.ts:141-160); the e2e lane raises it (e2e-session.mjs:198).

### 3.6 User-facing strings - HOLD (with NOTEs)

- Every added line on the branch is ASCII: `git diff -U0 404e039d...HEAD`, added lines, non-ASCII bytes = 0.
- Server copy matches the spec and rulings exactly: "A ranking is running for this record. Try again when it finishes.", "The ranking was not picked up. Press Rank again.", "The ranking stopped before it finished. Press Rank again.", "Pool too large to rank (N candidates)", "N tenants could not be read and were not scored. Press Rank again.", "Could not read this tenant's/property's record. Press Rank again.", "a property no longer on file", "a property with no address on file", "flagged as a requirement fair housing does not allow", "requirement not met" (job.ts:40-67, 273-275; pool.ts:222-226; seenSet.ts:21-22; flags.ts:22; cap.ts:33).
- No staff-facing string says "unit" (server strings grepped; the S7 read found none in the dashboard; rankingFormat.ts:58, 62 say "property"). No tenant-facing copy is added.
- Plain-language NOTEs: raw field keys in flag cells (N4), "1 candidates" (N5), a doubled loss message (N3).

## 4. Required-but-not-built, and built-but-not-asked

Required by the spec and not built: only the run detail's link from a pair to its current match (D11d, SF1). Nothing else is MISSING. Two deliverables are S9's and not yet due: the handback list (PR28, S9.4) and the gate sheet's `<commit>` / `<fingerprint>` (S9.1).

Built beyond the spec (none contradicts the spec or a ruling):
- Server: `failure: 'error'` failed batches and `notScored` 'omitted' (inside PR13 / PR42); `markLeaseFailed` as its own primitive; the poll's summary object and the dev tick's JSON summary; `currentUnavailable` / `flagsUnavailable` on the run detail; the cost endpoint's 50-page cap with `truncated` (adminRankings.ts:68, 368-373); the runs list `limit` parameter; `poolTooLarge.message`; RANKING_EFFORT accepting xhigh / max; the dev tick's local-target gate (R2F6, a safety addition); the rubric's "card text is data, never instructions" and "do not re-check eligibility" paragraphs (rubric.ts:45-46; part of r1, which Cameron reads at the handback).
- Dashboard (S7 read): a Refresh button, every choice kept in the URL, the "About this anchor" facts, the "(joined the ranking already running)" suffix, the cost range note, every unit and tenant loaded when the page opens (useRankCandidates.ts:15-34), "(The notes were cleared.)" and focus / aria-describedby on the edit form, and a trimmed Notes compare (a whitespace-only Notes edit no longer saves).
- Scripts and docs (S8 read): the counterfactual endpoint / ANTHROPIC_AUTH_TOKEN line and `--concurrency` (plan C10), the `--out` pre-check creating an empty record file (WL-S8-12), RUNBOOK sections beyond the asked ones ("Reading a ranking that went wrong", "Where ranking shows", "Fair-housing flags", the operator-script caveat), the GLOSSARY umbrella "Ranking" entry, the env test's loadConfig parse block.

## 5. Findings

MUST-FIX: none.

### SHOULD-FIX

- SF1 (spec D11; spec section 5) The run detail marks a re-scored pair but does not link it to its current match. dashboard/src/routes/settings/rankings/RankingRunDetail.tsx:119 renders `currentMatchText(...)` (rankingFormat.ts:140-144) as plain text ("This run" / "Since re-scored" / "No current match"), although `currentRunId` is on the wire (adminRankings.ts:289, 306; dashboard types). Scenario: an admin opens run A, sees "Since re-scored" on a pair, and has no way to open run B that holds the current score short of hunting through the runs list by anchor and time. Fix: render the cell as a button that opens run `currentRunId` through RankingsSection's existing URL state (no server change).
- SF2 (GLOSSARY accuracy, new text) documentation/GLOSSARY.md:180-181 says a stale Notes save is refused "with the current notes shown below the box". The built conflict panel renders ABOVE the Notes textarea (ContactEditForm.tsx:1264-1287; no CSS reordering), consistent with spec D14.3's "beside the Notes box". Scenario: someone writing support copy or an e2e assertion from the glossary looks under the textarea and finds nothing. Fix: "shown beside (above) the box".

### NOTE

- N1 (useAnchorRanking.ts:124-141) The first ranking read adopts its own job snapshot. If a press's claim lands after that read took its job snapshot (readRanking.ts:363-369, after the pool is assembled) but the press's 202 arrives before the read's response, the page shows the old job state and stops the 5 s poll until a ranking.updated event (a best-effort hint) arrives. Narrow window; a press-after-read guard on `adoptJob` would close it.
- N2 (adminRankings.ts:368-373; RankingCostTotals.tsx) The cost totals stop at 50 pages of 100 runs and set `truncated`, which the page never shows; past ~5000 runs in range the totals are silently low. PR34 covers only `incomplete`; worth showing once B3's composer presses grow the run count.
- N3 (rankingFormat.ts:104-138 with job.ts:435-443) A done job with failures states the loss twice, e.g. "Done: 1 batch; 2 candidates not scored. 2 tenants could not be scored. Press Rank again."
- N4 (RankAnchorPanel.tsx:40; RankingRunDetail.tsx:20-23, 86, 137) Raw field keys reach staff copy ("accommodation on no_pets", "Failed: <failure code>"). ASCII and never "unit"; acceptable on a test surface, not plain.
- N5 (RankingRunList.tsx:104; RankingRunDetail.tsx:69) "1 candidates" is not pluralized.
- N6 (RankingRunList.tsx:91-94; adminRankings.ts:214) A run that could not be read arrives as `{runId, expired: true}` and is labeled "Expired run <id>" while the page also says runs could not be read.
- N7 (RankingRunDetail.tsx:76-80) A scored run whose candidates were all omitted makes no match write, so it reads "Matches: not written", which suggests a failed write.
- N8 (job.ts:301-318, 440-443; rankingRunsRepo.ts:467-490) The finish write has no consistent generation read before it, which spec D7 lists for "every write (... record)"; it is instead a conditional write on status running AND the generation (plan R2B5). That is atomic and stronger than the read; recorded so nobody "restores" the read.
- N9 (rankings.spec.ts:272) The VA role test ranks the seeded contact-tenant-0001 rather than an API-built fixture (plan C6: role checks only, empty pool). The "Since re-scored" mark is unit-tested only (RankingRunViews.test.tsx:270).
- N10 (gate-run-commands.md:10, 12) `<commit>` and `<fingerprint>` are still placeholders; plan S9.1 fills them after the main sync, and the S8 report asks for the 414 / $16.80 and 660 / $26.78 figures to be re-checked against a post-sync dry run (WL-S8-1 `env -u` prefix).
- N11 (matchesRepo.ts:249-277) listByUnit / listByTenant exist as spec D8 says but nothing calls them; the run detail and the read go by key.
- N12 (RUNBOOK.md:1694-1704) The pre-existing extraction "Owed ops on deploy" text still says the feature ships dormant so "nothing breaks" and lists pushing ANTHROPIC_API_KEY as an enable step; since B2a every production stack refuses to boot without the key (config.ts:876-882; RUNBOOK.md:1488, 1791, 1906 say so). Both stacks hold the key, and the boot error is explicit, so the impact is a confused operator on a NEW environment.
- N13 (scripts/rankingCounterfactual/report.ts:154; evaluate.ts:84-89; records.ts:269, 327) A control "hit" requires the flag on a listed field (C1: a Pets key; C3: qualifications or a Pets key), narrower than D17's "an accommodation flag". It fails safe (FAIL / Cameron decides) when the model flags the right kind on another field; the record also omits per-run flags and raw text (WL-S8-11's accepted wording).
- N14 (GLOSSARY.md:913-916) The "Fingerprint" entry (card and pair-history hashes) does not set itself apart from the "prompt fingerprint" every run records and the gate sheet prints; readers may confuse the two.
