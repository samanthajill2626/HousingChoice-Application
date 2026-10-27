# R1 - Spec conformance review - WP1 B1 Ranking inputs

- Reviewer: R1 (spec conformance), Claude Opus 5.5, 2026-10-27.
- Branch `feat/wp1-b1-ranking-inputs` @ 67d877cc; merge base main @ d0e2c2d8.
- Contract: spec rev 10; plan sections 0-4 (WI1-WI16, PR1-PR58); WORKLIST
  WL-1..WL-42; slice reports S1-S5, S6a, S6, S7-e2e.
- Method: every row below was checked against the LIVE tree (not the
  reports). Test files were run one file per command at 67d877cc, all exit 0:
  app (23 files): extractionNoteLines 12, propertyLabel 18,
  extractionSentPropertiesBlock 18, tenantMatchingInputs 12,
  tenantMatchingInputsReaders 2, extractionProbeNeverWritten 16,
  extractionPromptProbe 90, configAiExtraction 19, unitsRepoDisplays 11,
  extractionRunWindow 17, extractionSchema 60, extractionApply 121,
  extractionJob 110, contactTenantMatchingInputs 8, suggestions 27,
  unitFields 84, propertyFormFlyerParity 10, seedTenantMatchingInputs 3,
  seedPriority 1, structuredOutputClient 11, extractionAdapter 33,
  extractionRunTypes 3, journalSweep 28; dashboard (13 files):
  EligibilityIntakeCard 14, ContactEditForm 128, tenantMatchingInputsMirror 5,
  tenantMatchingInputs 9, SuggestionChip 7, ContactCreateForm 17,
  AiRunsSection 41, ListingDetail 140, ListingEditForm 97, UnitCreateForm 85,
  requirements 59, requirementsMirror 10, types 40. Two THROWAWAY tests
  (`app/test/_r1conf_probe.test.ts`,
  `dashboard/src/routes/contact/_r1conf_portion.test.tsx`) were run and
  DELETED; the tree is clean. No e2e, no full suite, no real model, no key.
- Throwaway results used below: extraction prompt fingerprint at HEAD
  `436f91b01983`, grader prompt fingerprint `5887c5904d61` (equal to the S6
  dry-run values, so S7 changed no prompt); the CONF-1 and CONF-5
  reproductions.
- ASCII: `git diff -U0 d0e2c2d8..HEAD` added lines through
  `tr -d '\11\12\15\40-\176' | wc -c` prints 0 (code and docs).
- Untouched surfaces confirmed by empty `git diff --stat d0e2c2d8..HEAD`:
  app/src/lib/import, app/src/routes/public.ts, app/src/lib/seed/lean.ts,
  app/src/services/extraction/runWindow.ts, ContactCreateForm.tsx,
  TenantFile.tsx, infra/, app/src/lib/tables.ts, every package.json and
  package-lock.json.

## Counts

- By verdict (145 table rows): CONFORMS 142, PARTIAL 1, MISSING 2 (both
  pending by design), DEVIATES 0.
- By severity (findings below): HIGH 0, MEDIUM 0, LOW 1, INFO 6.

## Table

Verdicts read "as ruled" where an approved ruling (launch-gate list PR9,
PR16, PR21, PR22, PR23, PR24, PR25, PR45, PR54) or a WL item departs from
spec text. File paths are relative to the worktree root.

### Spec D1 - one list of tenant matching inputs

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| D1 leaf module, imports nothing, the ONE list with key / label / chipLabel / kind / control / source exactly as the D1 table | CONFORMS | app/src/lib/tenantMatchingInputs.ts:37-78; leaf pin app/test/tenantMatchingInputs.test.ts:116 | values pinned at tenantMatchingInputs.test.ts:77-85 |
| D1 `promptGuidance` per entry | CONFORMS | tenantMatchingInputs.ts:45-76 | one ASCII line each (test :88) |
| D1 `source` = field for all four; type admits `notes`; no notes path | CONFORMS | tenantMatchingInputs.ts:21, :44-74 | no code reads `source` at all - see CONF-4 (INFO) |
| D1 extraction readers iterate the list (EXTRACTABLE_FIELDS -> PROVENANCE_FIELDS, schema entries, CURRENT PROFILE, prompt guidance, coercion by kind, DECISION_TARGETS / TENANT_ONLY_TARGETS) | CONFORMS | schema.ts:30-49, :85-86; jobs/extraction.ts:188; prompt.ts:90-103; apply.ts:123-125; runTypes.ts:16, :40 | textual pin app/test/tenantMatchingInputsReaders.test.ts:28; `git grep` of the four keys in app/src + dashboard/src non-test finds only the seed (cast.ts:457-460) and the two list modules |
| D1 runTypes imports only the leaf; header says so | CONFORMS | app/src/services/extraction/runTypes.ts:1-6 | pin extractionRunTypes.test.ts:44 |
| D1 contacts PATCH and create parsers iterate the list | CONFORMS | app/src/routes/contacts.ts:790-795, :997-1001 via parseTenantMatchingInputs (tenantMatchingInputs.ts:116-152) | |
| D1 dashboard mirror + drift test importing the app module; edit form, record rows, SUGGESTION_TARGET_LABEL iterate it | CONFORMS | dashboard/src/routes/contact/tenantMatchingInputs.ts:27-44; tenantMatchingInputsMirror.test.ts:22-61; ContactEditForm.tsx:918; EligibilityIntakeCard.tsx:86; suggestionTargets.ts:24 | mirror test also proves every client patch is one the server parser stores unchanged (:45) |
| D1 later move to notes / B2 completeness pass | CONFORMS | - | nothing for B1 to build |

