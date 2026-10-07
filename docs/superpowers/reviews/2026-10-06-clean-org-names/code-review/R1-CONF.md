# R1-CONF - spec conformance review, feat/clean-org-names (branch A)

- Reviewer: R1-CONF (Opus 5.5), 2026-10-07. Worktree `W:/tmp/clean-org-names`,
  HEAD 81de4477, merge base with main d839494a.
- Contract: spec `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  (rev 8; branch A = D1-D15, sections 5-9, 11). Plan sections 1, 2, 3, 12.
  Orchestrator rulings: `build-research/worklist.md` (RG-1, RG-2, B-1, B-2,
  B-3, accepted minors U1/U2, per-slice items).
- Verified against the CODE (every row below cites the file:line I read), not
  commit messages. Packages read: pkg-backend / pkg-frontend / pkg-docs plus
  the full files.
- Tests I ran (individual files only, never the full suite; DynamoDB Local
  untouched): app 18 unit files / 433 tests, app orgNames + orgStartingList
  66 tests, app 5 integration files (orgListRepo, orgRecordWriters,
  suggestionResolutionRepo, importApply, seedProfile) / 98 tests; dashboard 21
  files / 487 tests. ALL GREEN. The orchestrator's Phase 3 gate logs
  (`.superpowers/sdd/g1..g5`) show typecheck, npm test, smoke and the whole e2e
  suite (320 passed) green, and gate 5 with 0 new lint errors.

## Counts

| Status | Rows |
|---|---|
| CONFORMS | 205 |
| PARTIAL | 3 |
| MISSING | 0 |
| DEVIATES-BY-RULING | 4 |

Findings: 2 (both LOW) - R1-CONF-1 (2 PARTIAL rows, one root cause),
R1-CONF-2 (1 PARTIAL row). No CRITICAL, HIGH or MEDIUM conformance gap. No
D16-D21 (branch B) code was built. Every orchestrator ruling was applied as
ruled; none contradicts the spec (RG-1 accepts a rare exception to I1's
letter, which D8's replayable-plan design already implies - see table J).

---

## A. Work map (plan section 2)

| Item | Status | Evidence |
|---|---|---|
| S1 rules | CONFORMS | `app/src/lib/orgNames.ts:42-49` normalize, `:55-61` on-list, `:78-96` resolve, `:119-148` compound, `:187-216` close, `:258-309` D5 checks, `:330-390` D12/D13; `app/src/lib/orgStartingList.ts:14-77` = Appendix A row for row (names, spellings, the four notes); tests `app/test/orgNames.test.ts`, `orgStartingList.test.ts` (66/66) |
| S2 store | CONFORMS | `app/src/repos/orgListRepo.ts:161-192` consistent get + create-only first write, `:196-222` read-and-bump (5 attempts, `:202` size cap), `:223-229` peek / putForSeed; fake `app/test/helpers/orgListFake.ts`; `orgListRepo.integration.test.ts` 12/12 |
| S3 services | CONFORMS | `app/src/services/orgNames.ts:206-369`, `orgRecords.ts:352-606`, `orgRewrite.ts:168-509`; repo writers `contactsRepo.rewriteOrgFields` and `unitsRepo.rewriteAcceptedAuthorities` (no `updated_at`); `orgRecordWriters.integration.test.ts` 22/22 |
| S4 rewrite job | CONFORMS | `app/src/jobs/orgRewrite.ts:74-122` (current-run gate `:87`, fixed fields `:92-101`, never rethrows `:105-121`), `:150-167`; `registerHandlers.ts:97`; name pinned in `registerHandlers.test.ts` |
| S5 API | CONFORMS | `app/src/routes/organizations.ts:127-372`; composition root builds the repo ONCE `app/src/routes/api.ts:716-724`, mount `:781-788`, same instance to contacts/units/broadcasts/suggestions `:882, :978, :1100, :1212` |
| S6 writers | CONFORMS | `routes/contacts.ts:1467-1471, :1560-1582`; `routes/units.ts:457-470, :1385-1411`; `routes/broadcasts.ts:467-487, :562-570, :647-655, :879-884` |
| S7 AI | CONFORMS | `services/extraction/orgListBlock.ts:80-163`; `jobs/extraction.ts:563-586, :618`; `prompt.ts:21, :56-67, :186`; `extraction/apply.ts:268-300, :825-858`; `suggestionResolution.ts:221-246, :328-355, :724-728, :757, :784-790, :821`; `routes/suggestions.ts:85-93, :160-171, :231` |
| S8 importer | CONFORMS | `app/src/lib/import/apply.ts:979-1015, :1134, :1140, :1480, :337, :509`; `app/scripts/import-apply.ts:366, :403, :453` |
| S9 intake rule | CONFORMS | `app/src/jobs/missedCallAutoText.ts:85-91`; `dashboard/src/routes/settings/TemplatesSection.tsx:217`; `docs/issues/missed-call-autotext-partial-intake.md` |
| S10 retire old lists | CONFORMS | `lib/housingAuthority.ts`, `HOUSING_AUTHORITY_VOCAB` (`extraction/schema.ts`) and `dashboard/.../orgVocabulary.ts` deleted; guard `app/test/orgListsRetired.test.ts`; repo-wide grep finds no remaining reference outside the guard and RUNBOOK prose |
| S11 dashboard | CONFORMS | `dashboard/src/routes/orgs/{OrgPicker,NewOrgDialog,useOrgList,orgCopy}`; forms, composer, ContactDetail, AiRunDetail, listingFormat, `settings/{OrgListSection,OrgEntryDialogs,NotOnListSection,useOrgAdmin}`; API `dashboard/src/api/endpoints.ts` (all plan 3.11 functions); 21 files / 487 tests green |
| S12 seeds | CONFORMS | `app/src/lib/seed/orgList.ts:26-55`; `lean.ts:536`; `matrix.ts:82-89, :1227, :1260`; cast/live/performance via `SEED_AUTHORITY`; slug map = spec section 7; `seedOrgNames.test.ts` |
| S13 dev seam | CONFORMS | `app/src/routes/dev.ts:1213-1262` (dev router only); `devOrgFixture.test.ts` 14/14 |
| S14 e2e | CONFORMS | `e2e/fixtures/orgFixture.ts`; `e2e/tests/dashboard-next/org-lists.spec.ts` (11 tests); pinned specs; `e2e/support/selectors.md`, README; whole suite g4 = 320 passed (`.superpowers/sdd/g4-e2e.log`, exit 0) |
| S15 cleanup script | CONFORMS | `app/scripts/clean-org-names.ts`; `RUNBOOK.md:420-443`; `cleanOrgNames.test.ts` 28/28 |
| S16 docs | CONFORMS | `documentation/GLOSSARY.md:271-363`; `docs/issues` (2 resolved, 2 updated, 6 filed); `documentation/sequence-diagram-to-test.md` |

## B. Decisions D1-D15

| Decision / requirement | Status | Evidence |
|---|---|---|
| D1 one `org-list` item in `settings`, no new table | CONFORMS | `orgListRepo.ts:77, :154-158` |
| D1 sibling repo (not settingsRepo) | CONFORMS | `orgListRepo.ts:1-25` |
| D1 read-and-bump on `version`, retry on lost condition | CONFORMS | `orgListRepo.ts:196-222` |
| D1 no in-process cache; every reader one consistent GetItem | CONFORMS | `orgListRepo.ts:161-164`; per-call reads `services/orgNames.ts:211-226`; no client cache `dashboard/src/routes/orgs/useOrgList.ts:36-90` |
| D2 first read writes the starting list create-only and returns it | CONFORMS | `orgListRepo.ts:166-192` (`attribute_not_exists`, loser re-reads) |
| D2 seeds (lean + full) unconditional put | CONFORMS | `lean.ts:536` row; `app/src/lib/seed/index.ts` plain `PutCommand`; full = lean + cast + matrix (`index.ts:115-132`); `seedProfile.integration` green |
| D2 Appendix A fixed in code | CONFORMS | `orgStartingList.ts:14-77` matches Appendix A (all 12 HA rows, 7 agency rows, four notes) |
| D3 records store the exact name | CONFORMS | every writer stores `entry.name` (`lib/orgNames.ts:270`, `extraction/apply.ts:283`, `suggestionResolution.ts:233-245`, `import/apply.ts:990, :993, :1011`, `orgRecords.ts:347-348`) |
| D3 on the list = exact name of an accepted kind; other kind's name is not on it | CONFORMS | `orgNames.ts:26-31, :55-61` |
| D3 a use = exact name in a field of the entry's kind | CONFORMS | `orgRecords.ts:395-425` |
| D3 existing readers unchanged | CONFORMS | no diff to audienceResolution.ts, tenantFacets, unitListFacets, flyer, similarUnits |
| D4 normalization rule | CONFORMS | `orgNames.ts:42-49` |
| D4 name match, then spelling match within the field's kinds; 2+ = ambiguous | CONFORMS | `orgNames.ts:83-90` |
| D4 close names only for prompts | CONFORMS | `orgNames.ts:187-216`; never written by any path |
| D4 names unique across kinds; spelling never equals a name; no cross-kind share; same-kind share allowed | CONFORMS | `orgNames.ts:330-347, :368-390`; kind change guards a would-be cross-kind share `services/orgNames.ts:337-352` |
| D4 exact text decided first and never compound | CONFORMS | `orgNames.ts:86-92, :124` |
| D4 compound = longest-phrase spans, no common entry | CONFORMS | `orgNames.ts:119-148` |
| D4 compound never a spelling, never resolves | CONFORMS | `orgNames.ts:387`; probe of the entry as it will be (B-1) `services/orgNames.ts:303-317` |
| D4 tests cover Appendix A and the examples | CONFORMS | `orgStartingList.test.ts:21-110`; `orgNames.test.ts:98-120` ("dca hud vash", "atlanta aha", "atlanta housing authority aha", shared AHA) |
| D5 one check, 422 `org_not_on_list {field,text,candidates,close,otherKind?}` | CONFORMS | `orgNames.ts:238-272` (adds `compound?`, plan 3.5) |
| D5 scalar checked only when it changes; clear always allowed; HA '' REMOVEs, agency '' kept | CONFORMS | `contacts.ts:1560-1582`, parser `:638-652`; `orgNames.ts:264-266` |
| D5 "unchanged" judged on the trimmed request text | DEVIATES-BY-RULING (U1) | `orgNames.ts:264-266`; a padded legacy value re-sent by an API caller is checked as new |
| D5 list per member: held (trimmed) pass, legacy `jurisdiction` only while no stored list, trimmed + de-duplicated | CONFORMS | `orgNames.ts:285-309`; `units.ts:1385-1411` |
| D5 scripts and jobs REMOVE the HA, never SET '' | CONFORMS | `contactsRepo.rewriteOrgFields` refuses '' (EmptyIndexKeyError); `orgRecords.ts:283, :290`; `clean-org-names.ts:193` |
| D6 pickers: tenant HA + Agency, property HA (multi) | CONFORMS | `ContactEditForm.tsx:545-590`; `ListingEditForm.tsx:245-261`; `UnitCreateForm.tsx:326-342` |
| D6 typing matches names and spellings (AHA lists Atlanta + Augusta) | CONFORMS | `OrgPicker.tsx:89-113` |
| D6 nothing matches -> "Add <text> as a new ..." -> "Is this really new?" | CONFORMS | `OrgPicker.tsx:152-161, :354`; host renders the dialog outside the form (`ContactEditForm.tsx:872`) |
| D6 closest names first ("Use X"); "Yes, add it" = name + notes | CONFORMS | `NewOrgDialog.tsx:128-173, :136-147, :192` |
| D6 other kind: says so; tenant form offers the other field | CONFORMS | `NewOrgDialog.tsx:254-276`; `ContactEditForm.tsx:880-883` |
| D6 property forms add housing authorities only | CONFORMS | `ListingEditForm.tsx:550`, `UnitCreateForm.tsx:575` (kind HA, no other-field action) |
| D6 off-list value = removable "Not on the list" chip; unchanged never fails | CONFORMS | `OrgPicker.tsx:273-294`; form sends a field only when it changed (ContactEditForm exact compare; ListingEditForm list compare) |
| D7 composer picker without add | CONFORMS | `AudienceFilters.tsx:118-130` (no `onRequestAdd`) |
| D7 stored filter re-checked at draft preview and the filter-resolving send; spelling names its entry as candidate | CONFORMS | `broadcasts.ts:467-487, :647-655, :879-884` |
| D7 a 422 at create or Preview asks for a new pick | CONFORMS | `BroadcastComposer.tsx:123-135, :342-345`; `useComposerDraft.ts:201-214` |
| D7 curated send not re-checked; nothing rewrites broadcasts | CONFORMS | send branch (a) untouched; no broadcast path in `orgRecords.ts` / cleanup |
| D8 static system prompt; list block in USER content; read once per run | CONFORMS | `prompt.ts:21, :56-67, :186`; `jobs/extraction.ts:563-569`; `adapters/extraction.ts` `ExtractionInput.orgListBlock` |
| D8 `orgListFingerprint` recorded beside the prompt fingerprint | CONFORMS | `jobs/extraction.ts:581, :665`; `aiRunsRepo.ts:55-58` |
| D8 16,000-char budget; drop spellings, then agencies, then HA names; WARN with counts | CONFORMS | `orgListBlock.ts:35, :98-149`; `jobs/extraction.ts:570-579` |
| D8 model told: full name, ambiguous abbreviation, agencies never, place names | CONFORMS | `prompt.ts:56-67` |
| D8 apply: match -> exact name (op decides); ambiguous/unknown -> suggestion; agency -> `agency_not_authority` | CONFORMS | `extraction/apply.ts:268-300`; `runTypes.ts` DROP_REASONS |
| D8 accept `value` checked before the claim; only the resolution or a candidate; 422 `value_not_from_suggestion` | CONFORMS | `suggestionResolution.ts:221-246, :784-790`; `suggestionAcceptOrgList.test.ts` 17/17 |
| D8 re-accept with a different value -> 409 via `valueKey` | CONFORMS | `suggestionResolution.ts:724-728, :757, :821`; `suggestionResolutionRepo.ts` valueKey on active + completed rows |
| D8 dashboard: "Is this really new?" when not exactly a name; resolution/candidate/added -> accept with value; close name -> normal edit; agency -> Dismiss | CONFORMS | `ContactDetail.tsx:733-791, :1186-1205`; `NewOrgDialog.tsx:277-283` |
| D8 run detail header shows the fingerprint; System Status unchanged | CONFORMS | `AiRunDetail.tsx:70`; no SystemStatusSection diff |
| D8 AI never adds names, never fills Agency | CONFORMS | apply writes `housingAuthority` only; no add path from the job |
| D9 importer resolves with D4 | CONFORMS | `import/apply.ts:979-1015` |
| D9 contact HA fill-only (`if_not_exists`) | CONFORMS | `import/apply.ts:1134` |
| D9 agency in the HA column -> `agency` when absent | CONFORMS | `import/apply.ts:990-993, :1140` |
| D9 unknown/ambiguous not written, reported with counts, dry runs too | CONFORMS | `import/apply.ts:337, :509, :517`; `import-apply.ts:443-460` |
| D9 unit side: resolved names only, never an agency | CONFORMS | `import/apply.ts:1004-1015, :1480` |
| D9 CLI reads the list without creating it | CONFORMS | `import-apply.ts:366-372` (peek, starting list fallback) |
| D10 tab for every signed-in user; three sections | CONFORMS | `settingsTabs.ts:29-39`; `App.tsx:233`; `OrgListSection.tsx:279-301` |
| D10 row: name, spellings, notes, uses (tenants / other contacts / properties, "+N deleted") | CONFORMS | `OrgListSection.tsx:102-127`; `orgCopy.ts:402-406`; `orgRecords.ts:395-425` |
| D10 delete and kind change count deleted holders; 409 says how many | CONFORMS | `organizations.ts:116-123, :288, :301` |
| D10 "Not on the list" = EVERY distinct off-list stored value, all contact types + properties, deleted included, per value and field, count, resolution | PARTIAL | `orgRecords.ts:427-468`; whitespace-only values skipped `:443-447, :455` - see R1-CONF-1 |
| D10 "Show records": name, type, deleted marker / address, linked | CONFORMS | `orgRecords.ts:470-491`; `NotOnListSection.tsx:119-176`; `orgCopy.ts:436-452` |
| D10 name-variant row offers only "Use <entry>" (409 `org_value_is_name_variant`) | CONFORMS | `orgRewrite.ts:354-362`; `NotOnListSection.tsx:66-72` |
| D10 everyone views/adds/edits notes; admin-only actions enforced on the server | CONFORMS | `organizations.ts:240-243, :298, :309, :323, :368`; UI absent for a VA `OrgListSection.tsx:193-249, :287`, `NotOnListSection.tsx:447-461` |
| D10 Use <name> with "Remember this spelling" (on by default; auto-off with the reason) | CONFORMS | `NotOnListSection.tsx:203-243, :386-400`; `orgRewrite.ts:426-435` |
| D10 Move to Agency / Move to Housing authority semantics, conflicts counted | CONFORMS | `orgRecords.ts:285-324`; offered only for the other kind `NotOnListSection.tsx:92-101` |
| D10 Move/Split when the target field holds only whitespace | DEVIATES-BY-RULING (U2) | `orgRecords.ts:286, :327` treat '  ' as another value (conflict), spec says absent or '' |
| D10 Split: HA values on contacts, prefilled from spans, editable, conflicts | CONFORMS | `orgRecords.ts:325-344`; `orgRewrite.ts:392-400`; `NotOnListSection.tsx:84-91, :350-369` |
| D10 Add as new (value or corrected name), then Use | CONFORMS | `orgRewrite.ts:402-437`; `NotOnListSection.tsx:104, :280-292` |
| D10 Clear | CONFORMS | `orgRecords.ts:281-284` |
| D10 compound list member / compound agency -> Use (one half) or Clear | CONFORMS | `NotOnListSection.tsx:82-83, :102-105` |
| D10 delete/kind change only when nothing (deleted included) uses the entry | CONFORMS | `organizations.ts:116-123` |
| D10 spellings/notes edits touch no records | CONFORMS | `services/orgNames.ts:275-324` list-only writes |
| D11 one rewrite at a time (15-minute heartbeat); cleanup takes the same lock | CONFORMS | `services/orgNames.ts:136-139`; `orgRewrite.ts:176-179, :492-508` |
| D11 order: mint id, ONE list write (change + running definition), then enqueue `{jobId}`; enqueue failure -> failed | CONFORMS | `orgRewrite.ts:218-257` |
| D11 Run again for failed or stale; never for cleanup (page says re-run the script; stale cleanup lock stops blocking) | CONFORMS | `orgRewrite.ts:443-487`; `orgCopy.ts:331-334, :385-397`; `OrgListSection.tsx:254-269` |
| D11 Run again re-checks targets (409 `org_rewrite_target_gone`) | CONFORMS | `orgRewrite.ts:460-468` |
| D11 Run again also refuses when a from-text became a listed name | DEVIATES-BY-RULING (B-2) | `orgRewrite.ts:469-479`; copy `orgCopy.ts:131-132` |
| D11 read paths: byTypeStatus all types active + deleted; units base scan | CONFORMS | `orgRecords.ts:359-392` |
| D11 `fields` fixed at start | CONFORMS | `orgRewrite.ts:290, :330, :376`; job `jobs/orgRewrite.ts:92-101` |
| D11 normalized from-text match; conditional per record; unit lists de-duplicated; REMOVE on Clear; no unit `updated_at` | CONFORMS | `orgRecords.ts:539-597`; `unitsRepo.rewriteAcceptedAuthorities` |
| D11 audit `org_name_rewrite {field,from,to,action,actor}` per field written | CONFORMS | `orgRecords.ts:519-529, :572, :591` |
| D11 never touches broadcasts | CONFORMS | no broadcast access in `orgRecords.ts` / `jobs/orgRewrite.ts` |
| D11 from-texts: rename old name; merge name + unshared spellings; value actions the value | CONFORMS | `orgRewrite.ts:290, :303-308, :328, :376` |
| D11 merge moves name + ALL spellings; shares stay; cap -> 409 `org_spellings_full`; rename keeps old name as a spelling | CONFORMS | `orgRewrite.ts:309-323, :276-286` |
| D11 heartbeat/finish re-check the id; lock lost stops at once; done/failed with counts; never rethrows | CONFORMS | `orgRewrite.ts:182-215`; `orgRecords.ts:497-516`; `jobs/orgRewrite.ts:84-121` |
| D12 spellings curated, never learned from form clicks | CONFORMS | `addOrg` creates `spellings: []` (`services/orgNames.ts:258-268`); pickers never write spellings |
| D12 admin edit refusals + explicit confirm for a same-kind share | CONFORMS | `services/orgNames.ts:286-324`; `OrgEntryDialogs.tsx:140-155, :166-170` |
| D12 automatic additions skip (same-kind share too) and name each skip | CONFORMS | `orgRewrite.ts:276-286, :426-435`; `OrgEntryDialogs.tsx:104-107` |
| D12 rename may take its own spelling (dropped), not another's name/spelling | CONFORMS | `orgRewrite.ts:264-271`; `orgNames.ts:341-343` |
| D13 name <= 120, no control character, never normalizes to '' | CONFORMS | `orgNames.ts:336-340`; `services/orgNames.ts:64-82` |
| D13 notes <= 500, everyone | CONFORMS | `services/orgNames.ts:249-251, :275-277`; `organizations.ts:246-253` |
| D13 <= 20 spellings of <= 120 chars | CONFORMS | `orgNames.ts:375, :380`; `services/orgNames.ts:302` |
| D13 compound refused as a new name with the entries and a pointer to Split | CONFORMS | `orgNames.ts:344-345`; `services/orgNames.ts:103-107`; `NewOrgDialog.tsx:286-292`; `orgCopy.ts:211-218` |
| D13 item > 300 KB -> 409 `org_list_full` | CONFORMS | `orgListRepo.ts:202`; `services/orgNames.ts:149` |
| D14 automatic mappings only; leftovers listed; no merge mode or decisions file | CONFORMS | `clean-org-names.ts:157-293, :772-794` |
| D15 agency is an intake fact; Templates hint; issue doc | CONFORMS | `missedCallAutoText.ts:85-91`; `TemplatesSection.tsx:217`; issue doc diff |

## C. Data model (sections 5.1, 5.2)

| Requirement | Status | Evidence |
|---|---|---|
| 5.1 item: settingId, version, entries (orgId, kind, name, spellings, notes?, created/updated At/By) | CONFORMS | `orgListRepo.ts:70-75`; `orgNames.ts:9-21` |
| 5.1 lastRewrite: jobId, action set, fromTexts, toName?, agencyName?, field?, fields, status, heartbeatAt, counts?, startedAt, finishedAt?, startedBy | CONFORMS | `orgListRepo.ts:36-68` (adds `error?`, plan 3.2) |
| 5.2 `contact.housingAuthority` any type, checked, '' REMOVEs | CONFORMS | `contacts.ts:638-642, :1560-1582` |
| 5.2 `contact.agency` any type, checked, '' stored | CONFORMS | `contacts.ts:648-652, :1565-1580` |
| 5.2 `unit.accepted_authorities` new members checked, trimmed, de-duplicated | CONFORMS | `units.ts:457-470, :1385-1411` |
| 5.2 broadcast filter: POST checked; preview + filter-resolved send re-check | CONFORMS | `broadcasts.ts:562-570, :647-655, :879-884` |
| 5.2 legacy `jurisdiction`/`accepted_programs` tombstones unchanged; cleanup backfills | CONFORMS | `unitFields.ts` untouched; `clean-org-names.ts:233-250` |
| 5.2 branch B fields (organization, caseworker_review, type_source) not added | CONFORMS | grep of every added line finds none |

## D. API (section 6)

| Endpoint / rule | Status | Evidence |
|---|---|---|
| GET /api/organizations -> lists + lastRewrite | CONFORMS | `organizations.ts:127-137` |
| GET /usage | CONFORMS | `organizations.ts:139-145` |
| GET /not-on-list (everyone, on demand) | CONFORMS | `organizations.ts:147-153` (row content: see R1-CONF-1) |
| GET /not-on-list/records?field=&value= (everyone) | CONFORMS | `organizations.ts:155-170` |
| POST /check {kind,text,spellingFor?}; > 200 chars -> 400; close scored <= 120 | CONFORMS | `organizations.ts:172-200` (`:190-193`); `orgNames.ts:192`; result shape `services/orgNames.ts:228-247` |
| POST / {kind,name,notes?} -> 201; 409 `org_name_taken` returns the entry | CONFORMS | `organizations.ts:202-224`; `services/orgNames.ts:101-102` |
| PATCH /:orgId notes (everyone) / spellings, name, kind (admin); one key per request; rename 202; kind 409 `org_in_use` | CONFORMS | `organizations.ts:226-294` |
| POST /:orgId/merge {intoOrgId} admin -> 202 | CONFORMS | `organizations.ts:307-319` |
| DELETE /:orgId admin; 409 `org_in_use` | CONFORMS | `organizations.ts:296-305` |
| POST /not-on-list/resolve admin {field,value,action,name?,agencyName?,rememberSpelling?} -> 202 + skipped spellings | CONFORMS | `organizations.ts:321-364`; `orgRewrite.ts:338-441` |
| POST /rewrite/run-again admin | CONFORMS | `organizations.ts:366-372` |
| Suggestions accept: optional `value`; 422 `value_not_from_suggestion`; 409 `suggestion_already_resolved` | CONFORMS | `suggestions.ts:85-93, :160-171`; `suggestionResolution.ts:233, :267, :757, :821` |
| Existing writers answer 422 `org_not_on_list` | CONFORMS | contacts `:1572-1577`, units `:464-467, :1405-1408`, broadcasts `:564-567`, suggestions `:236-240` + `suggestions.ts:231` |
| Rewrite-starting endpoints answer 409 `org_rewrite_running` | CONFORMS | `orgRewrite.ts:176-179, :251, :453`; delete/kind via `services/orgNames.ts:164-168` |
| Error table (plan 3.5) - every code is raised where stated | CONFORMS | 400 name codes `services/orgNames.ts:97-100`; notes `:251, :277`; taken/compound `:101-107`; spelling codes `:112-133, :302`, `orgRewrite.ts:321`; in use `organizations.ts:122`; not found `services/orgNames.ts:156`, `orgRewrite.ts:139`, `organizations.ts:104`; running `services/orgNames.ts:143`; not rerunnable `orgRewrite.ts:451, :454`; target gone `:467, :479`; name variant `:361`; full/busy `services/orgNames.ts:149-150`; one change `organizations.ts:234` |

## E. Behavior by surface (section 7)

| Surface | Status | Evidence |
|---|---|---|
| Tenant edit form: HA + Agency pickers; help text "The organization that runs the voucher"; orgVocabulary replaced | CONFORMS | `ContactEditForm.tsx:545-590` (hint `:547`); orgVocabulary.ts deleted |
| Property New/Edit: HA multi-picker, HA only, legacy members as "Not on the list" chips | CONFORMS | `ListingEditForm.tsx:47-56, :245-261`; `UnitCreateForm.tsx:66-74, :326-342` |
| Blast composer: picker without add; commits only on pick/clear; 422 at create or Preview asks for a new pick | CONFORMS | `AudienceFilters.tsx:62-70, :118-130`; `BroadcastComposer.tsx:123-135, :342-345` |
| Contact suggestions (AI): D8 | CONFORMS | table B, D8 rows |
| Importer: D9 | CONFORMS | table B, D9 rows |
| Settings: D10-D13 | CONFORMS | table B (one PARTIAL, R1-CONF-1) |
| Missed-call intake text: D15 | CONFORMS | table B, D15 |
| Tenants page, Properties summary, flyer, similar units: unchanged code | CONFORMS | no diff to tenantFacets.ts, unitListFacets.ts, FlyerPage, similarUnits.ts |
| Seeds: every seed uses list names incl. broadcast filters; slug map as specified; seeds write the item | CONFORMS | `seed/orgList.ts:28-39`; `matrix.ts:82-89, :1227, :1260`; `performance.ts:569, :592`; `lean.ts:536`; `seedOrgNames.test.ts` |
| e2e: free-text/run-unique names via the list or POST /api/organizations; "Not on the list" via `POST /__dev/org-fixture`; nothing off-list seeded | CONFORMS | `e2e/fixtures/orgFixture.ts`; `org-lists.spec.ts:493-664`; `dev.ts:1213-1262` |

## F. The cleanup script (section 8)

| Requirement | Status | Evidence |
|---|---|---|
| `app/scripts/clean-org-names.ts`, modeled on enable-conversation-automation | CONFORMS | file exists; failure model mirrors `enable-conversation-automation.ts:53-59` |
| `--env local\|dev\|prod`, `--lane` local only, `--apply`; unknown/repeated args exit 2 | CONFORMS | `clean-org-names.ts:797-810`; `scripts/lib/stageClient.ts:186-212` |
| Target guards through stageClient | CONFORMS | `clean-org-names.ts:815-822` |
| List: stored item, else the starting list; dry run never writes; apply creates the item create-only | CONFORMS | `clean-org-names.ts:601-604`; lock via `acquireForCleanup` -> `mutate` -> create-only `get()` (`:511`) |
| Reads every contact (all types) and every unit, deleted included, base tables | CONFORMS | `clean-org-names.ts:481-499, :632-638, :682` |
| Each write conditional; audit `org_name_cleanup {field,from,to}` | CONFORMS | `clean-org-names.ts:668-677, :706-715` |
| Value resolving to one entry of its kind -> exact name | CONFORMS | `clean-org-names.ts:172-187` |
| HA value naming one agency -> move when agency absent or '' (remove HA), else conflict | CONFORMS | `clean-org-names.ts:188-203` (same-agency = compatible, plan 3.8) |
| List member: HA -> rewrite; agency -> drop unless it empties the list (then kept + counted); de-duplicate; no `updated_at` | CONFORMS | `clean-org-names.ts:258-292`; `unitsRepo.rewriteAcceptedAuthorities` |
| Legacy `jurisdiction`-only unit -> backfill resolved or raw value | CONFORMS | `clean-org-names.ts:233-250` |
| Everything else left; dry run prints per field each distinct value with its count (no people) and every change count | PARTIAL | `clean-org-names.ts:146, :172, :183, :259, :772-794`; whitespace-only values are never reported - see R1-CONF-1 (RG-5 count added `:353-359, :642-644, :790-792`) |
| Reporting: done line; PARTIAL + exit 1 on abort; COMPLETED WITH FAILURES + exit 1; re-run safe | CONFORMS | `clean-org-names.ts:528-540, :724-742, :831-842` |
| Lock: cleanup action, heartbeat, done/failed, refuse while running, release on abort/failure, stale after 15 min, no Run again, dry run takes none | CONFORMS | `clean-org-names.ts:507-526, :542-561, :566-586, :618-629`; `orgCopy.ts:331-334` |
| Order in RUNBOOK (dry run before deploy from main; review with Sam; deploy; apply right after; settle; dev first; agents on lanes only) | CONFORMS | `RUNBOOK.md:420-443` (steps `:430-434`) |

## G. Invariants, writers, readers (section 9)

| Item | Status | Evidence |
|---|---|---|
| I1 every value written after the deploy is on the list | DEVIATES-BY-RULING (plan section 12 accepted races; worklist RB-4, RG-1, RG-3, RG-4) | each residual leaves at most an off-list value that surfaces in "Not on the list"; stated exception: the dev seam |
| W contacts PATCH (housingAuthority, agency) | CONFORMS | `contacts.ts:1560-1582` |
| W contacts POST keeps ignoring the fields | CONFORMS | `contacts.ts:782-861` (no org keys); pin `contactOrgNames.test.ts:157-158` |
| W contacts restore / units restore (no check, stated) | CONFORMS | unchanged |
| W units POST and PATCH | CONFORMS | `units.ts:457-470, :1385-1411` |
| W broadcasts POST, preview, filter send | CONFORMS | `broadcasts.ts:562-570, :647-655, :879-884` |
| W AI apply layer and suggestion accept | CONFORMS | `extraction/apply.ts:268-300`; `suggestionResolution.ts:328-355` |
| W importer, contact and unit sides | CONFORMS | `import/apply.ts:1134, :1140, :1480` |
| W public intake routes write none of the fields | CONFORMS | `routes/public.ts` holds no housingAuthority/agency |
| W seeds (lean, cast, matrix, live, performance) + dev reseed | CONFORMS | table E seeds row; `devReset.ts:106-111` (seed put covers the window) |
| W dev seam (stated exception, local only) | CONFORMS | `dev.ts:1213-1262` |
| W rewrite job and cleanup script | CONFORMS | tables B (D11), F |
| W (B) Make caseworker / Caseworker choice | CONFORMS (not built, correct) | no KindPicker / contactKinds diff |
| R audienceResolution + preview/send | CONFORMS | unchanged |
| R Tenants facets; Properties summary + facets; flyer; similarUnits | CONFORMS | unchanged |
| R AI current-profile context + the list block | CONFORMS | `prompt.ts:175-187` |
| R AI run log (fingerprint header, drop reason label, System Status unchanged) | CONFORMS | `AiRunDetail.tsx:18-25, :70`; `api/types.ts:313` |
| R missed-call check + Templates hint | CONFORMS | table B, D15 |
| R property Activity labels for `org_name_rewrite` / `org_name_cleanup` | CONFORMS | `units.ts:198-228` passes string `from`/`to`; `listingFormat.ts:213-222` |
| R contact header, tenant file, tour and placement pages | CONFORMS | unchanged |

## H. Rollout (section 11)

| Requirement | Status | Evidence |
|---|---|---|
| No Terraform, table, index, env var, secret or switch | CONFORMS | `git diff --name-only d839494a..HEAD` touches no infra/, *.tf, config.ts, tables.ts, .env*, package*.json; no added `process.env` / `import.meta.env` read |
| Item creates itself on first read | CONFORMS | `orgListRepo.ts:166-192` |
| Cleanup dry run before, apply after the deploy; RUNBOOK sections for the cleanup and "Run again" | CONFORMS | `RUNBOOK.md:420-443` ("Run again" `:440`) |
| Cameron runs dev/prod; agents only on lanes | CONFORMS | no evidence of a dev/prod run; the lane rehearsal was skipped by U15 and is owed as self-QA (progress.md) |

## I. Plan section 1 "must NOT do" and D16-D21

| Item | Status | Evidence |
|---|---|---|
| No table / GSI / env var / Terraform | CONFORMS | table H |
| No list cache | CONFORMS | table B, D1 |
| No org ids on records | CONFORMS | every writer stores names |
| No broadcast rewrites | CONFORMS | table B, D11 |
| AI adds no names, fills no Agency | CONFORMS | table B, D8 |
| No caseworker feature (D16-D21: Caseworker choice, `organization`, Caseworkers tab, possible caseworkers, partner shares, `type_source`, thread re-typing) | CONFORMS | no diff to KindPicker.tsx, contactKinds.ts, broadcastFanOut.ts, PartnerFile; added-line grep finds no `type_source` / `caseworker_review` / `organization` field |
| No deploy; no cleanup run against dev/prod | CONFORMS | nothing in records or logs indicates either |

## J. Orchestrator rulings (worklist.md)

| Ruling | Applied as ruled? | Evidence / spec relation |
|---|---|---|
| RG-1 journal replay - accepted residual, no code change | CONFORMS | journal replay unchanged; only `buildPlan` reads the list (`suggestionResolution.ts:784-790`). Spec: consistent with D8's replayable plan; it is a rare exception to I1's letter (recorded in table G). Handback must name it (S17, not yet written) |
| RG-2 dismissal aliases on the suggest path only | CONFORMS | `extraction/apply.ts:280-288, :825-858`; tests `extractionApply.test.ts:1435-1500`. Spec: keeps D8's "exactly as a known authority is today" |
| B-1 updateSpellings probes the entry as it will be | CONFORMS | `services/orgNames.ts:303-317` (3a0c9bdd). Spec: D12 + D4 |
| B-2 Run again refuses a from-text that became a listed name | CONFORMS | `orgRewrite.ts:469-479`; copy `orgCopy.ts:131-132`. Spec: stricter than D11's letter, consistent with D10/D11 intent (recorded as DEVIATES-BY-RULING in table B) |
| B-3 only spellings unique to the entry extend the dismissal keys | CONFORMS | `extraction/apply.ts:283-288`; tests `extractionApply.test.ts:1506-1530` |
| U1, U2 accepted minors - no change | CONFORMS | `orgNames.ts:264-266`; `orgRecords.ts:286, :327` unchanged (table B rows) |
| Accepted residual races RB-4, RG-3, RG-4, RG-1 - documentation | CONFORMS (owed) | no code change; the handback list is S17 work, not yet produced |
| RD-1 test comment names no retired path | CONFORMS | `orgStartingList.test.ts:96-98` |
| RA-1, RA-2, RB-1, RB-2, RB-3, RC-1, RD-2, RD-3, RD-4, RE1-1, RE1-2, RE1-6, RF-4 (process / RED notes) | CONFORMS | outcomes visible: no duplicate harness key (typecheck green), test blocks present, whole e2e run by the orchestrator (g4 320 passed) |
| RD-5 "Verifies four things" | CONFORMS | `seedProfile.integration.test.ts:3` |
| RD-6 (optional) export + comment | CONFORMS | `live.ts:103`; `seedUnreadFlag.test.ts:18-22` |
| RE1-3 `within` import in UnitCreateForm.test.tsx | CONFORMS | `UnitCreateForm.test.tsx:1` |
| RE1-4 stale comment refreshed | CONFORMS | `UnitCreateForm.test.tsx:102-104` |
| RE1-5 > 120 chars: no /check, "Cannot add it" | CONFORMS | `NewOrgDialog.tsx:119-126`; test `NewOrgDialog.test.tsx:114` |
| RE2-1 issue sentence | CONFORMS | `perf-pages-settings-organizations-surface.md:28-29` |
| RE2-2 `overflow-wrap: anywhere` | CONFORMS | `AiRunsSection.module.css:18` |
| RE2-3 notice cleared by later clean actions | PARTIAL | literal steps done (`OrgListSection.tsx:168-172, :324-331`), but "Add" keeps a stale notice (`:307-310`) - see R1-CONF-2 |
| RE2-4 test names / header comment | CONFORMS | `settingsTabs.test.ts:3-5, :47`; `SettingsPage.test.tsx:74` |
| RE2-5 not adopted | CONFORMS | poll unchanged (`useOrgAdmin.ts:110`) |
| RF-1 retire-humanize-authority wording | CONFORMS | `docs/issues/retire-humanize-authority.md` Progress 2026-10-07 |
| RF-2 contact-authority-clear-empty-string-500 resolved | CONFORMS | frontmatter + Resolution paragraph |
| RF-3 INDEX.md never staged | CONFORMS | not in the diff |
| RF-5 unit-accepted-authorities-edge-cases update | CONFORMS | Update 2026-10-07 paragraph |
| RF-6 GLOSSARY wording (a), (b) | CONFORMS | `GLOSSARY.md:271-291, :340-353` |
| RF-7 selectors.md wording | CONFORMS | `e2e/support/selectors.md` Settings row ("`exact` because `getByRole` name matching is substring by default") |
| RG-5 contacts missing type/status counted and printed | CONFORMS | `clean-org-names.ts:353-359, :640-644, :788-792`; test `cleanOrgNames.test.ts:367` |
| RG-6 RUNBOOK "Clayton County" sentence | CONFORMS | `RUNBOOK.md:431`; consistent with spec section 13 (a data caveat, not a mapping change) |

---

## Findings

### R1-CONF-1 | LOW | D10 + section 8: whitespace-only stored values are invisible

- Spec: D10 "Not on the list: every distinct stored value ... that is not on
  the list for its field"; section 8 "Everything else ... is left exactly as
  it is. The dry run prints, per field, each such distinct value with its
  count". Under D3 a stored `" "` is not on the list, and D4 resolves blank
  text to `unknown`.
- Code: `app/src/services/orgRecords.ts:443-447` skips a contact
  `housingAuthority`/`agency` that is whitespace-only, and `:455` skips blank
  list members; the cleanup's `isText` (`app/scripts/clean-org-names.ts:146`)
  makes `planContact` (`:172`, `:183`) and `planUnit` (`:259`) treat them as
  nothing to report, and the RG-5 count (`:642`) does not count them either.
  Not covered by any ruling (U2 covers Move/Split only); the code comment
  justifies it as pre-2026-07-14 data that no request can name.
- Consequence: a pre-trim value such as a `housingAuthority` of `" "` (a
  byHousingAuthority key) on a non-tenant or deleted contact is shown nowhere
  and cannot be settled; a tenant's can be removed only by spotting a blank
  chip on its own form. Very likely zero rows in prod, but nothing tells
  Cameron so before the deploy.
- Fix (smallest): count such records in the cleanup (a `blankValues` counter
  beside `contactsMissingTypeOrStatus`, printed on the summary's last lines,
  expected 0) so the pre-deploy dry run proves there are none; the apply may
  REMOVE a blank `housingAuthority` and set a blank `agency` to `''` under the
  same conditional write. Or accept it explicitly in the handback as a
  deviation from D10's "every".

### R1-CONF-2 | LOW | Ruling RE2-3 only partly achieves its purpose: a stale notice survives "Add"

- Ruling RE2-3: clear the page notice so "a stale notice ... [does not]
  survive later clean actions". The two literal steps are done
  (`dashboard/src/routes/settings/OrgListSection.tsx:168-172`,
  `:324-331`), but the Settings "Add housing authority / Add agency" path
  (`:307-310`) closes the dialog and reloads without `setNotice(null)`, so a
  "Not kept as a spelling: ..." notice from an earlier rename or settle
  stays on the page after a successful add. The orchestrator recorded it as a
  fix-wave nit (progress.md 01:36) and U16 filed
  `docs/issues/org-settings-notice-stale-after-add.md`.
- Fix: add `setNotice(null)` to the NewOrgDialog `onAdded` handler at
  `OrgListSection.tsx:307-310`, one test beside the RE2-3 tests
  (`OrgListSection.test.tsx:425-480`), and close the issue in the same change.

---

## Notes (no action required for conformance)

- The cleanup's `done` lock stores the script's own counters
  (`flatCounts`, `clean-org-names.ts:440-451`), so after an apply the Settings
  status line lists every non-zero counter, scan totals included
  (`orgCopy.ts:376-397`). Spec 5.1 only says "counts"; the orchestrator
  already listed this for self-QA together with the owed lane rehearsal of
  the script (`--env local --lane L`, dry run then `--apply`).
- Error paths the spec does not dictate: the job logs and continues when an
  `org_name_rewrite` audit append fails after the record write landed
  (`orgRecords.ts:524-528`), while the cleanup aborts on the same failure
  (RUNBOOK `:433` documents the one-record gap). Both keep the record write;
  the asymmetry is a design choice, not a conformance gap.
- DELETE and kind change run the in-use scan before the lock check
  (`organizations.ts:288, :301`), so while a rewrite runs a used entry answers
  409 `org_in_use` rather than `org_rewrite_running` (both 409; recorded by
  the orchestrator at 23:06).
- e2e leaves these D10-D11 paths to unit/API tests only (U14 report): merge,
  delete, kind change, spelling edits and the shared confirm, Move to Housing
  authority, Add as new, Run again, the composer's 422 re-pick, the other-kind
  message, Dismiss of an agency suggestion. All are covered by
  `organizationsApi.test.ts`, `orgRewriteService.test.ts`,
  `NotOnListSection.test.tsx`, `OrgListSection.test.tsx`,
  `BroadcastComposer.test.tsx` and `ContactDetail.test.tsx`, which I ran green.
- The handback (S17) still owes the residual-race list (plan section 12's two
  plus RB-4, RG-1, RG-3, RG-4) and the gate-5 baseline names.
