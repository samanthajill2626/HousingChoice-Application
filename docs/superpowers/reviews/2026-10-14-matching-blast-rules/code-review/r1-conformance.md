# Code review round 1 - spec conformance (matching-blast-rules, tracker #6)

- Reviewer: spec-conformance, round 1 (read-only on tracked files and git state).
- Reviewed: `feat/matching-blast-rules` @ 53a13055 (the r1 package HEAD); merge base
  a2b3d80d = `main` (`git rev-list --count HEAD..main` = 0; HEAD is not in main).
- Contract: spec revision 6 (`docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md`),
  plan lines 1-681 (section 1.1 copy, section 2 binding interfaces, AR1-AR43), the
  orchestrator worklist OR-rulings, `intent.md`, the mission block work map and watch items.
  Plan slice text was consulted once (plan ~6582, the 422 no-match fallback).
- Evidence: every item traced to the branch tree (`file:line`) and to the test(s) that
  pin it; every section 1.1 string grepped byte-for-byte in code and tests; the
  must-nots checked with `git diff a2b3d80d HEAD`; lint of the S3 files re-measured;
  14 mutants run against the real, unedited test files (section 9).
- Gates (orchestrator, on 53a13055): typecheck 0, npm test 0, smoke 0, e2e 0 (363
  passed), gate 5 = 3 errors, all pre-existing. Re-measured here: `npx eslint` on the 7
  S3 dashboard files = exactly 3 errors (`BroadcastComposer.tsx:394`, `:413`
  react-hooks/set-state-in-effect; `useComposerDraft.ts:151` react-hooks/refs) - OR-S3-7 holds.

## 0. Verdict and counts

The implementation conforms to every spec decision (D1-D10, D3a, D3b), every section 4
consequence that implies behavior, every section 7 "must also update" place, the exact
copy of plan 1.1 (as amended by AR8, AR32, AR37, AR43) and every must-not. Nothing is
BLOCKING, HIGH or MEDIUM.

| Status | Count |
|---|---|
| CONFORMS | 204 |
| PARTIAL | 3 (AR12; OR-S4-4; spec 6 "every page of the other three partitions") |
| MISSING | 3 (work-map lint record; AR38; AR42 - one finding, CONF-1) |
| SUPERSEDED (4) / N/A process-only or after this review (12) | 16 |

| Severity | Findings |
|---|---|
| BLOCKING / HIGH / MEDIUM | 0 |
| LOW | 3 (CONF-1, CONF-2, CONF-3) |
| INFO | 3 (CONF-4, CONF-5, CONF-6) |

Mutation proofs: 11 mutants KILLED by the pinning tests (M1, M3-M7, M10-M14), 2
survivor checks that SURVIVED as predicted (M8 -> CONF-2, M9 -> CONF-3; M9's control
M9c killed), plus 5 identity baselines green.

## 1. Work map and watch items (mission block)

| # | Item | Status | Evidence (branch) |
|---|---|---|---|
| S1.1 | `blastAudienceRules.ts`: holds, checkedByDefault, normalizer, wire shape | CONFORMS | `app/src/lib/blastAudienceRules.ts:15-228` (binding 2.1 signatures exact) |
| S1.2 | `AudienceFilter` list type | CONFORMS | `app/src/repos/broadcastsRepo.ts:88-98` (binding 2.2 verbatim) |
| S1.3 | `toursRepo.listByStatus` createdAtFrom + fakes | CONFORMS | `app/src/repos/toursRepo.ts:225`, `:442-465`; the only fake that implements it: `app/test/helpers/twilioWebhookHarness.ts:3964-3975` |
| S1.4 | resolver: searching then onboarding, authorities in memory | CONFORMS | `app/src/services/audienceResolution.ts:145-218` |
| S1.5 | create list check + legacy body | CONFORMS | `app/src/routes/broadcasts.ts:175-225` (parse), `:908-916` (checkList) |
| S1.6 | `storedFilterRefusal` per member | CONFORMS | `broadcasts.ts:656-679` |
| S1.7 | wire projections | CONFORMS | `broadcasts.ts:449` (results), `:478` (list), `:982` (201 echo) |
| S2.1 | `readOpenTourHolds` / `readAudienceRules` / `buildReviewRows` | CONFORMS | `broadcasts.ts:692-701`, `:710-719`, `:743-830` |
| S2.2 | preview fields + `tourHolds` + 503 + seeds-only degrade | CONFORMS | `broadcasts.ts:1031-1048`, `:1084-1087`, `:1117-1120` |
| S2.3 | estimate = default-checked count | CONFORMS | `broadcasts.ts:930-947`, `:958`, `:977` |
| S2.4 | send path (c) exclusions | CONFORMS | `broadcasts.ts:1274-1330` |
| S2.5 | matrix seed: one legacy, one list | CONFORMS | `app/src/lib/seed/matrix.ts:1224-1231` (legacy), `:1260-1268` (list) |
| S2.6 | comments: GSI kept, never deleted | CONFORMS | `contactsRepo.ts:770-779`, `:1401-1402`; `contacts.ts:650-653`; `dev.ts:1263-1265`; `import/apply.ts:1208-1211`; `lean.ts:109` |
| S3.1 | types / endpoints / `audienceSummary` | CONFORMS | `dashboard/src/api/types.ts:3271-3280`, `:3491-3520`, `:3544-3551`; `endpoints.ts:2001`; `broadcastFormat.ts:62-69` |
| S3.2 | `tourHoldLabel` + `RecipientPreview` | CONFORMS | `tourHoldLabel.ts:8-28`; `RecipientPreview.tsx:112-119`, `:141`, `:164-173`, `:266-268`, `:326`, `:355`, `:470-477`, `:531-535`, `:568`, `:626`, `:699` |
| S3.3 | `AudienceFilters` multi picker + caption | CONFORMS | `AudienceFilters.tsx:37-46`, `:193-222`, `:241-259` |
| S3.4 | `prefillAuthorities` | CONFORMS | `authorityPrefill.ts:14-32` |
| S3.5a | composer prefill, ownership, property change, settle gate | CONFORMS | `BroadcastComposer.tsx:185-232`, `:484-491` |
| S3.5b | no draft until settled (AR23, AR35) | CONFORMS | `BroadcastComposer.tsx:306`; `useComposerDraft.ts:176`, `:277`, `:285` |
| S3.5c | 422 one member + late refusal (AR39) | CONFORMS (INFO CONF-4, CONF-5) | `BroadcastComposer.tsx:256-268`, `:533-538`, `:739-741` |
| S3.5d | 503 Try again (AR39) | CONFORMS | `BroadcastComposer.tsx:539-543`, `:591-597`, `:786-798` |
| S3.5e | Change property stays enabled during a preview (AR33) | CONFORMS | `BroadcastComposer.tsx:755-762` (no `disabled`); pinned test unchanged at `BroadcastComposer.test.tsx:1326-1349` |
| S3.6 | Available-only picker; loading / failed / aborted (AR37, AR41) | CONFORMS | `BroadcastComposer.tsx:163`, `:340-357`, `:672-678` |
| S4.1 | repair the Matching specs incl. AR22 draft-delete | CONFORMS | `broadcasts.spec.ts:133`, `:276`, `:452-468`; `a2p-compliance.spec.ts:352-369`, `:495-556`; `org-lists.spec.ts:344-401`, `:489-534`; `review-recipients-heard-from.spec.ts:147-153`; `matching-entry-points.spec.ts:289-291`, `:326` |
| S4.2 | new e2e spec | CONFORMS | `e2e/tests/dashboard-next/matching-blast-rules.spec.ts:167-327` |
| S4.3 | GLOSSARY / RUNBOOK / resolve the truncation issue | CONFORMS | `GLOSSARY.md:125-142`, `:340-344`; `RUNBOOK.md:1455-1459`; truncation issue `:6`, `:9`, `:86-102` |
| S4.4 | main sync first, then the five gates once (AR28) | CONFORMS | main has not moved (HEAD..main = 0); gates ran on 53a13055 |
| S4.5 | lint count recorded in the lint-backlog issue only (AR38, AR42) | MISSING | CONF-1 |
| S4.6 | AGENTS.md untouched | CONFORMS | `git diff a2b3d80d HEAD -- AGENTS.md` empty |
| S4.7 | handback | N/A | Task 4.5, after this review |
| W1 | re-anchor on quoted text; never revert an earlier slice (AR21) | CONFORMS | S1's header text intact, S2 inserted only (`broadcasts.ts:14-39`) |
| W2 | `broadcasts.ts` edited by S1 then S2 (AR9 split) | CONFORMS | `broadcasts.ts:6-8` (S2 endpoint lines), `:19-24` (S2 insert), `:26-39` (S1) |
| W3 | KEEP the byHousingAuthority GSI and `listByHousingAuthority` | CONFORMS | section 7 below |
| W4 | gate-5 baseline: add NONE, S3 removes 2 | CONFORMS | 3 errors re-measured (header) |
| W6 | e2e tenants: explicit status, consent, run-unique authority; a2p no-consent exception | CONFORMS | rows S4.1, S4.2 |
| W7 | a2p path (c) still `skipped_no_consent === 1` | CONFORMS | `a2p-compliance.spec.ts:545-556` |
| W10 | lean Tasha (`placing`) out of filter blasts | CONFORMS | `broadcasts.spec.ts:140-145` (own already-sent tenant replaces her) |