### Spec D2 - the four fields on the record, the edit form and the display

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| Storage: four optional attributes, text strings, portion whole dollars, absent = not recorded | CONFORMS | contactsRepo.ts:122 (`ContactItem extends TenantMatchingInputValues`); tenantMatchingInputs.ts:90-92 | |
| Server text rule: string, trimmed, <= 500 after trim (exact copy), '' or null clears by REMOVE | CONFORMS | tenantMatchingInputs.ts:144-149, :98-100; contacts.ts:790-795 (null -> REMOVE) | contactTenantMatchingInputs.test.ts:48, :77, :103 |
| Server dollars rule: integer 0..20000, null / '' clears, else 400 with exact copy | CONFORMS | tenantMatchingInputs.ts:128-142, :102-104 | test :115 (20001, -1, 1200.5, '1200') |
| Not type-gated (UI guarantee) | CONFORMS | contacts.ts:786-795 | test :125 (landlord) |
| Provenance: the four join PROVENANCE_FIELDS; a staff PATCH clears `<key>_source` | CONFORMS | schema.ts:49; contacts.ts:1120-1123 | suggestions.test.ts:558, :579 |
| Audit: `contact_updated` with field names | CONFORMS | contacts.ts:794 (changedFields) | test :65 |
| Edit form: tenant-only Eligibility intake block, one control per entry in list order by `control` (input / textarea / number with `$` beside), trimmed diff, cleared -> null | CONFORMS | ContactEditForm.tsx:871, :918-962, :483-485; tenantMatchingInputs.ts (mirror):111-137 | ContactEditForm.test.tsx tenant-matching describe (cleared -> null at :2166) |
| Edit form: client message for a bad portion = the server's | PARTIAL | ContactEditForm.tsx:941-949; mirror tenantMatchingInputs.ts:118-123 | 12.5 / 20001 / -5 refused with the server copy; an entry the number input cannot parse reads as '' and is treated as a CLEAR - see CONF-1 (LOW) |
| Record: four always-render rows in list order, BLANK when unset, AutoBadge and chip, portion `$1,200 / month` in row AND chip | CONFORMS | EligibilityIntakeCard.tsx:86-97, :129, :132-145; mirror formatTenantMatchingValue :73-87; SuggestionChip.tsx:47 | EligibilityIntakeCard.test.tsx:106, :156 |
| Labels exact and distinct (no substring of an existing intake label) | CONFORMS | tenantMatchingInputs.ts:40-71 | app/test/tenantMatchingInputs.test.ts:101 (both directions, labels and chip nouns) |
| "Preferences & notes" card keeps its title | CONFORMS | no diff to the notes card; TenantFile.tsx untouched | |
| API types: Contact gains values + `_source`; ContactPatch / ContactCreate values only (as ruled PR23, PR24) | CONFORMS | dashboard/src/api/types.ts:2263-2265, :2322, :2348, :2494 | `CreateContactInput` is `ContactCreate` in the tree (PR23) |
| Create form gains no inputs; create parser accepts them | CONFORMS | contacts.ts:995-1001; ContactCreateForm.tsx untouched | PIN ContactCreateForm.test.tsx (tenant-matching describe) |

### Spec D3 - extraction reconciles the four

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| EXTRACTABLE_FIELDS 8 -> 12 through the list | CONFORMS | schema.ts:30-40 | extractionSchema.test.ts:92 |
| The existing rule unchanged for all four: write / suggest / Layer-3 demotion / provenance stamp / accept / dismiss | CONFORMS | apply.ts:401-520 (generic field loop) | extractionApply.test.ts tenant-matching describe incl. demotion :758 |
| A `write` on a NON-EMPTY text field is DROPPED `text_field_filled`, not a suggestion, not in `demotedFields`; portion keeps the pets rule | CONFORMS | apply.ts:389-399, :207-209 | extractionApply.test.ts:1676, :1691, PINs for whitespace-only and same-fact portion write |
| Schema: four more all-required fieldOp entries; zero optional parameters | CONFORMS | schema.ts:85-86 | extractionSchema.test.ts:110 |
| Coercion by kind in coerceField AND coerceAccept (one rule, PR13): text trim / 500 drop / empty drop; dollars strip `$`, commas, spaces, integer 0..20000, 1200.50 dropped | CONFORMS | apply.ts:145-164; suggestionResolution.ts:166-175 | throwaway: `$1,200`->1200, `1 200`->1200, `1200.50`/`1200.00`/`-5`/`20001` dropped |
| DECISION_TARGETS 12 -> 16, TENANT_ONLY_TARGETS +4; every hard-coded count updated (prompt "eight", schema "eight", comments, SWEEP_MAX_ATTEMPTS_PER_CALL, DECISION_TARGET_ORDER) | CONFORMS | runTypes.ts:15-20, :37-41; prompt.ts:57; journalSweep.ts:88; AiRunDetail.tsx:43-48 | WI3 grep re-run: no stale count word in extraction code |
| CURRENT PROFILE carries the four (by kind) | CONFORMS | jobs/extraction.ts:185-197 | extractionJob.test.ts toProfile describe |
| Prompt guidance from the list + the accumulate rule for the three text fields; "stairs" and "rent portion" noteLine examples removed | CONFORMS | prompt.ts:90-103, :134-138 | extractionSchema.test.ts:707, :738; throwaway confirms absence |
| The never-written list does not govern the fields | CONFORMS | prompt.ts:144 ("NEVER write a noteLine") | fields judged only as "reported" in the probe |

