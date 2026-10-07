# Final spec-conformance review - feat/clean-org-names (branch A)

- Reviewer: independent spec-conformance reviewer (Opus 5.5), read-only. No test,
  vitest, Playwright, e2e or server was run. Code cited by file:line in the
  worktree at 7be31184 (last source commit 4b777d26; merge-base = main =
  a5eabcb3, so the branch is 0 behind main).
- Contract: spec `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  rev 8 (D1-D15, sections 5-9, 11); plan sections 2-3 (BINDING interfaces);
  handback claims checked against code, not taken as fact.
- The three diff packages cover exactly the branch's 182 non-records files
  (file lists compared one to one).

## Counts

88 rows: **SHIPPED 81 / PARTIAL 2 / MISSING 0 / DEVIATED 5**. No BLOCKING,
HIGH or MEDIUM row. Every non-SHIPPED row is LOW and every DEVIATED reason
holds against the code. Nothing from D16-D21 was built.

## Section 4 - decisions D1-D15

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| D1 one `settings` item `org-list`, sibling repo, read-and-bump with retry, no cache | SHIPPED | `app/src/repos/orgListRepo.ts:158` key, `:162` ConsistentRead GetItem, `:196-221` version-conditioned Put, 5 attempts then OrgListBusyError; `app/src/services/orgNames.ts:226-241` reads per call | | No cache anywhere (dashboard re-reads per mount, `useOrgList.ts:102-109`) |
| D2 first read seeds create-only; seeds overwrite unconditionally | SHIPPED | `orgListRepo.ts:166-192` (attribute_not_exists, loser re-reads); `app/src/lib/seed/orgList.ts:43-55`; `seed/lean.ts:536`; plain Put `seed/index.ts:153`; reseed window note `lib/devReset.ts:106-111` | | Full profile = lean + cast/matrix/live, so both profiles write it; perf reseed resets lean first |
| D3 records hold exact name; on-list and use = exact name of an accepted kind | SHIPPED | `app/src/lib/orgNames.ts:26-31, :55-61`; usage keyed per kind `services/orgRecords.ts:403-433`; not-on-list uses the field's kinds `:456, :466` | | Agency name in an HA field is neither on the list nor a use |
| D4 matching (normalize, name, spelling within kinds, ambiguity, other kind, compound longest-span, close prompt-only, uniqueness) | SHIPPED | `lib/orgNames.ts:42-49, :78-96, :119-148, :187-216` (no scoring past 120 chars `:192`); uniqueness via `checkNewName :330-347`, `checkSpelling :368-390`; tests `app/test/orgStartingList.test.ts:44-111`, `app/test/orgNames.test.ts:109-121` | | Appendix A rows, Sam's county mappings and the D4 examples are pinned |
| D5 one server check for every writer; 422 `org_not_on_list {field,text,candidates,close,otherKind?,compound?}`; clear rules; list members; scripts REMOVE | SHIPPED | `lib/orgNames.ts:238-309`; contacts PATCH `app/src/routes/contacts.ts:1467-1470, :1560-1585` (HA '' -> null REMOVE `:638-642`); units `routes/units.ts:457-470, :1385-1411`; machine REMOVE `repos/contactsRepo.ts:1672-1737` | | Legacy `jurisdiction` passes only while no list is stored (`units.ts:1391-1397`) |
| D5 "checked only when its value changes" | DEVIATED | `lib/orgNames.ts:264-266`, `contacts.ts:1571` compare the trimmed request text to the raw stored text | LOW | Handback 9 (U1): "a padded legacy value re-sent by an API caller is checked as a new value". Holds: bodies are trimmed (trimJsonBody) and the dashboard never sends an unchanged field, so only a raw API caller re-sending a padded legacy value can meet it |
| D6 pickers with add step, "Is this really new?", other-kind offer, off-list chip, unchanged never fails | SHIPPED | `dashboard/src/routes/orgs/OrgPicker.tsx:130-154` (names + spellings; AHA lists both), `:231-240` add only when nothing matches, `:361-365` "Not on the list" chip, `:463`; `orgs/NewOrgDialog.tsx:134-153, :244-298` (resolution, close names first as "Use <name>", other kind, compound); tenant form `routes/contact/ContactEditForm.tsx:592-644, :926-953` ("Put it in Agency" `:939`); property forms `listing/ListingEditForm.tsx:268-292, :580`, `listing/UnitCreateForm.tsx:354-378, :610` (no other-field offer = HA only) | | Spellings never added from a form |
| D7 composer picker without add; commit only on pick/clear; stored filter re-checked at draft preview and filter-resolved send; curated send not re-checked; broadcasts never rewritten | SHIPPED | `routes/broadcasts/AudienceFilters.tsx:142-160` (no `onRequestAdd`); `app/src/routes/broadcasts.ts:467-491` (resolved-but-not-exact lists its entry as the one candidate), POST `:561-570`, preview `:647-656`, send `:879-884`; 422 re-pick `BroadcastComposer.tsx:61, :130-138, :360-363`, `useComposerDraft.ts:228-236` | | PATCH broadcasts writes seeds only (`broadcasts.ts:1056-1085`), so POST is the only filter writer |
| D8 AI: static system prompt, list block in user content, fingerprint, 16,000 budget with WARN, model rules, apply-layer resolution, `agency_not_authority`, accept `value` + `valueKey` | SHIPPED | `services/extraction/prompt.ts:13-67, :186-187`; `orgListBlock.ts:80-163`; `jobs/extraction.ts:563-586, :618`; `extraction/apply.ts:268-299`; `runTypes.ts:39`; `repos/aiRunsRepo.ts:58`; `services/suggestionResolution.ts:221-243, :266-268, :328-353, :757, :785, :821`; `repos/suggestionResolutionRepo.ts` resolutionValueKey (sha256); `routes/suggestions.ts:85-91, :160-170, :231`; dashboard `ContactDetail.tsx:733-795, :1188-1205`; header `settings/aiRuns/AiRunDetail.tsx:70`; label `api/types.ts:313` | | Value check runs before the claim; verdict stays `accepted` (`suggestionResolution.ts:647`). RG-1 replay residual: see I1 |
| D9 importer: same check, fill-only contacts, agency from HA column, units resolved names only, report incl. dry run, CLI peeks | SHIPPED | `app/src/lib/import/apply.ts:979-1014, :1134, :1140, :337, :509, :1480`; `app/scripts/import-apply.ts:366-385, :403, :446-458` | | |
| D10 Settings tab for everyone: two lists (name, spellings, notes, counts + deleted), Not on the list (value, field, count, resolution, Show records), name-variant row offers only Use, permissions, admin actions | SHIPPED | `dashboard/src/routes/settings/settingsTabs.ts:33-38`, `App.tsx:233`; `OrgListSection.tsx:64-135, :112, :196-253, :291`; `orgs/orgCopy.ts:564-568` ("+N deleted"); `NotOnListSection.tsx:63-107` (variant -> only Use `:66-72`), `:153-210`, `:224-446` (Remember this spelling `:240-280`); server gates `app/src/routes/organizations.ts:240-243, :298, :309, :323, :368`; `services/orgRecords.ts:276-358` (Use/Move/Split/Clear) | | Plan 3.8 same-agency-name rule treated as compatible (`orgRecords.ts:303-311`) |
| D10 Not on the list = EVERY distinct stored value | PARTIAL | `services/orgRecords.ts:455, :463` skip whitespace-only values | LOW | Handback 9 (U2/R1-CONF-1). Such values are pre-2026-07-14 data no request can name; the cleanup counts them (`recordsWithBlankValues`, expected 0, RUNBOOK says report non-zero) |
| D10 Move/Split write "where agency is absent or ''" | DEVIATED | `orgRecords.ts:294, :312, :335` count a whitespace-only target as a conflict | LOW | Handback 9 (U2): "Move/Split count a whitespace-only target field as a conflict". Holds (record left unchanged, counted). Note the cleanup treats the same case as free (`app/scripts/clean-org-names.ts:217`) - see Other 2 |
| D10 "everyone can add an entry" | DEVIATED | `services/orgNames.ts:178-183, :273` | LOW | Handback 4 (A1): add "is refused 409 org_rewrite_running ONLY when the new name collides with a running rewrite's from-texts". Holds: the pass compares normalized text with no list, so it would rewrite the new exact name away (D3/I1); all other adds go through |
| D11 rewrite job: one at a time; id minted before ONE list write; enqueue with id; enqueue failure -> failed; Run again (not cleanup); byTypeStatus + unit scan incl. deleted; fields fixed; conditional per record; dedupe; Clear REMOVEs; no unit updated_at; audit per field; no broadcasts; from-texts; merge transfer + cap; rename keeps old name; id-checked heartbeat/finish; never rethrows | SHIPPED | `services/orgRewrite.ts:244-247, :250-263, :298-319, :322-340, :348-361, :364-440, :547-571`; `orgRecords.ts:367-400, :501-617` (dedupe `:578`, skip-target `:561`); `repos/unitsRepo.ts:972-1000` (no updated_at `:986`); `jobs/orgRewrite.ts:119-182`; `jobs/registerHandlers.ts:97`, pinned `app/test/registerHandlers.test.ts:26` | | |
| D11 Run again re-checks only that target names still exist with the expected kind | DEVIATED | `orgRewrite.ts:213-234, :561-563`; UI `orgs/orgCopy.ts:484-492` (no Run again for an "outgrown" failed rewrite) | LOW | Handback 3 (B-2): refuses "when a from-text has since become a listed name - stricter than D11's literal text, same intent". Holds: such a pass would rewrite every exact holder of the now-listed name (the D10 name-variant hazard). Hiding Run again for a claim-refused rewrite (R3-BE-4) follows from it |
| D12 spellings curated; admin edit refusals; same-kind share needs confirm; automatic additions skip and are named; rename rule | SHIPPED | `services/orgNames.ts:303-341`; `lib/orgNames.ts:368-390`; `orgRewrite.ts:370-390, :527-539`; dashboard `settings/OrgEntryDialogs.tsx:124-266`, `orgs/orgCopy.ts:340-342, :385-391` | | |
| D13 limits: name 120, no control char, not normalizing to ''; notes 500; 20 spellings x 120; compound new name refused pointing to Split; 300 KB `org_list_full` | SHIPPED | `lib/orgNames.ts:33-36, :330-347, :368-390`; `services/orgNames.ts:64-92, :266, :294, :319`; `orgListRepo.ts:78, :202`; `NewOrgDialog.tsx:292-298`; `orgCopy.ts:356-363` | | |
| D14 cleanup applies automatic mappings only; no merge mode, no decisions file | SHIPPED | `app/scripts/clean-org-names.ts:183-326, :915` | | |
| D15 agency counts as an intake fact; hint; issue doc | SHIPPED | `app/src/jobs/missedCallAutoText.ts:85-91`; `dashboard/src/routes/settings/TemplatesSection.tsx:216-218` (+ test); `docs/issues/missed-call-autotext-partial-intake.md` | | |

## Section 5 - data model

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| 5.1 `org-list` item shape (version, entries, lastRewrite with fields, counts, ...) | SHIPPED | `orgListRepo.ts:36-75`; `lib/orgNames.ts:9-21` | | Adds `lastRewrite.error?` (plan 3.2) |
| 5.2 `contact.housingAuthority` (any type): D5 when set, '' REMOVEs | SHIPPED | `contacts.ts:638-642, :1560-1585` | | |
| 5.2 `contact.agency` (any type): D5 when set, '' stored | SHIPPED | `contacts.ts:648-652, :1565-1582` | | |
| 5.2 `unit.accepted_authorities[]`: new members checked, trimmed, de-duplicated | SHIPPED | `units.ts:457-470, :1385-1411`; `lib/orgNames.ts:285-309` | | |
| 5.2 broadcast `audience_filter.housing_authority`: POST checked, preview + filter send re-check | SHIPPED | `broadcasts.ts:561-570, :647-656, :879-884` | | |
| 5.2 legacy `jurisdiction`/`accepted_programs` tombstones unchanged; cleanup backfills | SHIPPED | tombstone path untouched in `units.ts`; backfill `clean-org-names.ts:258-276` | | |

## Section 6 - API

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| GET /api/organizations -> lists + lastRewrite | SHIPPED | `organizations.ts:127-137` | | |
| GET /usage | SHIPPED | `organizations.ts:139-145` | | |
| GET /not-on-list (everyone) | SHIPPED | `organizations.ts:147-153` | | |
| GET /not-on-list/records?field=&value= (everyone) | SHIPPED | `organizations.ts:155-170`; `orgRecords.ts:478-499` | | |
| POST /check: resolution shape; >200 chars 400; close only up to 120 | SHIPPED | `organizations.ts:172-200` (`:190-193`); `services/orgNames.ts:243-262`; `lib/orgNames.ts:192` | | |
| POST / add; 409 `org_name_taken` returning the entry | SHIPPED | `organizations.ts:202-224`; `services/orgNames.ts:101-102, :264-290` | | |
| PATCH /:orgId notes (everyone) / spellings, name, kind (admin); name starts rename; kind 409 `org_in_use` | SHIPPED | `organizations.ts:226-294, :116-123` | | |
| POST /:orgId/merge (admin) | SHIPPED | `organizations.ts:307-319` | | |
| DELETE /:orgId (admin), 409 `org_in_use` | SHIPPED | `organizations.ts:296-305` | | |
| POST /not-on-list/resolve (admin), names skipped spellings | SHIPPED | `organizations.ts:321-364`; `orgRewrite.ts:442-545` | | |
| POST /rewrite/run-again (admin) | SHIPPED | `organizations.ts:366-372` | | |
| Suggestions accept `value`; 422 `value_not_from_suggestion`; 409 `suggestion_already_resolved` | SHIPPED | `suggestions.ts:85-91, :160-170`; `suggestionResolution.ts:233, :267, :757, :821` | | |
| Existing writers answer 422 `org_not_on_list`; rewrite-starting endpoints 409 `org_rewrite_running` | SHIPPED | see D5/D7; `services/orgNames.ts:142-144`; `orgRewrite.ts:244-247, :557` | | |

## Section 7 - surfaces (branch A)

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| Tenant edit form: Housing authority + Agency pickers, help text | SHIPPED | `ContactEditForm.tsx:594-644` (hint `:599`) | | Hint reads "...voucher." with a trailing period (Other 3) |
| `orgVocabulary.ts` replaced by the stored list | SHIPPED | file deleted; no reference remains in dashboard/app/e2e | | Also retired: `lib/housingAuthority.ts`, `HOUSING_AUTHORITY_VOCAB` |
| Property New/Edit: HA multi-picker, HA only, legacy members as chips | SHIPPED | `ListingEditForm.tsx:268-292`; `UnitCreateForm.tsx:354-378` | | |
| Blast composer: picker without add; filter changes only on pick/clear; 422 asks for a new pick | SHIPPED | see D7 | | |
| Contact suggestions (AI) | SHIPPED | see D8 | | |
| Importer | SHIPPED | see D9 | | |
| Settings D10-D13 | SHIPPED | see D10-D13 | | |
| Missed-call intake text D15 | SHIPPED | see D15 | | |
| Tenants page, Properties summary, flyer, similar units unchanged | SHIPPED | no diff in `dashboard/src/routes/contacts`, `routes/listings`, `routes/public`, `app/src/lib/unitFields.ts`, `app/src/lib/similarUnits.ts` | | |
| Seeds: list names everywhere, slugs retired per the map, item written | SHIPPED | `seed/orgList.ts:29-40` (map matches spec 7); `seed/lean.ts`, `cast.ts`, `matrix.ts`, `live.ts`, `performance.ts` use `SEED_AUTHORITY`; no slug left in `app/src` | | |
| e2e specs that type or mint names pick list names / add via POST first | SHIPPED | `e2e/tests/dashboard-next/contacts-list-facets.spec.ts` (addOrg), `contact-detail.spec.ts` (pickOrgName), `e2e/scenarios/steps.ts` (pickOrgName) | | 17 specs still POST the retired slug through the API (Other 1) |
| Dev seam `POST /__dev/org-fixture` (dev router only, run-unique values on spec-created records) | SHIPPED | `app/src/routes/dev.ts:1213-1258`; mounted only via `lib/devRoutes.ts:20-23`; `e2e/fixtures/orgFixture.ts` | | |

## Section 8 - cleanup script

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| `--env/--lane/--apply` via stageClient; unknown/repeated args exit 2 | SHIPPED | `clean-org-names.ts:915-940`; `app/scripts/lib/stageClient.ts:186-212` | | |
| List used: stored item, else starting list; dry run never writes; apply creates create-only | SHIPPED | `clean-org-names.ts:666-676`; apply creates through the lock's `mutate -> get` (`orgRewrite.ts:577-593`) | | |
| Reads every contact and unit incl. deleted from base tables | SHIPPED | `clean-org-names.ts:544-562, :727, :779` | | Pointer rows skipped `:730-733` |
| Apply mappings (resolve, move agency, unit members, legacy backfill), conditional writes, `org_name_cleanup {field,from,to}` | SHIPPED | `clean-org-names.ts:183-326, :767-775, :806-815, :714-724` | | Same-agency-name compatible (plan 3.8) `:217` |
| Everything else left; dry run prints each leftover value per field with counts + change counts | PARTIAL | `clean-org-names.ts:879-912` | LOW | Whitespace-only values (D4 "unknown") are counted (`recordsWithBlankValues`, `:903-905`) but not listed per value - same root as the D10 PARTIAL (R1-CONF-1); expected 0 |
| Reporting: done line; PARTIAL + exit 1 on abort; COMPLETED WITH FAILURES + exit 1; re-run safe | SHIPPED | `clean-org-names.ts:595-630, :822-849, :942-963` | | |
| Lock: action `cleanup`, heartbeat, done/failed, refuses while held, abort releases, dry run no lock, never Run again | SHIPPED | `clean-org-names.ts:575-593, :603-605, :609-628, :691-708`; `orgCopy.ts:489-492, :547` | | |
| Order in RUNBOOK; agents only on lanes | SHIPPED | `RUNBOOK.md:420-438` | | |

## Section 9 - invariants, writers, readers

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| I1 every value written after the deploy is on the list | DEVIATED | each writer below applies D5; residual windows listed in handback "Accepted residual races" | LOW | Handback: "each leaves at most an off-list value that surfaces in 'Not on the list', where Use settles it" (RB-4 check-then-write, R2-BE-5 whole-list SET vs a rewrite, RG-3 one list read per AI run/import - which D8/D9 prescribe, RG-4 byTypeStatus walk, RG-1 journal replay). Holds: same class D11 itself accepts (index lag "can be missed, and then shows in Not on the list"). RG-1 is Cameron's open question 1 |
| W contacts PATCH (housingAuthority, agency) | SHIPPED | `contacts.ts:1560-1585` (consistent pre-read `:1467-1470`; 422 writes nothing) | | |
| W contacts POST ignores the fields | SHIPPED | parser `contacts.ts:782-871` has no HA/agency; pin `app/test/contactOrgNames.test.ts:157-170` | | |
| W contacts + units restore (stated exception) | SHIPPED | restore routes untouched (`contacts.ts:2315-2336`) | | |
| W units POST + PATCH | SHIPPED | `units.ts:457-470, :1385-1411` | | |
| W broadcasts POST, preview, filter send | SHIPPED | `broadcasts.ts:561-570, :647-656, :879-884` | | |
| W AI apply layer | SHIPPED | `extraction/apply.ts:268-299` (writes/suggests the entry name; agency dropped) | | |
| W suggestion accept | SHIPPED | `suggestionResolution.ts:221-243, :328-353` | | |
| W importer contact + unit sides | SHIPPED | `import/apply.ts:979-1014, :1134-1144, :1480` | | |
| W public intake routes (write nothing) | SHIPPED | `app/src/routes/public.ts` has no housingAuthority/agency write | | |
| W seeds incl. seeded broadcasts + dev reseed | SHIPPED | `seed/matrix.ts` filters use `SEED_AUTHORITY`; `seed/lean.ts:536`; `devReset.ts:106-111` | | |
| W dev seam (stated exception, local only) | SHIPPED | `dev.ts:1213-1258` | | |
| W rewrite job | SHIPPED | `orgRecords.ts:501-617`; `jobs/orgRewrite.ts:119-182` | | |
| W cleanup script | SHIPPED | `clean-org-names.ts:655-819` | | |
| R audienceResolution + broadcast preview/send | SHIPPED | `services/audienceResolution.ts` unchanged (exact GSI on the stored name); re-check in `broadcasts.ts` | | |
| R Tenants page facets | SHIPPED | `dashboard/src/routes/contacts/tenantFacets.ts:127` unchanged - shows the stored name | | |
| R Properties summary + facets | SHIPPED | `dashboard/src/routes/listings/unitListFacets.ts:107, :139` unchanged | | |
| R flyer projection | SHIPPED | `app/src/lib/unitFields.ts` unchanged ("Accepts:" shows the list names records hold) | | |
| R similarUnits | SHIPPED | `app/src/lib/similarUnits.ts:104-131` unchanged | | |
| R AI current-profile context + list block | SHIPPED | `jobs/extraction.ts:154-155, :563-586` | | |
| R AI run log: fingerprint header, drop reason + label, System Status unchanged | SHIPPED | `AiRunDetail.tsx:70`; `api/types.ts:313`; `SystemStatusSection.tsx` no diff | | |
| R missed-call check + Templates hint | SHIPPED | see D15 | | |
| R property Activity labels `org_name_rewrite` / `org_name_cleanup` | SHIPPED | `dashboard/src/routes/listing/listingFormat.ts:213-222`; projection passes string from/to (`routes/units.ts:197-226`, unchanged) | | |
| R contact header, tenant file, tour and placement pages | SHIPPED | unchanged code; they render the stored text | | |

## Section 11 - rollout

| Row | Status | Evidence | Sev | Note |
|---|---|---|---|---|
| No Terraform, secrets, schema, index or env var | SHIPPED | no file under `infra/`; no diff in `app/src/lib/tables.ts` or `config.ts` | | |
| Dry run before the deploy, apply right after | SHIPPED | `RUNBOOK.md:422-436` | | |
| Item creates itself on first read | SHIPPED | `orgListRepo.ts:166-192` | | |
| RUNBOOK section for the cleanup and "Run again" | SHIPPED | `RUNBOOK.md:420-442` | | |
| Cameron runs dev/prod; agents only on lanes | SHIPPED | `RUNBOOK.md:438`; script header `clean-org-names.ts:43-47` | | |

## Interface drift (plan section 3)

| Item | Result |
|---|---|
| 3.1 new files | All 20 present. Extra: `dashboard/src/routes/orgs/useTypedOrgText.ts` (handback deviation 6). |
| 3.2 shared types, constants | Match (`orgListRepo.ts:36-79`, `lib/orgNames.ts`). |
| 3.3 repo API, factory | Match. Additive exports `ORG_LIST_MAX_ATTEMPTS`, `orgListItemBytes`; documented no-op when `change` returns the same object (`orgListRepo.ts:120-123, :200`). |
| 3.4 OrgNamesService, OrgCheckResult, OrgHttpError | Match. |
| 3.4 OrgRecordsService (HolderRecord, NotOnListRow, OrgUsage, rewrite) | Signatures match. Semantic tightening: heartbeat checked BEFORE each record (`orgRecords.ts:566, :591`), plan says after (R3-BE-1). |
| 3.4 OrgRewriteService | DRIFT (additive, LOW): extra `claim(jobId): Promise<OrgRewriteClaim>` (`orgRewrite.ts:123, :265-296`, R2-BE-1); `heartbeat` also answers false for a LAPSED lock (`:258`). Other methods and return shapes match. |
| 3.4b factories + wiring | Match: one `orgListRepo` and service set built in `routes/api.ts:716-723`, passed as `orgNamesService` to contacts/units/broadcasts/suggestions/organizations (`:784, :882, :978, :1100, :1212`); FakeWorld `orgListRepo` (`app/test/helpers/twilioWebhookHarness.ts`, `orgListFake.ts`). |
| 3.5 error table | Codes, statuses and extras match (`org_in_use {uses:{active,deleted}}` `organizations.ts:118-122`; `org_rewrite_running {lastRewrite}`; `org_list_busy` 503). DRIFT (LOW): add can answer 409 `org_rewrite_running` (A1, not in its "raised by"); `org_rewrite_target_gone` broadened (B-2); a few semantic refusals are 400 with prose `error`, no code - merge into another kind (`orgRewrite.ts:404-406`), resolve "nothing to settle" (`:455-457`), name/agencyName not an exact entry (`:467-475`). |
| 3.6 endpoints | Match: every path, admin gate, status (201/202/204) and body key. |
| 3.7 repo writers | Match (`contactsRepo.ts:822, :1672`; `unitsRepo.ts:442, :972`). Additive `unitsRepo.getById(id, { consistentRead })`. |
| 3.8 audit | Match: job payload `{field,from,to,action,actor}`, cleanup `{field,from,to}`, strings, one event per field, Move/Split two events; labels `listingFormat.ts:213-222`. |
| 3.9 jobs | Match. `ORG_REWRITE_JOB` declared in `services/orgRewrite.ts:67` and re-exported by `jobs/orgRewrite.ts:62` (import-cycle reason); claim-time re-validation of a lapsed lock records `failed` (A6). |
| 3.10 AI | Match (`renderOrgListBlock` signature and rules; `orgListBlock`, `orgListFingerprint?`, `orgEntries`, drop reason, `valueKey`). |
| 3.11 dashboard API | Match: 11 endpoint fns + `acceptSuggestion(..., value?)` (`api/endpoints.ts`); copy for every 3.5 code with parity tests (`orgs/orgCopy.ts:261-282`, `orgCopy.test.ts:61`, `api/types.test.ts`). `useOrgList` adds `poll` (additive). Labels unchanged. |
| 3.12 dev seam | Match (`{ ok: true }`, contact SET / unit append). |

## Branch B (D16-D21) - not built (confirmed)

No diff in `KindPicker.tsx`, `PartnerFile.tsx`, `services/extraction/contactKinds.ts`,
`jobs/broadcastFanOut.ts`; broadcast seeds stay tenant-only (`broadcasts.ts:434`);
`OrgRecordField` has no `organization` (`orgListRepo.ts:41`); no
`type_source`, `caseworker_review`, Caseworkers tab or Make caseworker in any
added code line (mentions are comments, issue text and test fixture names only).
GLOSSARY adds only branch A terms (`documentation/GLOSSARY.md:271-365`).

## e2e coverage

Covered by `e2e/tests/dashboard-next/org-lists.spec.ts` unless noted:

| Surface | e2e |
|---|---|
| Tenant pickers: AHA lists both names, add option, close name "Use", Yes add it (agency) | `:185` (+ `contact-detail.spec.ts` HADC pick) |
| Off-list chip kept through an unrelated save | `:241` |
| Property Edit multi-picker; off-list member kept then removed | `:267`; New-property picker via `e2e/scenarios/steps.ts:1657-1662` |
| Composer: no add step, commit only on pick, Preview waits for typed text | `:309`, `:438` |
| Typed text: committed when it names one entry; refused otherwise | `:372`, `:405` |
| VA views, adds an agency with notes, edits notes, no admin actions | `:500` |
| Admin rename -> job -> records + old name kept as spelling + Activity "Housing authority updated" | `:540` |
| Not on the list: rows, active/deleted counts, Show records links, VA 403 | `:605` |
| Use (name variant, Remember off), Move to Agency, Split, Clear | `:668` |
| AI: AHA candidate accepted (verdict accepted); unknown suggested + Yes add it + accept; agency dropped with label; fingerprint in run header | `:778`, `:807`, `:837` |

Unit/API-tested only - the handback's list is ACCURATE: merge, delete, kind
change, spelling edits + shared confirm, Move to Housing authority, Add as new
(settle action), Run again, composer 422 re-pick, the other-kind message /
"Put it in Agency", Dismiss on an agency suggestion. Also not e2e-covered (not
in the handback list): "Use another name"; Use with "Remember this spelling" ON
actually storing the spelling (API `organizationsApi.test.ts:410`); AI "Use
<close name>" as a human edit (`ContactDetail.test.tsx:2492`); the "+N deleted"
usage display; the importer D9 (`importOrgNames.test.ts`,
`importApply.integration.test.ts`); the cleanup script (`cleanOrgNames.test.ts`
plus the lane-13 self-QA rehearsal); D15 (`missedCallAutoText.test.ts`,
`TemplatesSection.test.tsx`); the `org_name_cleanup` Activity label (self-QA only).

## ASCII

Zero non-ASCII characters in any added line of the three diff packages
(RUNBOOK, docs/issues, GLOSSARY, test names, comments, seed strings, copy), in
every file the branch adds, and in the mission records directory.

## Other findings

1. LOW - 17 e2e specs still create units with the retired slug
   `accepted_authorities: ['atlanta_housing']` through POST /api/units (e.g.
   `e2e/tests/dashboard-next/broadcasts.spec.ts:78`,
   `public-pages.spec.ts:114`, `tour-roster.spec.ts:117`). They pass only
   because D5 resolves the slug through the seeded spelling "Atlanta Housing";
   the stored value is the list name, so I1 holds, but the specs now depend on
   that spelling staying on the lean list. `documentation/sequence-diagram-to-test.md`
   was updated to the list name; the specs were not.
2. LOW - two whitespace rules for the same case: the cleanup moves an agency
   into a whitespace-only Agency (`clean-org-names.ts:217`), while the
   in-app Move/Split counts it a conflict (`orgRecords.ts:294, :335`).
   Expected 0 records either way.
3. INFO - the tenant help text renders "The organization that runs the
   voucher." with a trailing period (`ContactEditForm.tsx:599`); spec and
   GLOSSARY quote it without. Deliberate (R3-FE-8), cosmetic.
4. LOW - the prose 400s in interface drift (merge into another kind etc.) show
   the generic copy in the dashboard; the dialogs only offer valid choices, so
   staff should not meet them.
5. INFO (known, filed as `org-rewrite-single-message-pass`) - a same-id
   redelivery (SQS 120 s visibility, `infra/modules/jobs/main.tf:36`) passes
   `claim()` (`orgRewrite.ts:269` accepts any running lock with that id), so two
   runs share the pass; writes stay conditional, counts can split, and `done`
   can land up to one heartbeat interval (20 s) before the slower run stops.
6. Beyond the spec, each consistent with it and holding against the code:
   typed-text Save commit (handback 6; Cameron's open question 2;
   `useTypedOrgText.ts:66-101`), dismissal suppression for old spellings
   (RG-2/B-3, `extraction/apply.ts:283-288`), the provenance stamp removed
   with a machine REMOVE (A2, `contactsRepo.ts:1696-1701`), the cleanup's extra
   counters and the 14-minute local lease (handback 7-8,
   `clean-org-names.ts:395-413, :691-708`; `jobs/orgRewrite.ts:98-117`).