## 2. Spec decisions (D1-D10, D3a, D3b) and section 4 consequences

| Decision | Status | Code | Pinning tests |
|---|---|---|---|
| D1 read only `searching` then `onboarding` partitions under one bound; GSI branch removed; fences unchanged; status-excluded not listed; hand picks any status | CONFORMS | `audienceResolution.ts:153-218`; `blastAudienceRules.ts:19` | `audienceResolution.test.ts:147-257`; `broadcastApi.test.ts:251` |
| D2 `housing_authorities` any-of; empty = no filter; non-empty leaves out missing / non-member | CONFORMS | `audienceResolution.ts:147`, `:187-195` | `audienceResolution.test.ts:269-308` |
| D2 POST: array <= 100 strings else 400; `checkList`; first failing member 422; stored list only | CONFORMS | `broadcasts.ts:184-209`, `:908-916` | `broadcastApi.test.ts:2451-2570` |
| D2 legacy body (string = one-member list); both keys 400; AR3 edges | CONFORMS | `broadcasts.ts:188-206` | `broadcastApi.test.ts:2471`, `:2487`, `:2632` |
| D2 legacy storage: ONE normalizer; responses carry `housing_authorities`, never `housing_authority` | CONFORMS | `blastAudienceRules.ts:186-228`; `broadcasts.ts:449`, `:478`, `:982` | `blastAudienceRules.test.ts:74-151`; `broadcastApi.test.ts:2754`, `:2775` |
| D2 `storedFilterRefusal` checks every member in order | CONFORMS | `broadcasts.ts:656-679` | `broadcastApi.test.ts:2687`, `:2705`, `:2715` |
| D3 composer reads the org list; prefill = `authoritiesOf(unit)` mapped by exact name / unique spelling, property order, de-duplicated; "Not used" note; not-limited line; multi picker "Housing authorities" | CONFORMS | `BroadcastComposer.tsx:155`, `:193-199`; `authorityPrefill.ts:14-32`; `AudienceFilters.tsx:193-217` | `authorityPrefill.test.ts:30-77`; `BroadcastComposer.test.tsx:840`, `:856`; `AudienceFilters.test.tsx:147`, `:267-292` |
| D3 the prefill belongs to the property: edits never overwritten; a DIFFERENT property empties both filters at once then prefills, no confirm; same property changes nothing; value + ownership in one functional update | CONFORMS | `BroadcastComposer.tsx:88-95`, `:204-220`, `:271-286`, `:484-491` | `BroadcastComposer.test.tsx:868`, `:887` |
| D3 timing: Preview waits only with a property and filters on; failed loads settle with notices; aborted load neither; resumed draft / seeds-only never gated | CONFORMS | `BroadcastComposer.tsx:228-232`, `:363-379`, `:561-568` | `BroadcastComposer.test.tsx:938`, `:962`, `:976`, `:991`, `:1004`, `:1012` |
| D3a voucher size keeps "first accepted size", same ownership rule | CONFORMS | `BroadcastComposer.tsx:200`, `:208` | `BroadcastComposer.test.tsx:868`, `:887` |
| D3b a 422 removes THAT member only, with the new copy | CONFORMS (INFO CONF-4) | `BroadcastComposer.tsx:62-67`, `:256-268` | `BroadcastComposer.test.tsx:716`, `:750` |
| D4 hold table, boundaries, kind order + tie-breaks, keyed on `tenantId` any type | CONFORMS | `blastAudienceRules.ts:91-164` | `blastAudienceRules.test.ts:153-403`; `broadcastApi.test.ts:3170`, `:3324` |
| D4 held tenant listed unchecked with label; hand pick never held (checked, labeled) | CONFORMS | `broadcasts.ts:797-820` | `broadcastApi.test.ts:3240`; `RecipientPreview.test.tsx:1015`, `:1079` |
| D5 ONE server function; `checkedByDefault` rule; dashboard trusts it; hand-pick case | CONFORMS | `broadcasts.ts:743-830`; `RecipientPreview.tsx:141`, `:266-268`, `:326`, `:355` | `blastAudienceRules.test.ts:405-438`; `broadcastApi.test.ts:3240`; `RecipientPreview.test.tsx:1001`, `:1091`, `:1117`, `:325` |
| D5 open-tours read: 4 partitions, `requested` bounded by `createdAt >= now - 14d` | CONFORMS (pinning PARTIAL, CONF-3) | `broadcasts.ts:692-701`; `toursRepo.ts:442-465` | `broadcastApi.test.ts:3303`; `toursRepoListByStatusRange.test.ts:43-101`; `toursRepo.integration.test.ts:446` |
| D5 fail closed for filter drafts (503); seeds-only served without labels + `audienceRulesUnavailable`; `declineLabelsUnavailable` removed | CONFORMS | `broadcasts.ts:781-792`, `:1043-1048`, `:1120` | `broadcastApi.test.ts:3073-3087`, `:3378`, `:3389`, `:3399`, `:3432` |
| D6 (a) and (b) unchanged | CONFORMS | `broadcasts.ts:1192-1256` | `broadcastApi.test.ts:3796`, `:3810` |
| D6 (c) resolved minus held minus declined; already-sent and no-consent kept; seeds out; 503; truncation refused; cap on the final count; empty 400 | CONFORMS | `broadcasts.ts:1274-1330` | `broadcastApi.test.ts:3687-3794`, `:726-735` |
| D7 wire fields; tour tag after Not interested, amber; label copy; accessible names; Add a tenant note; existing flagged note kept; 503 copy + Try again; truncation copy (client + server) | CONFORMS | `broadcasts.ts:1084-1120`, `:1318`; `RecipientPreview.tsx:112-119`, `:470-477`, `:494`, `:568`, `:626`, `:699`; `BroadcastComposer.tsx:76-77`, `:786-798` | `tourHoldLabel.test.ts:8-33`; `RecipientPreview.test.tsx:1040`, `:1091`, `:1153`; `BroadcastComposer.test.tsx:1022`; `broadcastApi.test.ts:731` |
| D8 caption (second sentence only with a non-empty list) | CONFORMS | `AudienceFilters.tsx:37-40`, `:241-245` | `AudienceFilters.test.tsx:320`, `:326`; e2e `matching-blast-rules.spec.ts:249` |
| D8 reach = count of `checkedByDefault` rows; seeds-only makes no rules reads; a thrown read omits `estimatedCount`, `stats.audience` 0; ALONE comments updated; counts past the 1000 preview bound | CONFORMS | `broadcasts.ts:130-135`, `:736-741`, `:930-947`, `:1416-1420`; `broadcastsRepo.ts:730` | `broadcastApi.test.ts:3503`, `:3535`, `:3553`, `:3571`, `:3582`, `:3598`, `:3616`; `BroadcastComposer.test.tsx:1069` |
| D9 Available-only on bare and `?contactId=` entries; empty state; `?unitId=` keeps any status | CONFORMS | `BroadcastComposer.tsx:340-357`, `:672-678`, `:511-518` | `BroadcastComposer.test.tsx:1417`, `:1430`, `:1438`, `:1448` |
| D10 caseworkers never filter-resolved; seed or checked row only | CONFORMS | `audienceResolution.ts:174`; `broadcasts.ts:414-416` | `audienceResolution.test.ts:312`, `:328`; `broadcastApi.test.ts:2936`, `:3240` |
| S4-C1 Needs review / Placing / Placed / On hold / Inactive out of filtered blasts | CONFORMS | D1 | as D1 |
| S4-C2 no-authority tenants left out while a list is set; caption says so | CONFORMS | D2, D8 | as D2, D8 |
| S4-C3 reach matches the default-checked rows | CONFORMS | D8 | as D8 |
| S4-C4 Available-only on tenant / caseworker page sends | CONFORMS | D9 | `BroadcastComposer.test.tsx:1430` |
| S4-C5 truncation issue resolved with the status-order note | CONFORMS | `docs/issues/broadcast-audience-truncation-drops-searching-tenants.md:6`, `:9`, `:86-102` | - |
| S4-C6 GSI stays; only "broadcast key" comments corrected; no removal issue | CONFORMS | section 7 | - |
| S4-C7 failed reads block a filter preview (Try again); direct send shows a notice | CONFORMS | D5, D7 | as D5, D7 |
| S4-C8 accepted exposures (needs_placement holds; a tour on a deleted property holds until the close; no special-casing) | CONFORMS | `blastAudienceRules.ts:91-114` (no unit or tenant-status read in the hold) | `broadcastApi.test.ts:3170` |
| S4-C9 direct send to a tenant with a tour: label shown, row checked | CONFORMS | `broadcasts.ts:797-820` | `broadcastApi.test.ts:3399`; `RecipientPreview.test.tsx:1079` |
| S4-C10 property change replaces edited filters, no confirm | CONFORMS | `BroadcastComposer.tsx:484-491` | `BroadcastComposer.test.tsx:887` |
| S4-C11 throttled already-sent read can leave a tenant checked (kept) | CONFORMS | `broadcasts.ts:793-796` (`priorRecipientKeys` unchanged, never throws) | - |