### Spec D4 - Notes lines

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| Widened noteLines instruction + adds-to-filled-field; reconcile / append-only / short rules verbatim; no-address bullet removed; screening facts allowed | CONFORMS | prompt.ts:134-140, :153-166 | extractionSchema.test.ts noteLines describe ("keeps ... verbatim") |
| Never-written list text, incl. sex covering sexual orientation and gender identity (PR58) | CONFORMS | prompt.ts:144-152 | extractionSchema.test.ts:780-791 |
| Shape `{ text, confidence }`, both required | CONFORMS | schema.ts:118-131; adapters/extraction.ts:92-97 | |
| Floor EXTRACTION_FACT_MIN_CONFIDENCE, default 0.7, fail-fast 0 < x <= 1 | CONFORMS | app/src/lib/config.ts:525-544, :938-939 | configAiExtraction.test.ts:123 (0, 1.5, abc, -0.1, NaN, Infinity) |
| Order clamp -> floor (counted) -> postal -> guard (all lines) -> system lines -> cap (as ruled PR9); parser keeps 20, filters nothing; pure exported filterNoteLines; floor via ApplyDeps; coerceField exported | CONFORMS | apply.ts:283-309, :57, :145, :904-913; schema.ts:173, :272-284 | extractionNoteLines.test.ts:33 (floor before cap), :69 (guard before cap) |
| System lines carry no confidence, bypass the floor | CONFORMS | apply.ts:303-305 | extractionNoteLines.test.ts:87 |
| Unknown-speaker demotion appends no line of either kind | CONFORMS | apply.ts:308, :911 | extractionNoteLines.test.ts:101; extractionApply.test.ts:1782 |
| Kept: `[Auto - <date>]` prefix, verbatim guard, read-modify-write | CONFORMS | apply.ts:211-216, :286-287, :899-925 | |
| Run record `notesBelowFloor`, `notesDemoted` (record fields) | CONFORMS | aiRunsRepo.ts:71-78; jobs/extraction.ts:716-717, :769-770 | extractionJob.test.ts:1996, :2002 |
| Growth unbounded, accepted | CONFORMS | - | nothing to build |

### Spec D5 - feedback lines

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| D5.1 `propertyLabel` leaf: `<l1>[ <l2>], <city>`, one line (as ruled PR45), undefined on empty line 1 / city | CONFORMS | app/src/lib/propertyLabel.ts:48-68 | propertyLabel.test.ts:11-45 |
| D5.1 `labelMatches`: fold case, `. , #`, whitespace; boundary match; no abbreviation folding | CONFORMS | propertyLabel.ts:71-88 | propertyLabel.test.ts:47-85 (12 vs 112, St. vs St, extra-comma line 2, different line 2) |
| D5.1 rows: tenant AND unknown contacts, `listByContact` LISTED rows, newest 20 by sentAt | CONFORMS | jobs/extraction.ts:638-646; listingSendsRepo.ts:486-497 (isListed); sentPropertiesBlock.ts:81-95 | extractionJob.test.ts:2085 (unknown); block test :42 |
| D5.1 `getDisplaysByIds({ requireComplete })` throws on an incomplete read (as ruled PR16); a completed miss is skipped; existing callers unchanged | CONFORMS | unitsRepo.ts:1286, :1312-1327; routes/tours.ts:551 passes no opts | unitsRepoDisplays.test.ts:164, :186, :207 (WI8) |
| D5.1 block: `- <label> - sent <date>` / `signed up` (latest counted share = flyer), identical labels once, newest first, YYYY-MM-DD (PR19), before TRANSCRIPT, fingerprint into the run record | CONFORMS | sentPropertiesBlock.ts:97-146; prompt.ts:256-257; jobs/extraction.ts:665, :761 | block test :57, :77, :111 |
| D5.1 TRANSCRIPT drop + WARN; 4,000-char budget, oldest dropped first + WARN; `PROPERTIES SENT: none` | CONFORMS | sentPropertiesBlock.ts:115-138; jobs/extraction.ts:650-663 | block test :93, :142, :164, :173; job WARN tests |
| D5.1 a failed `listByContact` or incomplete units read FAILS the run like the org-list read | CONFORMS | jobs/extraction.ts:637-649 (`failed('repo')`, as at :612) | extractionJob.test.ts:2146, :2158 |
| D5.1 system prompt names the block; transcript render and per-message hash unchanged | CONFORMS | prompt.ts:30-35; runWindow.ts no diff | extractionRunWindow.test.ts:334 (literal hashes) |
| D5.1 `listingSends` and `units` REQUIRED job deps at every construction site | CONFORMS | jobs/extraction.ts:129-130; worker.ts:471-473; routes/dev.ts:748-749 | typecheck gate |
| D5.2 prompt: name the property by copying its label; tenant's sense + reason; maybe stays maybe; place feedback names a home only when tied; reconcile, change of mind is new; never-written list governs | CONFORMS | prompt.ts:167-184 | extractionSchema.test.ts PROPERTIES SENT system-prompt describe |
| D5.2 no-address bullet REMOVED (PR50); address-output bullet and postal filter KEPT | CONFORMS | prompt.ts:185-190; apply.ts:285 | pinned "drops the no-address bullet; the address output still never takes a sent home" |
| D5.3 no new filter; `feedbackLines` / `unlabeledAddressLines` over the APPENDED lines, shown in the run detail beside notedLines | CONFORMS | apply.ts:924; sentPropertiesBlock.ts:155-166; jobs/extraction.ts:720-724; AiRunDetail.tsx:82-83 | street pattern over-counts - CONF-5 (INFO) |
| D5.3 never a status / outcome / declined | CONFORMS | no such write in the extraction path | WI10 test extractionJob.test.ts:2225 |
| D5.4 nothing excluded was built (no reactions attribute, writer, remove control, projection, shape check, attach step, Maybe button) | CONFORMS | listingSendsRepo.ts no diff | |