## 3. Section 7 - places the build must also update

| Place | Status | Evidence |
|---|---|---|
| `broadcastsRepo.ts:84-90` type | CONFORMS | `broadcastsRepo.ts:88-98` |
| `parseAudienceFilter`, POST create list check + estimate | CONFORMS | `broadcasts.ts:175-225`, `:908-947` |
| review-rows function, `storedFilterRefusal`, preview, send (c) | CONFORMS | `broadcasts.ts:656-830`, `:1003-1122`, `:1257-1331` |
| results (`:393`) and list (`:421`) projections | CONFORMS | `broadcasts.ts:449`, `:478` |
| router header comment | CONFORMS | `broadcasts.ts:6-39` |
| `audience_too_large` messages | CONFORMS | `broadcasts.ts:1317-1319` |
| ALONE comments (`:111-114`, `:757-760`, `:1108-1111`) | CONFORMS | `broadcasts.ts:130-135`, `:736-741`, `:1416-1420` |
| `audienceResolution.ts`: read, header, truncation TODO gone, log field | CONFORMS | `audienceResolution.ts:1-38`, `:145-245` (`authorities: authorities.size` at `:232`) |
| `toursRepo.ts` open-tours read option | CONFORMS | `toursRepo.ts:215-225`, `:442-465` |
| harness fake models the `requested` range | CONFORMS | `twilioWebhookHarness.ts:3964-3975` |
| searching-first order tested on `contactsPartitionFake.ts` | CONFORMS | `audienceResolution.test.ts:20`, `:157-232` |
| seeds `matrix.ts` (one legacy, one list) | CONFORMS | `matrix.ts:1224-1231`, `:1260-1268`; `seedOrgNames.test.ts:148-160` |
| byHousingAuthority comments (`contacts.ts:650`, `dev.ts:1263`, `apply.ts:1208`, `lean.ts:109`, `contactsRepo.ts:770-775`) + AR10 `contactsRepo.ts:1396-1397` | CONFORMS | comment-only diffs; no code line changed in `contactsRepo.ts` |
| dashboard `types.ts` (AudienceFilter, PreviewCandidate, PreviewResponse, comments `:2273`, `:3271`) | CONFORMS | `types.ts:2273-2275`, `:3267-3280`, `:3491-3520`, `:3544-3551` |
| `endpoints.ts` createBroadcast | CONFORMS | `endpoints.ts:1984`, `:1997-2011` |
| `useComposerDraft.ts` (key, create body, 422, reach) | CONFORMS | `useComposerDraft.ts:98-111`, `:213-219`, `:241-256`, `:285` |
| `AudienceFilters.tsx` (multi picker, caption, org list as prop, suffix, comment `:102-105`) | CONFORMS | `AudienceFilters.tsx:52-55`, `:147-151`, `:193-259` |
| `BroadcastComposer.tsx` (prefill + settling, picker list, 422, 503) | CONFORMS | section 2 rows D3, D9, D7 |
| `RecipientPreview.tsx` (row model, tags, names, Add a tenant, notices, hand-pick case) | CONFORMS | section 1 row S3.2 |
| `broadcastFormat.ts` `audienceSummary` | CONFORMS | `broadcastFormat.ts:62-69` |
| readers of `stats.audience` (no code change; tests agree) | CONFORMS | `BroadcastsList.tsx`, `BroadcastResults.tsx`, `StatChips.tsx` unchanged |
| app tests: `audienceResolution.test.ts`, `broadcastApi.test.ts` (incl. the `:62-64` comment), `seedOrgNames.test.ts` | CONFORMS | `audienceResolution.test.ts:25-35`; `broadcastApi.test.ts:61-68`; `seedOrgNames.test.ts:86-96`, `:148-160` |
| dashboard tests: AudienceFilters, BroadcastComposer, prefill (already mocks `getOrgList`), RecipientPreview (`:315-360` kept, now `:325`), broadcastFormat | CONFORMS | diffs reviewed; `BroadcastComposer.prefill.test.tsx:13`, `:59` |
| e2e: broadcasts test 1 + non-Available warn; review-recipients; a2p 8.3 test 1 + path (c) legacy; org-lists; matching-entry-points labels | CONFORMS | section 1 row S4.1 |
| `e2e/support/selectors.md:132-134`, `:147` | CONFORMS | `selectors.md:132`, `:133`, `:134`, `:147`, `:148` |
| docs: GLOSSARY (Matching entry + `:322` line), `RUNBOOK.md:1457`, registry (truncation issue resolved; no GSI issue) | CONFORMS | section 1 row S4.3; no new GSI issue under `docs/issues/` |

## 4. Rulings AR1-AR43

| Ruling | Status | Evidence |
|---|---|---|
| AR1 dependencies | N/A (process) | - |
| AR2 DynamoDB Local start, never restart | N/A (process) | - |
| AR3 parse edges (null = absent; legacy 400 kept; both-keys first; cap counts the raw array) | CONFORMS | `broadcasts.ts:184-206`; `broadcastApi.test.ts:2500`, `:2632` |
| AR4 resolver status belt | CONFORMS | `audienceResolution.ts:177`; `audienceResolution.test.ts:328` |
| AR5 mid-build `audienceSummary` gap | CONFORMS (closed by 3.1) | `broadcastFormat.ts:62-69` |
| AR6 error carries `truncated` | CONFORMS | `broadcasts.ts:497-504`, `:944-947`; `broadcastApi.test.ts:3582` |
| AR7 `readAudienceRules` shared by rows and path (c) | CONFORMS | `broadcasts.ts:710-719`, `:782`, `:1285` |
| AR8 over-cap message | CONFORMS | `broadcasts.ts:1319`; `broadcastApi.test.ts:3789` |
| AR9 router header split | CONFORMS | `broadcasts.ts:6-39` |
| AR10 `contactsRepo.ts:1396-1397` comment; dev / lean notes | CONFORMS | `contactsRepo.ts:1401-1402`; `dev.ts:1263-1265`; `lean.ts:109` |
| AR11 TDD exceptions (4.2 RED by mutation) | N/A (process; recorded in `build/S4-report.md:72`, `:108`) | - |
| AR12 503 scope: any non-seeds_only preview; path (c) reads rules even for empty / truncated | PARTIAL | code conforms (`broadcasts.ts:781-792`, `:1280-1298`); precedence unpinned (M8 survived) - CONF-2 |
| AR13 prefill empty while the list is unknown | CONFORMS | `authorityPrefill.ts:18`; `authorityPrefill.test.ts:63` |
| AR14 not-limited line only when none mapped AND the list is empty | CONFORMS | `AudienceFilters.tsx:215`; `BroadcastComposer.tsx:745`; `AudienceFilters.test.tsx:278`, `:287` |
| AR15 transitional types removed; final = 2.7 | CONFORMS | no `declineLabelsUnavailable` / `housing_authority` filter field left in `dashboard/src` |
| AR16 org list as a prop; prefill derived in render; edits keyed to the property; load keyed by id; abort neither; no new lint error | CONFORMS | `BroadcastComposer.tsx:81`, `:88-95`, `:185-220`, `:363-379`, `:737` |
| AR17 e2e outer timeout | N/A (process) | - |
| AR18 sync order | N/A (process; main unmoved) | - |
| AR19 lint count placement | SUPERSEDED (AR27, AR38) | - |
| AR20 422 `text` trimmed; dashboard matches trimmed | CONFORMS | `orgNames.ts` `checkScalarWrite` (trimmed text); `BroadcastComposer.tsx:262` |
| AR21 slice anchors | N/A (process) | - |
| AR22 draft-delete e2e reads the LAST create | CONFORMS | `broadcasts.spec.ts:452-468` |
| AR23 no draft while the prefill is unsettled | CONFORMS | `BroadcastComposer.tsx:306`; `useComposerDraft.ts:176`; `BroadcastComposer.test.tsx:938` |
| AR24 picker empty state only after load (refined by AR37, AR41) | CONFORMS | `BroadcastComposer.tsx:672-678`; `BroadcastComposer.test.tsx:1438` |
| AR25 503 alert cleared by any change (mechanism per AR39) | CONFORMS | `BroadcastComposer.tsx:591-597`; `BroadcastComposer.test.tsx:1080` |
| AR26 Change disabled during preview | SUPERSEDED (AR33) | - |
| AR27 lint count step placement | SUPERSEDED (AR38) | - |
| AR28 sync before gates | CONFORMS | HEAD..main = 0; gates on 53a13055 |
| AR29 DynamoDB start | N/A (process) | - |
| AR30 S2 shell | N/A (process) | - |
| AR31 Task 4.1 grep | N/A (process; `build/S4-report.md:54`, `:111`) | - |
| AR32 truncation message | CONFORMS | `broadcasts.ts:1318`; `broadcastApi.test.ts:731` |
| AR33 Change stays enabled; late result discarded | CONFORMS | `BroadcastComposer.tsx:755-762`; `BroadcastComposer.test.tsx:1326` (unchanged) |
| AR34 the two rewritten gate tests | CONFORMS | `BroadcastComposer.test.tsx:938`, `:991` |
| AR35 `hold` in the hook; derived `reachPending` | CONFORMS | `useComposerDraft.ts:57`, `:176`, `:277`, `:285` |
| AR36 `rulesUnavailableFor` | SUPERSEDED (AR39) | - |
| AR37 picker read states and copy | CONFORMS | `BroadcastComposer.tsx:163`, `:344-355`, `:672-678` |
| AR38 lint record in the issue file only | MISSING | CONF-1 |
| AR39 refusal as data; 422 functional update keyed by property; notice keyed by property; no effect, no render-time ref | CONFORMS (INFO CONF-4, CONF-5) | `BroadcastComposer.tsx:105-118`, `:243`, `:256-268`, `:527`, `:533-543`, `:591-597`, `:739-741`; `BroadcastComposer.test.tsx:778` |
| AR40 AR34 fixture | CONFORMS | `BroadcastComposer.test.tsx:938-960` |
| AR41 aborted units read is neither | CONFORMS | `BroadcastComposer.tsx:353`; `BroadcastComposer.test.tsx:1470`, `:1481`, `:1489` |
| AR42 lint record convention (frontmatter title, `updated:`) | MISSING | CONF-1 |
| AR43 requested label "Tour requested <d>, no date yet"; cue lower case; nothing else changed | CONFORMS | `tourHoldLabel.ts:23`; `tourHoldLabel.test.ts:20-22`, `:31`; `RecipientPreview.test.tsx:1104-1110`; e2e `matching-blast-rules.spec.ts:279`; `selectors.md:147` |