### Spec D6 - Priority

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| `priority` validator `'boolean'` (same_day_rta template) | CONFORMS | app/src/lib/unitFields.ts:106-111 | unitFields.test.ts:854 refuses strings and null |
| Types `priority?: boolean` (unitsRepo, dashboard UnitItem as ruled PR23); legacy string reads off; no migration | CONFORMS | unitsRepo.ts:464-466; dashboard/src/api/types.ts:2745 | every reader is `=== true` (see `git grep -w priority`) |
| "Priority" TaggedCheckbox, Staff only, own row after Same-day RTA, New AND Edit forms; off stored false (PR28) | CONFORMS | UnitCreateForm.tsx:749-755, :314; ListingEditForm.tsx:616-622, :193 | UnitCreateForm.test.tsx:1096; ListingEditForm.test.tsx:928, :939 |
| PROPERTY_FORM_FIELDS + mirror 35 -> 36 with parity SAMPLE; DOM order holds | CONFORMS | app/src/lib/requirements.ts:552-554; dashboard requirements.ts:276-277 | propertyFormFlyerParity.test.ts:49-51, :178; requirements.test.ts :243, :601, :625 (WL-4) |
| Never on the flyer | CONFORMS | unitFields.ts flyer allowlist (no priority) | unitFields.test.ts:863; e2e property-priority.spec.ts:142-151 |
| ListingDetail "Priority" Yes/No row in Property details; header pill when on | CONFORMS | ListingDetail.tsx:890, :1006 | ListingDetail.test.tsx:3348 |
| Importer unchanged; the model never sees priority | CONFORMS | airtableSource.ts untouched; no priority reader in services/extraction or jobs/extraction.ts | |