## 5. Orchestrator rulings (worklist)

| Ruling | Status | Evidence |
|---|---|---|
| OR-S1-1, OR-S1-2 | N/A (process) | - |
| OR-S1-3 AR3 parse-edge table | CONFORMS | `broadcastApi.test.ts:2596-2646` |
| OR-S2-1 truncation string | CONFORMS | `broadcasts.ts:1318` |
| OR-S2-2 header insert incl. fail-closed clause | CONFORMS | `broadcasts.ts:19-24` |
| OR-S2-3 one merged import | CONFORMS | `broadcasts.ts:94-102` |
| OR-S2-4 dependency doc comments | CONFORMS | `broadcasts.ts:146-159` |
| OR-S3-1 `hold` first statement, deps, derived reachPending | CONFORMS | `useComposerDraft.ts:176`, `:277`, `:285`; `BroadcastComposer.tsx:306` |
| OR-S3-2 rewritten tests, `/Estimating reach/`, typing kept | CONFORMS | `BroadcastComposer.test.tsx:938-960`, `:991-1002` |
| OR-S3-3 refusal record, keyed removal, keyed notice | CONFORMS | as AR39 |
| OR-S3-4 AR25 test, AR39 test, `deferred` with reject | CONFORMS | `BroadcastComposer.test.tsx:87-101`, `:778`, `:1080` |
| OR-S3-5 `unitsRead` set only in then / catch; abort sets nothing | CONFORMS | `BroadcastComposer.tsx:343-355` |
| OR-S3-6 counts | N/A (process) | - |
| OR-S3-7 exactly 3 lint errors in the S3 files | CONFORMS | re-measured (header) |
| OR-S3-8 AR43 | CONFORMS | as AR43 |
| OR-S4-1 AR22 recorder | CONFORMS | `broadcasts.spec.ts:1`, `:452-468` |
| OR-S4-2 GLOSSARY fail-closed sentence | CONFORMS | `GLOSSARY.md:138-141` |
| OR-S4-3 422 issue refreshed, still open, `updated:` | CONFORMS | `docs/issues/composer-org-422-offer-renamed-entry.md:2`, `:6`, `:9`, `:13-36` (refs accurate) |
| OR-S4-4 gate 5 per rule from JSON; lint record | PARTIAL | gate 5 reported by the orchestrator; the lint record is CONF-1 |
| OR-S4-5 AR43 in S4 copy | CONFORMS | `selectors.md:147`; `matching-blast-rules.spec.ts:279` |

## 6. Exact copy (plan 1.1 as amended by AR8, AR32, AR37, AR43)

Every string below was grepped byte-for-byte (`grep -F`) in code and tests; all added
lines in the package are ASCII (`grep -P '[^\x00-\x7F]'` over every added line: none).
The pending reach text keeps the U+2026 the code already used (`AudienceFilters.tsx:250`,
unchanged line), matched by `/Estimating reach/` per OR-S3-2.

| String | Status | Code | Asserted by |
|---|---|---|---|
| `Housing authorities` (picker label) | CONFORMS | `AudienceFilters.tsx:195` | `AudienceFilters.test.tsx:147`; e2e `matching-blast-rules.spec.ts:243` |
| Caption sentence 1 / 2 / 3, single spaces, 2 only with a non-empty list | CONFORMS | `AudienceFilters.tsx:37-40`, `:242-244` | `AudienceFilters.test.tsx:34-39`, `:320`, `:326`; e2e `matching-blast-rules.spec.ts:37-41`, `:249` |
| `Not used (not on the organization list): ` + names joined `, ` | CONFORMS | `AudienceFilters.tsx:42`, `:213-214` | `AudienceFilters.test.tsx:274`; `BroadcastComposer.test.tsx:845` |
| ` This blast is not limited by housing authority.` | CONFORMS | `AudienceFilters.tsx:44` | `AudienceFilters.test.tsx:282`; `BroadcastComposer.test.tsx:861` |
| `Couldn't load the property, so its housing authorities and voucher size were not filled in.` | CONFORMS | `BroadcastComposer.tsx:70-71` | `BroadcastComposer.test.tsx:968` |
| `Couldn't load the organization list, so housing authorities were not filled in from the property.` | CONFORMS | `BroadcastComposer.tsx:73-74` | `BroadcastComposer.test.tsx:982` |
| `<text> is no longer on the organization list, so it was removed from the filter.` | CONFORMS | `BroadcastComposer.tsx:65-67` | `BroadcastComposer.test.tsx:698`, `:716`, `:750` |
| `Couldn't check tours and Not interested replies, so the recipient list can't be shown yet.` + `Try again` | CONFORMS | `BroadcastComposer.tsx:76-77`, `:795` | `BroadcastComposer.test.tsx:1058-1064`, `:1082` |
| `Tour and Not interested labels couldn't be loaded.` | CONFORMS | `RecipientPreview.tsx:533` (JSX `&apos;`) | `RecipientPreview.test.tsx:1144` |
| `Too many tenants to read - some matches may be missing from this list.` | CONFORMS | `RecipientPreview.tsx:699` | `RecipientPreview.test.tsx:1156` |
| ` - the list is incomplete` | CONFORMS | `AudienceFilters.tsx:46`, `:258` | `AudienceFilters.test.tsx:361` |
| `audience resolution was truncated - the audience could not be read completely` (AR32) | CONFORMS | `broadcasts.ts:1318` | `broadcastApi.test.ts:731` |
| `audience of ${count} exceeds the ${MAX} recipient cap - narrow the housing authority and/or bedroom-size filter` (AR8) | CONFORMS | `broadcasts.ts:1319` | `broadcastApi.test.ts:3789` |
| `No Available properties. A property must be Available to send.` | CONFORMS | `BroadcastComposer.tsx:677` | `BroadcastComposer.test.tsx:1443`, `:1459` |
| `Couldn't load the properties.` (AR37) | CONFORMS | `BroadcastComposer.tsx:674` | `BroadcastComposer.test.tsx:1460`, `:1481` |
| Tour labels: `Tour <d>`, `Tour <d>, not marked`, `Toured <d>, needs outcome`, `Toured <d>, needs placement`, `No show <d>`, `Tour requested <d>, no date yet`; no date drops the date and its space | CONFORMS | `tourHoldLabel.ts:9-25` | `tourHoldLabel.test.ts:8-33` |
| Checkbox name: consent-only for no consent; else ` - ` + cues `already sent`, `not interested`, lower-cased tour label, joined `, ` | CONFORMS | `RecipientPreview.tsx:112-119` | `RecipientPreview.test.tsx:1040-1076`, `:1106-1108`; e2e `matching-blast-rules.spec.ts:282-283` |
| Add a tenant note: `Not interested`, `Already sent`, label as displayed, joined `, ` | CONFORMS | `RecipientPreview.tsx:470-477` | `RecipientPreview.test.tsx:988`, `:1104` |
| `audienceSummary`: names joined `, ` | CONFORMS | `broadcastFormat.ts:66-67` | `broadcastFormat.test.ts:35-48` |
| 400 `audience_filter.housing_authorities must be an array of at most 100 strings` | CONFORMS | `broadcasts.ts:193` | `broadcastApi.test.ts:2513` |
| 400 `audience_filter: use housing_authorities only` | CONFORMS | `broadcasts.ts:189` | `broadcastApi.test.ts:2496`, `:2628` |
| 503 body `{ error: 'audience_rules_unavailable' }` (preview, path c) | CONFORMS | `broadcasts.ts:1046`, `:1288` | `broadcastApi.test.ts:3071`, `:3386`, `:3720` |

## 7. Must-nots (intent "Explicit NOs", rejected options, spec section 5)

| Must-not | Status | Evidence |
|---|---|---|
| byHousingAuthority GSI untouched | CONFORMS | `app/src/lib/tables.ts` not in the diff; GSI at `tables.ts:97-100`; no terraform / infra file in the diff |
| `contactsRepo.listByHousingAuthority` untouched (comments only) | CONFORMS | non-comment changed lines in `contactsRepo.ts`: none; method at `:780`, `:1392-1410` |
| its tests and fakes kept; no removal issue filed | CONFORMS | `contactsRepo.integration.test.ts` untouched; resolver test fake keeps `listByHousingAuthority` (`audienceResolution.test.ts:62-65`, used to prove it is never called); no new GSI issue |
| caseworkers never filter-resolved | CONFORMS | D10 row |
| a tour never blocks a deliberate send (hand pick, re-check, direct send) | CONFORMS | path (a) `broadcasts.ts:1192-1243` unchanged; `RecipientPreview.test.tsx:1015` (check a held row), `:1091`, `:1117`; `broadcastApi.test.ts:3399`, `:3796`, `:3810` |
| AGENTS.md untouched | CONFORMS | empty diff |
| no infra, no merge, no deploy | CONFORMS | no infra file; HEAD not in `main` |
| rejected options not re-proposed (no-authority tenants listed; GSI removal; caseworker Add a tenant; voucher size list) | CONFORMS | D2 leaves them out; Add a tenant still searches tenants only (`BroadcastComposer.tsx:428`); `bedroomSize` still one number |
| out of scope untouched (server-side Not a fit close, time zones, resume rehydration, property page / Sent to / Follow up) | CONFORMS | none of those files in the diff |

## 8. Section 6 testing list - the tests that pin each bullet

| Bullet | Status | Pinning tests |
|---|---|---|
| App: hold rule - every D4 row; scheduled exactly now = not_marked; request exactly 336 h holds no more; pending claim; several tours (kind order, tie-breaks); a non-tenant tour | CONFORMS | `blastAudienceRules.test.ts:153-288` (table incl. `:166`, `:241`, `:276`), `:290-375` (pick), `:393-402` (non-tenant); route level `broadcastApi.test.ts:3170`, `:3324` |
| App: review rows - `checkedByDefault` for every flag combination; seeds whatever flags; no consent never | CONFORMS | `blastAudienceRules.test.ts:405-438` (all 32); `broadcastApi.test.ts:3240` |
| App: resolver - only searching + onboarding; searching first on `contactsPartitionFake`; any-of; blank / non-member out while non-empty, in while empty; legacy string; partner never; existing fences | CONFORMS | `audienceResolution.test.ts:147-257`, `:269-308`, `:312-343`, `:347-470` |
| App: POST create - list stored as names; spelling resolved; first off-list 422; > 100 400; legacy one-member; both keys 400; estimate = default-checked; seeds-only no reads + consent count; thrown read -> no `estimatedCount` | CONFORMS | `broadcastApi.test.ts:2451`, `:2471`, `:2487`, `:2500`, `:2519`, `:2532`, `:2547`, `:2632`, `:3503`, `:3535`, `:3553`, `:3571` |
| App: preview - `tourHold`, `checkedByDefault`, `tourHolds`; 503 on a throwing tours or decline read (filter draft); seeds-only `audienceRulesUnavailable`; legacy filter previews, answered as a list; `storedFilterRefusal` over a list | CONFORMS | `broadcastApi.test.ts:3170`, `:3240`, `:3073-3087`, `:3378`, `:3389`, `:3399`, `:3432`, `:3351`, `:2754`, `:2775`, `:2687` |
| App: send (c) - held + declined out, already-sent + no-consent kept; 503; cap after exclusions; empty 400 | CONFORMS | `broadcastApi.test.ts:3687`, `:3711`, `:3727`, `:3739`, `:3753`, `:3777` |
| App: open-tours read - the `requested` key condition | CONFORMS | `toursRepoListByStatusRange.test.ts:59`, `:90`; `toursRepo.integration.test.ts:446`; `broadcastApi.test.ts:3303` |
| App: open-tours read - every page of the other three partitions | PARTIAL | unbounded calls proven (`broadcastApi.test.ts:3303-3317`) but their paging is unpinned (M9 survived) - CONF-3 |
| Dash: rows use `checkedByDefault`; Select all; added or promoted rows stay checked | CONFORMS | `RecipientPreview.test.tsx:1001`, `:1015`, `:1091`, `:1117`, `:325` |
| Dash: labels for every kind with and without a date | CONFORMS | `tourHoldLabel.test.ts:8`, `:25` |
| Dash: literal accessible names | CONFORMS | `RecipientPreview.test.tsx:1040`, `:1106-1108` |
| Dash: Add a tenant note | CONFORMS | `RecipientPreview.test.tsx:975-989`, `:1104` |
| Dash: 503 Try again | CONFORMS | `BroadcastComposer.test.tsx:1022`, `:1080` |
| Dash: seeds-only notice | CONFORMS | `RecipientPreview.test.tsx:1140`, `:1148` |
| Dash: caption with and without its second sentence | CONFORMS | `AudienceFilters.test.tsx:320`, `:326` |
| Dash: reach line | CONFORMS | `AudienceFilters.test.tsx:348`, `:353`, `:359`; `BroadcastComposer.test.tsx:237`, `:1069` |
| Dash: prefill - exact names and unique spellings; off-list note; not-limited line | CONFORMS | `authorityPrefill.test.ts:30-77`; `BroadcastComposer.test.tsx:840`, `:856`; `AudienceFilters.test.tsx:267-292` |
| Dash: edit ownership while the property stays | CONFORMS | `BroadcastComposer.test.tsx:868`, `:887` |
| Dash: a property change empties then replaces edited filters; the same property changes nothing | CONFORMS | `BroadcastComposer.test.tsx:887` |
| Dash: a 422 removing one member (create and Preview; late 422 on another property) | CONFORMS | `BroadcastComposer.test.tsx:716`, `:750`, `:778` |
| Dash: Preview disabled until settled only with a property and filters on | CONFORMS | `BroadcastComposer.test.tsx:938`, `:1004`, `:1012` |
| Dash: failed property load and failed list read settle with their notices | CONFORMS | `BroadcastComposer.test.tsx:962`, `:976`; `AudienceFilters.test.tsx:295` |
| Dash: aborted load neither settles nor shows a notice | CONFORMS | `BroadcastComposer.test.tsx:991` |
| Dash: resumed draft and seeds-only never gated | CONFORMS | `BroadcastComposer.test.tsx:1004`, `:1012` |
| Dash: picker Available-only on bare and `?contactId=`; `?unitId=` keeps non-Available; empty state | CONFORMS | `BroadcastComposer.test.tsx:1417`, `:1430`, `:1448`, `:1438`, `:1470-1497` |
| Dash: truncation copy | CONFORMS | `RecipientPreview.test.tsx:1153`; `AudienceFilters.test.tsx:359`; `BroadcastComposer.test.tsx:245` |
| Dash: `audienceSummary` for a list | CONFORMS | `broadcastFormat.test.ts:35` |
| e2e: two run-unique authorities via `addOrg`; seven tenants with explicit status, authority, consent (no-authority tenant has none) | CONFORMS | `matching-blast-rules.spec.ts:177-198` |
| e2e: both authorities prefilled; caption | CONFORMS | `:243-249` |
| e2e: reach line equals the checked count | CONFORMS | `:265-266`, `:290` |
| e2e: Placing and no-authority tenants absent | CONFORMS | `:293-294` |
| e2e: two held tenants listed unchecked with labels; Select all leaves them unchecked; a Not a fit tour holds nothing | CONFORMS | `:212-220`, `:275-287`, `:297-303` |
| e2e: picker lists only Available properties | CONFORMS | `:223-239` |
| e2e: Add a tenant adds the Placing tenant checked | CONFORMS | `:306-309` |
| e2e: the send reaches exactly the checked tenants (outbox) | CONFORMS | `:312-326` |
| e2e: the 14-day boundary unit-tested, no backdating seam | CONFORMS | `blastAudienceRules.test.ts:236-244`; no seam added |