### Spec D7 - the never-written test

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| Probe refactored to exported `main` + `invokedDirectly` guard (assign-primary-contacts template); ExtractionInput construction updated | CONFORMS | app/scripts/extraction-prompt-probe.ts:1563-1591, :222-224, :474-478 | |
| `--suite never-written` runs production renderer (selectSentRows + renderSentPropertiesBlock), driver, prompt, schema, then filterNoteLines and coerceField; touches no data | CONFORMS | probe :264-272, :295-310, :831-874, :1419-1495 | PR30 seams; one `filterNoteLines` call (:301), one `coerceField` call (:847) |
| Default suite branch vs main, 3 runs each, same model; FAIL on a case 2+ below or total > 2 below (+ branch truncation, as ruled PR21); one re-run of both sides; both in the same record | CONFORMS | probe :627-637, :1496-1557 | flag is `--baseline` (PR21); extractionPromptProbe.test.ts:934-1001 |
| Cases: one per excluded kind (race, color, religion, sex, national origin, pregnancy, marital status, children's ages, medical), each free AND inside feedback; sex feedback case plants sexual orientation (PR58) | CONFORMS | app/scripts/extractionProbeNeverWritten.ts:251-307 | data test :52 |
| Controls: household size, portion (field), accessibility need (field), assistance animal, plain fact, feedback unsure / tied no / yes, untied place, no-address-op; plus the D3 adds-to-filled-field probe case | CONFORMS | extractionProbeNeverWritten.ts:236-412 | data test :89 |
| Feedback detection by meaning (labelMatches; untied = a line and none names a sent property); record prints message, gist, lines | CONFORMS | probe :797-828, :1158-1176 | |
| Model grader: ONE call per run with items (same model and key, structured output); never-written list as descriptions + planted fact + items, NO conversation; verdict / kind / reason; no items -> no call | CONFORMS | probe :881-884, :1463-1469; data :62-108, :153-156 | |
| A line judged excluded fails ANY case; a field value judged excluded is reported only; ungraded (failed or unparseable) counts against 2 of 3 | CONFORMS | probe :896-935, :956-977 | tests :389-450, :791-873 |
| Grader prompt in the data module, pinned; vendor call through app/src/adapters, injected | CONFORMS | data :80-108; adapters/extraction.ts:449-542; probe :1323, :1370 | extractionProbeNeverWritten.test.ts:166-250; structuredOutputClient.test.ts |
| Record: per case planted fact, every written line and field value with verdict / kind / reason; commit, model, both fingerprints, case content hashes; tokens, truncations, dated price-table cost (table in the data module, PR6, PR39) | CONFORMS | probe :1081-1197, :1011-1013, :943-949; data :431-439 | |
| 3 runs per case; `--model` REQUIRED (no fallback); key printed as last four; `--out` | CONFORMS | probe :1287-1298, :535-539 | test :155 |
| Pass rule (zero excluded lines, 2 of 3 graded, controls 2 of 3, zero truncations, exit 0) + sign-off section | CONFORMS | probe :956-990, :1188-1195, :1494 | |
| The gate run itself (record + Cameron's sign-off) | MISSING | no never-written-test.md on the branch | pending BY DESIGN (PR1) - CONF-2 (INFO) |

### Spec section 4 - surfaces

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| Tenant contact four fields: writers (PATCH, create, extraction empty-text-only write, accept), readers (intake card, edit form, chips, CURRENT PROFILE, run detail), untouched (public intake, importer, Today), seeds (full tenant gains four, as ruled PR25; lean byte-stable) | CONFORMS | as D2/D3 rows; app/src/lib/seed/cast.ts:454-460 | seedTenantMatchingInputs.test.ts lean PIN |
| Tenant `notes`: staff PATCH, extraction append, importer replace (filed); readers incl. hasAiCaseworkerNote | CONFORMS | apply.ts:899-926; docs/issues/import-overwrites-notes-box.md | edit-form replace also filed (WL-17) |
| listing_sends and units READ only; requireComplete; no write / attribute / shares_op change | CONFORMS | jobs/extraction.ts:638-649 | WI10 proxy test :2225 |
| AI run record + readers: four counts + sentPropertiesFingerprint shown in the run detail | CONFORMS | aiRunsRepo.ts:59-84; routes/aiRuns.ts:271 returns the whole run; AiRunDetail.tsx:71-86 | |
| Unit `priority`: writers create / PATCH, readers ListingDetail and both forms; never flyer or cards | CONFORMS | as D6 rows | |
| Schema / prompt fingerprint changes (expected) | CONFORMS | throwaway: 436f91b01983 at HEAD | |
| Docs: RUNBOOK "never demoted" fixed, sonnet-5-5, extraction section; env examples; GLOSSARY nouns, feedback line, card-vs-field note | CONFORMS | RUNBOOK.md:1456-1459, :1467, :1469, :1472-1491, :1515-1535, :614, :1635; .env.example:200; .env.dev.example:232; .env.prod.example:257; documentation/GLOSSARY.md:175-222 | RUNBOOK gate wording - CONF-3 (INFO) |

### Spec section 5 - tests (each found; each can fail)

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| D1: list drives fields, targets, tenant-only, parsers, mirror; drift test | CONFORMS | extractionSchema.test.ts:92; extractionRunTypes.test.ts:16; suggestionReclassification.test.ts:247; tenantMatchingInputsMirror.test.ts:22, :45; tenantMatchingInputsReaders.test.ts:28 | all exact-value asserts; RED recorded in S1/S3 |
| D2: trim, '' and null clear, length and range errors, provenance clear, form null on clear, four rows BLANK, `$1,200 / month` row and chip | CONFORMS | contactTenantMatchingInputs.test.ts:48, :77, :103, :115, :134; suggestions.test.ts:558, :579; ContactEditForm.test.tsx:2166; EligibilityIntakeCard.test.tsx:106, :156 | no test feeds an unparseable portion (CONF-1) |
| D3: coercion both paths; write / suggest / demotion as pets; additive fact -> line (probe case); 16 targets; zero optional; no stairs / rent examples, no stale "eight"; filled-field write dropped | CONFORMS | extractionApply.test.ts:1563-1580, :758, :1676, :1691; suggestions.test.ts:517, :595; extractionSchema.test.ts:110, :707, :738; data control-adds-to-filled-field | S3 proved coerceAccept non-vacuous by disabling the delegation (4 RED) |
| D4: floor 0.7 keep / drop, floor before cap (7 lines), config fail-fast, system bypass, demoted run none, guard, record counts | CONFORMS | extractionNoteLines.test.ts:19, :33, :69, :87, :101; configAiExtraction.test.ts:123; extractionJob.test.ts:1996, :2002 | a cap-then-floor order fails :33 |
| D5: label and match cases; requireComplete throws both ways and default unchanged; incomplete read fails the run; block rows (newest 20, unknown, signed up, missing unit, identical once, budget, TRANSCRIPT, none); read failure fails run; render and hash unchanged; feedback passes filter and counts; unlabeled counted; no listing_sends write | CONFORMS | propertyLabel.test.ts:17-85; unitsRepoDisplays.test.ts:164-220; extractionJob.test.ts:2085, :2105, :2146, :2158, :2225; extractionSentPropertiesBlock.test.ts:42-216; extractionRunWindow.test.ts:334; extractionNoteLines.test.ts:53 | |
| D6: boolean rejects strings, legacy off, New / Edit round trip, row and pill, 36 rows DOM order, never flyer | CONFORMS | unitFields.test.ts:854, :863; ListingEditForm.test.tsx:928, :939; UnitCreateForm.test.tsx:1096; ListingDetail.test.tsx:3348; propertyFormFlyerParity.test.ts:178 | |
| D7: stub driver + stub grader: excluded line fails, feedback control without its label fails, field reported only, ungraded vs 2 of 3, grader prompt pinned, missing control fails, truncation fails, default-suite regression fails, `--model` required, exit codes | CONFORMS | extractionPromptProbe.test.ts:791, :834, :816, :848, :865, :828, :842, :973, :155, :731; extractionProbeNeverWritten.test.ts:166 | WI16 greps clean |
| e2e: staff edit and see the four; tick writes empty text field, conflict -> chip, floor keep / skip, feedback line in the Preferences & notes card; Priority round trip and display; string-noteLines payloads migrated | CONFORMS | e2e/tests/dashboard-next/tenant-matching-inputs.spec.ts:47; e2e/tests/flows/conversation-fact-extraction.spec.ts:538, :561, :619, :647; e2e/tests/dashboard-next/property-priority.spec.ts:114; caseworkers.spec.ts:517; conversation-fact-extraction.spec.ts:343, :388 | ai-run-log.spec.ts:182 is `[]` (nothing to migrate); 383 passed per the brief |

### Spec section 6 - rollout

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| No infrastructure change | CONFORMS | no diff under infra/ or tables.ts | |
| No env var required; EXTRACTION_FACT_MIN_CONFIDENCE=0.7 uncommented in the three templates (+ the four extraction defaults uncommented, as ruled PR22) and RUNBOOK | CONFORMS | config.ts:536 (blank = 0.7); .env.example:192-200; .env.dev.example:232; .env.prod.example:257; RUNBOOK.md:1469 | |
| After deploy no switch | CONFORMS | no flag gates the new behavior | |

### Plan watch items WI1-WI16

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| WI1 fake driver bypass skips no value rule | CONFORMS | apply.ts:283-309 takes `unknown[]`; extractionFake.ts:13-32 | extractionNoteLines.test.ts:48; extractionApply legacy-string case |
| WI2 transcript render and per-message hash byte-unchanged, pinned | CONFORMS | extractionRunWindow.test.ts:328-349 | literal hashes 8804bb247bad2f59 / f0196a44d5ac9368 |
| WI3 hard-coded counts | CONFORMS | as D3 row | |
| WI4 noteLines shape reaches every fixture | CONFORMS | WL-13 grep prints exactly the 4 intended extractionApply.test.ts lines | |
| WI5 guard before cap | CONFORMS | apply.ts:286-287, :300, :305 (guard) before :307 (cap) | extractionNoteLines.test.ts:69 |
| WI6 hasAiCaseworkerNote silenced by dropped / demoted line | CONFORMS | caseworkers / possibleCaseworkers tests unchanged and green | |
| WI7 lean byte-stable | CONFORMS | lean.ts no diff | seedTenantMatchingInputs.test.ts |
| WI8 existing getDisplaysByIds callers unchanged | CONFORMS | tours.ts:551 | unitsRepoDisplays.test.ts:207 |
| WI9 required deps at every site | CONFORMS | worker.ts:471-473; dev.ts:748-749; harnesses | |
| WI10 no listing_sends write | CONFORMS | extractionJob.test.ts:2225 (proxy throws on any other member) | |
| WI11 no new label contains an existing one | CONFORMS | tenantMatchingInputs.test.ts:101 | no non-exact e2e `getByLabel` hits a new label |
| WI12 Priority never on flyer; legacy off; three tables at 36 | CONFORMS | as D6 rows | |
| WI13 runTypes cycle-free | CONFORMS | runTypes.ts:6 only import | |
| WI14 importer untouched | CONFORMS | lib/import no diff | |
| WI15 prompt fingerprint changes; message hash does not | CONFORMS | throwaway fingerprint; WI2 pin | |
| WI16 no test / script reaches network or reads the key outside the probe path | CONFORMS | `git grep ANTHROPIC_API_KEY` app/test only injected env; SDK imported only at adapters/extraction.ts:20 | |

### Plan rulings PR1-PR58 (spot-checked, each landed as ruled)

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| PR1 gate run is Cameron's | CONFORMS | no never-written-test.md; probe only stub-tested | |
| PR3 / PR25 seed: persona 4 gains the four; no seeded priority | CONFORMS | cast.ts:454-460; seedPriority.test.ts | |
| PR4 / PR15 / PR35 one rule place; floor via ApplyDeps and the production parser | CONFORMS | apply.ts:283; probe :317-319 | |
| PR5 / PR45 label leaf + exported street pattern; flattening | CONFORMS | propertyLabel.ts:48-105 | |
| PR6 / PR39 data module; unverified price rows marked | CONFORMS | extractionProbeNeverWritten.ts:431-439 | |
| PR7 / PR8 / PR23 / PR24 public types additive; list API | CONFORMS | tenantMatchingInputs.ts:17-85 | |
| PR9 / PR11 order; notesDemoted after floor, postal, guard, cap | CONFORMS | apply.ts:283-309 | |
| PR10 / PR34 / PR42 / PR46 "Notes lines" region and its guards | CONFORMS | AiRunDetail.tsx:71-86 | |
| PR12 "Field already filled" | CONFORMS | dashboard/src/api/types.ts:321 | |
| PR13 / PR27 coerceAccept uses coerceField; bare-integer portion suggestion | CONFORMS | suggestionResolution.ts:172-175; apply.ts suggest `String(value)` | |
| PR16 rethrow raw / IncompleteBatchReadError | CONFORMS | unitsRepo.ts:1317, :1323-1325 | |
| PR18 / PR19 / PR20 soft-deleted listed; dates; names; default suite sends `none` | CONFORMS | sentPropertiesBlock.ts:114; probe :1391, :1511 | |
| PR21 / PR22 --baseline, 2-of-3, appended record, branch truncation; env defaults uncommented | CONFORMS | probe :1264-1310, :1348-1353 | |
| PR26 / PR28 number input step="any", no min / max; off stored false | CONFORMS | ContactEditForm.tsx:943-945; ListingEditForm.tsx:193 | PR26 leaves the unparseable case open - CONF-1 |
| PR30 / PR33 / PR36 / PR37 probe seams; fake comment `<field key>`; "passes 12" fixed; RUNBOOK blank = 0.7 | CONFORMS | probe :264-310; extractionFake.ts:23, :27; suggestionResolution.ts:48-49; RUNBOOK.md:1469 | |
| PR47 run detail opened as founder | CONFORMS | conversation-fact-extraction.spec.ts:671-673 | |
| PR50 / PR57 no-address bullet deleted and pinned | CONFORMS | prompt.ts (bullet absent) | |
| PR51 model grader + decisions 9-13 | CONFORMS | probe :749-990 | |
| PR52 / PR55 / PR56 dry-run prints; "Lines the grader did not judge"; two probe-script createStructuredOutputClient lines | CONFORMS | probe :1405-1406, :1457-1458, :1523-1524; :1130-1148; :22, :1370 | |
| PR54 grader NOT EXCLUDED defaults | CONFORMS | extractionProbeNeverWritten.ts:87-96 | |
| PR58 sex covers orientation and gender identity | CONFORMS | prompt.ts:145-146; data :66, :290-292 | |

### Worklist WL-1..WL-42 (items that change what is built)

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| WL-1..WL-3 prose rows, prop comment, mirror header | CONFORMS | Card.module.css:120-126; Card.tsx:506; EligibilityIntakeCard.tsx:38, :94, :152; mirror :12-14 | |
| WL-4 / WL-5 three 36-row tables; pill contrast token | CONFORMS | requirements.test.ts:243, :601-602, :624-625; ListingDetail.module.css:77-88 | `--c-pill-unknown-bg` #b45309 (tokens.css:100) |
| WL-7..WL-11 provenance pin, counts, selectors order, accept refusal, race filed | CONFORMS | extractionSchema.test.ts:96-97; selectors.md:82; suggestions.test.ts:595; docs/issues/extraction-text-field-write-races-staff-fill.md | |
| WL-12..WL-17 non-number confidence fixture, WI4 grep, NEVER bullet ends "This is the never-written list.", withheld row copy, escape check, edit-form notes race filed | CONFORMS | extractionNoteLines.test.ts:27; prompt.ts:152; AiRunDetail.tsx:81; aiRunsRepo.ts SORT_KEY_CEILING intact; docs/issues/contact-edit-form-notes-save-drops-auto-lines.md | |
| WL-18..WL-24 appendedLines, field placement, renamed case, WI10 grep | CONFORMS | apply.ts:66-74, :924, :935-939 | |
| WL-25..WL-34 dry-run loop, `--out` refusal, record reason line, RUNBOOK budget + WARN lines, fake header, placeholders gone, PARTIAL wording, RUNBOOK :614 / :1635 | CONFORMS | probe :1403, :1298, :1092-1094; extractionPromptProbe.test.ts:839; RUNBOOK.md:1481-1487 | |
| WL-35..WL-41 e2e sentinel, flyer checks, BLANK, file-local helpers, test.slow, selectors rows | CONFORMS | conversation-fact-extraction.spec.ts:561-617; property-priority.spec.ts:114-176; selectors.md:59-60, :83, :144 | selectors.md:60 overclaims for unparseable values (CONF-1) |
| WL-42 self-qa.md and gate-run-commands.md committed as produced | MISSING | not at 67d877cc | orchestrator-owned S7.5 / S7.6, after review - CONF-2 (INFO) |

### Product copy, scope creep, report claims

| item | verdict | evidence (file:line) | note |
|---|---|---|---|
| Labels and chip nouns exact (spec D1) | CONFORMS | tenantMatchingInputs.ts:40-71 | |
| Error copy exact (spec D2) | CONFORMS | tenantMatchingInputs.ts:94-104 (+ mirror :62-68, drift-pinned) | "<Label> must be a string." is server-only new copy (spec silent) |
| Pill "Priority", row Yes / No | CONFORMS | ListingDetail.tsx:890, :1006 | |
| Run detail: "Notes lines", "<n> appended", "<n> below the confidence floor", "<n> withheld by the unknown-speaker rule" (WL-15), "Feedback lines: <n>", "Unlabeled address lines: <n>", "Properties sent fingerprint: <hex>"; drop label "Field already filled" | CONFORMS | AiRunDetail.tsx:78-84; types.ts:321 | strings as the plan's S4.5 / S5.8 text |
| Portion format `$1,200 / month` | CONFORMS | mirror tenantMatchingInputs.ts:84 | |
| American English and ASCII in user-facing strings | CONFORMS | tr check 0 | three COMMENTS use British spelling - CONF-7 (INFO) |
| Scope creep | CONFORMS | - | nothing material; small extras listed in CONF-7 (INFO) |
| Slice-report claims vs code | CONFORMS | spot-checked S1 C2-C5, S2 C1-C4 + WL-5 token, S3 C1-C6 + WI13, S4 C1-C6 + WI5, S5 C1-C9 + WI2 / WI8 / WI9 / WI10, S6 seams + fingerprints, S7 selectors | no report claim found false; selectors.md:60 (a doc, not a report) overclaims - CONF-1 |

## CONF-1 - LOW - An unparseable portion entry reads as a clear: the edit form silently removes a stored portion (or saves nothing) instead of the bad-portion message

- What the spec says. D2, Dashboard: the portion is "a number input, whole
  dollars, `$` beside it. Values are trimmed before diffing; a cleared control
  sends `null`. The client-side message for a bad portion matches the
  server's." PR26 chose `step="any"` and no native min / max "so staff see the
  server's exact message, not the browser's".
- What the tree does. The control is `<input type="number" step="any">`
  whose onChange stores `e.target.value` verbatim
  (dashboard/src/routes/contact/ContactEditForm.tsx:941-949). An entry a
  number input cannot parse as a floating-point number has value `""` under
  the HTML value-sanitization rule (validity.badInput), so the form's state
  becomes `''`. `buildTenantMatchingPatch` then reads `''` as a CLEAR
  (dashboard/src/routes/contact/tenantMatchingInputs.ts:118-123): with a
  stored portion it sends `max_tenant_portion: null` (the server REMOVEs the
  stored value); with none stored it sends nothing. No `role="alert"`, no
  copy. e2e/support/selectors.md:60 states "a bad value is refused in the
  form's role=alert with the server's copy", which holds only for parseable
  values (12.5, 20001, -5 - ContactEditForm.test.tsx:2188; e2e
  tenant-matching-inputs.spec.ts:108).
- Proof. Throwaway jsdom test (deleted): ContactEditForm on a tenant with
  `max_tenant_portion: 900`, `fireEvent.change(portion, { target: { value:
  '1,200' } })` -> input value `""`, Save -> `updateContact('k1', {
  max_tenant_portion: null })`, no alert. NOT exercised in a real browser (no
  e2e session allowed), so the browser split below is from the HTML rule and
  known engine behavior, not observed: Chromium is expected to drop a
  thousands comma as it is typed (its number input accepts no group
  separator, so "1,200" would land as 1200), while Firefox accepts arbitrary
  typed text and reports value `""` for it; any engine reports `""` for other
  unparseable entries (for example `1e`, `1.2.3`). Severity LOW for that
  reason: data loss on a plausible entry in some browsers, visible right after
  Save as a BLANK row.
  The same class already exists in the pre-existing Rent min / Rent max /
  Payment standard / Voucher size number inputs (ListingEditForm.tsx:354-430,
  ContactEditForm.tsx:756), so B1 adds an instance rather than inventing it.
- Fix. Either (a) render the portion as `type="text" inputMode="numeric"` so
  the raw text reaches `buildTenantMatchingPatch`, which already refuses a
  non-digit value with `tenantMatchingDollarsInvalid` (optionally strip `$`,
  commas and spaces first, as `coerceField` does, so "1,200" saves as 1200);
  or (b) keep `type="number"`, record `e.target.validity.badInput` in its own
  state, and refuse Save with the same copy when it is true. Add a
  ContactEditForm case: stored 900, change to an unparseable value, Save ->
  the alert with the server's copy and `updateContact` not called (option (a)
  is testable in jsdom as is; (b) needs a stubbed `validity`). Correct
  selectors.md:60 to match. File the shared pre-existing class (rent /
  payment standard / voucher size) as a tier-2 issue rather than fixing it in
  B1.

## CONF-2 - INFO - The never-written gate run and the WL-42 records are not at this head (pending by design)

- Spec D7 "Gate: B1 is not handed back merge-ready until a gate run passes on
  the final prompt, or Cameron decides"; PR1 makes the run Cameron's and the
  handback "merge-ready PENDING the never-written gate run". WL-42 makes the
  orchestrator commit self-qa.md (S7.5) and gate-run-commands.md (S7.6) as
  produced.
- Tree: no `never-written-test.md`, no `self-qa.md`, no
  `gate-run-commands.md` under
  docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/ at 67d877cc.
- Not a defect at this point of the pipeline. For the sheet: both gate
  commands append to the same `--out` (plan :15568-15569); the prompt
  fingerprints at this head are extraction `436f91b01983` and grader
  `5887c5904d61` - a later prompt change needs a new run.
- Fix: produce and commit the two records at S7.5 / S7.6; merge only after
  the record passes with Cameron's sign-off.

## CONF-3 - INFO - RUNBOOK's probe paragraph calls only the never-written suite "the merge gate" and omits the branch-truncation fail rule

- Spec D7: "The probe's existing default suite is ALSO part of the gate";
  PR21: the comparison "also fails on any branch-side truncation".
- RUNBOOK.md:1519-1523 describes `--baseline` without calling it part of the
  gate, lists its fail rule as "2 or more below ... or the total is more than
  2 below" (no truncation clause), then says "`--suite never-written` ... is
  WP1 B1's merge gate". The script header (extraction-prompt-probe.ts:56-60)
  and the code (:635) carry the truncation rule.
- Fix: one sentence in RUNBOOK.md: the merge gate is BOTH commands, and the
  comparison also fails when the branch truncates.

## CONF-4 - INFO - `source` is read by no code, so flipping an entry to `notes` would change nothing

- Spec D1: `source` admits `notes`, "B1 builds no code path for it"; "What a
  later move to notes involves ... edit the entry (and its mirror), and a
  data step".
- Tree: no reader consults `source` (git grep finds only the type at
  tenantMatchingInputs.ts:21 and the entries). Every reader treats every
  entry as a field. This conforms to "no code path", but the spec's list of
  what a later move involves is short by one step: setting an entry's
  `source` to `notes` today would leave it extracted, stored and shown as a
  field.
- Fix: none in B1. Add a line to docs/issues/extraction-fields-to-notes.md:
  the later move must also make the readers filter by `source === 'field'`
  (or remove the entry).

## CONF-5 - INFO - The spec's street-suffix pattern over-counts `unlabeledAddressLines`

- Spec D5.3 defines the pattern (a house number, one to four words, a suffix
  from a list that includes `way` and `place`); propertyLabel.ts:91-105
  implements it exactly.
- Throwaway: `hasStreetAddress` is true for "wants a 3 bedroom place" and
  "works 2 jobs downtown way too much" (and for "liked the 2 story court"),
  false for the spec's "prefers 3 bedrooms". S5's report notes the first.
- Counts only (nothing is dropped), so no behavior risk; B2 should read the
  count as an upper bound. No fix in B1.

## CONF-6 - INFO - `maxLength=500` on the text controls silently truncates a longer paste

- Spec D2 gives the server rule and copy ("<Label> must be 500 characters or
  fewer."); it requires a client message only for the portion.
- Tree: ContactEditForm.tsx:935 and :957 set `maxLength={500}` (planned at
  S1.4). A paste over 500 characters is cut by the browser with no message,
  and the limit counts surrounding spaces (stricter than "after trimming").
  The client's own too-long refusal (mirror tenantMatchingInputs.ts:131-133)
  is unreachable from the form.
- Fix (optional): drop `maxLength` and let the existing refusal show the
  server's copy, or keep it and accept the trade-off.

## CONF-7 - INFO - Small extras and cosmetics

- Extras no item asked for, all harmless: an additional selectors.md row
  "Contact (Eligibility intake)" (selectors.md:60; S7 divergence 7); a
  GLOSSARY "Notes line" entry (GLOSSARY.md:203; spec 4 asks for the four
  nouns, "feedback line" and the card-vs-field note); the portion
  `placeholder="e.g. 400"` and `inputMode="numeric"`
  (ContactEditForm.tsx:944, :948).
- extraction-prompt-probe.ts:454 `withRecorded` names `max_tenant_portion`
  (S6 risk). A script, not a D1 reader, and no default case reaches it; a
  by-kind lookup through the list would remove the name.
- extraction-prompt-probe.ts:1491: on a passing `--case` run the CLI still
  says the gate "needs Cameron's written sign-off" while the record says
  PARTIAL, not a gate run (S6 risk).
- Three new COMMENTS use British spelling (house rule: American English):
  extraction-prompt-probe.ts:172 "recognised", AiRunsSection.test.tsx:324
  "labelled", tenant-matching-inputs.spec.ts:64 "labelled". User-facing copy
  is American English.
- Fix: optional; fold into any follow-up commit.