## FINDINGS

### CONF-1 (LOW) - the AR38 / AR42 lint record is not on the branch

- Status: MISSING (work map S4 "lint count recorded in the lint-backlog issue only";
  AR38; AR42; OR-S4-4).
- Evidence: `docs/issues/lint-backlog-repo-wide.md` is not in `git diff a2b3d80d HEAD`;
  its frontmatter still reads `title: 22 pre-existing react-hooks lint errors across 17
  files ...` and `updated: 2026-10-13` (`:3`, `:9`), and its newest paragraph is
  "Status 2026-10-13 (`feat/primary-contact-integrity`)" (`:13`). The AR38 trigger is
  met: gate 5 shows the branch removed 2 pre-existing `react-hooks/set-state-in-effect`
  errors (re-measured: 3 left in the S3 files).
- Fix (orchestrator Task 4.4, last step, before the handback): run `npx eslint .` bare
  from the worktree root into `.superpowers/lint-repo.log` (format JSON per OR-S4-4),
  count errors per rule and files with `errorCount > 0`; add a dated paragraph right
  after the frontmatter, before "Status 2026-10-13", in that paragraph's style
  ("**Status 2026-10-1x (`feat/matching-blast-rules`).** **N errors across F files, 0
  warnings** ...", the rule breakdown, and which two errors went and why - the prefill
  effects became derived state, AR16); update the frontmatter `title` counts and
  `updated:`; commit that file alone. Expected N = 20 (AR38). AGENTS.md stays untouched.

### CONF-2 (LOW) - AR12's precedence in send path (c) has no pinning test

- Status: AR12 PARTIAL - the code conforms, the test does not pin it.
- Evidence: `broadcasts.ts:1280-1298` reads the rules before the empty and the
  truncation refusals, as AR12 rules. Mutant M8 (section 9) moved an empty refusal and
  a truncation refusal ahead of the rules read; all 153 `broadcastApi.test.ts` tests
  still passed. No test combines an empty or truncated resolution with a throwing rules
  read, and no test previews a non-draft filter broadcast with a throwing read (AR12's
  "whatever its status").
- Fix: in the D6 describe of `app/test/broadcastApi.test.ts`, add one case with
  `audienceResolutionService: async () => ({ contactIds: [], contacts: [], count: 0, truncated: false })`
  plus `vi.spyOn(world.toursRepo, 'listByStatus').mockRejectedValueOnce(new Error('throttled'))`:
  expect 503 `{ error: 'audience_rules_unavailable' }`, still a draft, `markSending` not
  called; and a twin with `truncated: true` and one consented contact (expect 503, not
  400 `audience_too_large`). Re-run M8 to see it killed.

### CONF-3 (LOW) - the unbounded open-tours partitions' paging is unpinned (spec 6)

- Status: spec section 6 bullet "every page of the other three partitions" PARTIAL.
- Evidence: `toursRepo.ts:450-463` walks pages for both shapes, but the only unbounded
  case (`toursRepoListByStatusRange.test.ts:43-57`) serves ONE page, and
  `repoPagingWiring.test.ts` covers `listByTenant` / `listByUnit` only. Mutant M9 made
  the loop stop after one page when `createdAtFrom` is absent (the `scheduled`,
  `toured` and `no_show` reads, plus tour auto-close); both repo test files passed.
  Control M9c (stop after one page when it IS present) was killed by
  `toursRepoListByStatusRange.test.ts:73`, so the alias reached the module. The route
  test `broadcastApi.test.ts:3303` proves the three calls carry no options, not that
  they page.
- Fix: add to `app/test/toursRepoListByStatusRange.test.ts` a case "(PIN) without opts
  it walks EVERY page": two recorded pages for `listByStatus('scheduled')`, expect both
  rows and `ExclusiveStartKey` on the second Query with the unbounded key condition.

### CONF-4 (INFO) - a 422 whose text matches no member empties the whole authority list

- Evidence: `BroadcastComposer.tsx:262-267` - when `err.text` equals no member (or the
  body has no `text`), `next = []`, so every member is removed and the notice names the
  refused text. D3b says "removes THAT member only, keeps the others"; AR39 says "the
  clicking render's authority list minus the member equal to err.text". The fallback is
  the plan's own S3 design note (plan ~6582: "never expected: the dashboard sends exact
  list names ... empties the list instead of leaving the composer stuck"). Reachable
  only when the composer's list and the stored list disagree (for example an entry
  renamed twice while one composer stays open, so the stored name is no longer the one
  on screen). Without the fallback the same draft would 422 forever.
- Fix: none required. Optional: pin the fallback with a test, or record it in the
  spec's D3b as the one exception.

### CONF-5 (INFO) - AR39's "a late refusal shows NOTHING" does not hold for A -> B -> A

- Evidence: the 422 removal and the notice are keyed by property id
  (`BroadcastComposer.tsx:260-267`, `:739-741`), exactly as AR39's mechanism says. If
  staff, while property A's Preview is in flight, change to B and then back to A, the
  pick handler gives A a fresh edits slot (`:489`), and the late 422 for A's old draft
  then removes the member from A's new slot and shows the notice on A. AR39's summary
  sentence ("A late refusal therefore shows NOTHING (no alert, no notice, no edit)")
  is true only for a property that differs from the one on screen.
- Impact: benign - the member really is off the list and A is on screen. The 503 path
  cannot do this (keyed by draft and key, `:591-597`).
- Fix: none; a note so a later reviewer does not read AR39's summary as a guarantee.

### CONF-6 (INFO) - `ReviewRowsResult.rows` order differs from binding 2.5's comment

- Evidence: binding 2.5 says "audience rows first, then seeds not already present", as
  does the code comment `broadcasts.ts:524`; the code (`:777`) drops a seeded contact
  from the audience part and appends ALL seeds, so a contact in both sits at the seed
  position with the seed's resolved fields. This is the base union unchanged (main
  preview did the same), and the dashboard sorts rows by last heard from, so nothing
  observable changed.
- Fix: optional comment correction at `broadcasts.ts:524`.

## 9. Mutation proofs

Method: each mutant is a COPY of the module with one exact-string change (helper
asserts the source string occurs exactly once), placed in a throwaway directory at the
original's depth (`app/src/zz-review-conf-mut/`, `dashboard/src/routes/zz-review-conf-mut/`;
dashboard sibling imports rewritten `./X` -> `../broadcasts/X`), wired in by a
throwaway vitest config (`app/zz-review-conf-vitest.config.ts`,
`dashboard/zz-review-conf-vitest.config.ts`) that adds ONE `resolve.alias` from the
import specifier to the mutant; the real, unedited test files ran against it. The app
config drops `globalSetup` (these files are in-memory and each file runs under its own
per-file DynamoDB key) so a concurrent reviewer's run is not disturbed by a table
create / drop. No tracked file was edited.

Identity baselines (unchanged copies through the same alias, all green):
`blastAudienceRules.test.ts` 49/49, `audienceResolution.test.ts` 23/23,
`broadcastApi.test.ts` 153/153, `BroadcastComposer.test.tsx` 72/72,
`RecipientPreview.test.tsx` 55/55.

| # | Decision | Mutant (one change) | Test file | Result |
|---|---|---|---|---|
| M1 | D4 request boundary (336 h holds no more) | `blastAudienceRules.ts:108` `>=` -> `>` | `blastAudienceRules.test.ts` | KILLED, 2 failed / 47: "requested exactly 336 hours old -> no hold (boundary)" (expected `{ kind: 'requested', ... }` to deeply equal undefined); "groups by the tour tenantId ..." (expected `['c-ana','c-bo','c-cy']` to equal `['c-ana','c-cy']`) |
| M2 | (not run) | the scheduled-at-now boundary; the same table pins it at `blastAudienceRules.test.ts:165-169`, and M1 already proves this alias reaches the module | - | - |
| M3 | D1 searching read first | `audienceResolution.ts:153` iterate `[...BLAST_TENANT_STATUSES].reverse()` | `audienceResolution.test.ts` | KILLED, 8 failed / 23, e.g. "the page bound cuts ONBOARDING, never searching" (expected `['c-o1','c-o2','c-o3']` to equal `['c-s1','c-s2','c-s3']`) |
| M4 | D2 non-empty list leaves out a missing authority | `audienceResolution.ts:192` `(ha === undefined \|\| !has)` -> `(ha !== undefined && !has)` | `audienceResolution.test.ts` | KILLED, 3 failed / 23: "matches ANY member ... missing, blank and non-member tenants are left out" (expected `['c-a','c-b','c-blank','c-none']` to equal `['c-a','c-b']`), legacy string, trimmed members |
| M5 | D8 reach = default-checked rows | `broadcasts.ts:942` `review.rows.filter((r) => r.checkedByDefault).length` -> `review.rows.length` | `broadcastApi.test.ts` | KILLED, 3 failed / 153: `:3503` (expected 6 to be 2), `:3535` (2 to be 1), `:3598` (2 to be 1) |
| M6 | D6 path (c) excludes declines | `broadcasts.ts:1292` drop `&& !rules.declinedIds.has(c.contactId)` | `broadcastApi.test.ts` | KILLED, 2 failed / 153: `:3687` (expected 4 to be 3), `:3739` (expected 200 to be 400) |
| M7 | D5 filter preview fails CLOSED | `broadcasts.ts:790` throw only when `mode === 'estimate'` (preview degrades) | `broadcastApi.test.ts` | KILLED, 5 failed / 153: `:3073`, `:3078`, `:3083`, `:3378`, `:3389` (expected 200 to be 503) |
| M8 | AR12 rules read outranks empty / truncated (path c) | insert empty and truncated refusals between `broadcasts.ts:1280` and the rules read | `broadcastApi.test.ts` | SURVIVED, 153/153 - CONF-2 |
| M9 | D5 every page of the unbounded partitions | `toursRepo.ts:463` `while (lastKey !== undefined && from !== undefined)` | `toursRepoListByStatusRange.test.ts`, `repoPagingWiring.test.ts` | SURVIVED, 10/10 - CONF-3 |
| M9c | control for M9 (alias reaches the module) | `toursRepo.ts:463` `while (lastKey !== undefined && from === undefined)` | same | KILLED, 1 failed / 10: "with createdAtFrom it still walks EVERY page" (expected `['t1']` to equal `['t1','t2']`) |
| M10 | AR23 / AR35 no draft while the prefill is unsettled | `useComposerDraft.ts:176` delete `if (input.hold === true) return;` | `BroadcastComposer.test.tsx` | KILLED, 2 failed / 72: `:938`, `:991` (expected "spy" to not be called at all, but called 1 times) |
| M11 | AR39 a late 422 edits only its own property's slot | `BroadcastComposer.tsx:266` `setEdits((prev) => ({ ...prev, authorities: next }))` | `BroadcastComposer.test.tsx` | KILLED, 1 failed / 72: `:778` (no `Remove ...` chip left on 12 Oak St) |
| M12 | D9 Available-only picker | `BroadcastComposer.tsx:345` `setUnitCandidates(units)` | `BroadcastComposer.test.tsx` | KILLED, 3 failed / 72: `:1417`, `:1430`, `:1438` |
| M13 | D5 the review trusts the server's `checkedByDefault` | `RecipientPreview.tsx:141` recompute the pre-#6 rule from the flags | `RecipientPreview.test.tsx` | KILLED, 4 failed / 55: `:1001`, `:1015`, `:1040`, `:1117` (`expect(element).not.toBeChecked()`) |
| M14 | AR43 requested-label copy | `tourHoldLabel.ts:23` `` `Tour requested${at}` `` | `tourHoldLabel.test.ts`, `RecipientPreview.test.tsx` | KILLED, 3 failed / 57: `tourHoldLabel.test.ts:8` (expected 'Tour requested Oct 12' to be 'Tour requested Oct 12, no date yet'), `:25`, `RecipientPreview.test.tsx:1091` |

## 10. Throwaway files

Created, all named `zz-review-conf-*` and deleted by exact name before the reply:
`app/zz-review-conf-vitest.config.ts`, `dashboard/zz-review-conf-vitest.config.ts`,
the mutant copies under `app/src/zz-review-conf-mut/` and
`dashboard/src/routes/zz-review-conf-mut/` (each deleted right after its run; both
directories removed empty), and the run logs `.superpowers/review/zz-review-conf-*.log`
plus `.superpowers/review/zz-review-conf-eslint.json` / `.err`. The other reviewer's
`zz-review-adv-*` files were not touched.
