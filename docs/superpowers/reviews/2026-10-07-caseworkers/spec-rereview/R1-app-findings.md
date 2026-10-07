# R1 - app-side re-check of branch B (D16-D21) against merged branch A

Date: 2026-10-07. Tree: `W:/tmp/caseworkers` (`feat/caseworkers`, cut at a8b66cd6 =
merged `main`). Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 8). Scope: `app/src`, `app/test`, `app/scripts`; dashboard and e2e lines
appear only as pointers for the other researcher. Read-only pass; nothing was run.
Byte-exact quotations behind these citations: `.superpowers/sdd/spec-rereview/R1-app-reference.md`
(gitignored run state).

Verdicts: STILL VALID = the statement holds against the merged code (any note is
plan precision, not a spec change); AMEND = the spec text should change (amendment
given); DONE BY A = branch A already delivered it.

**Totals: STILL VALID 27, AMEND 7, DONE BY A 1** (35 rows).

---

## Baseline: the partner contact as merged (item 1)

- Record: `ContactItem` (`app/src/repos/contactsRepo.ts:91-308`) declares `type`
  (`ContactType`, :51) and `status` (:110); `role`, `housingAuthority`, `agency` ride
  the flexible-doc index signature (:307). Neither `type_source` nor
  `caseworker_review` exists in any code file (grep hits are docs only; A's
  `code-review/R1-CONF.md:165` and `final-review/conformance.md:162-169` confirm).
- Index: `byTypeStatus` (hash `type`, range `status`) is the only enumerator of
  contacts (`listByType`, :1143-1183) and projects every attribute (:1154-1156);
  `type`/`status` can never be REMOVEd (:486-496, :550-565). Partner statuses are
  `needs_review` or `active` (`app/src/lib/statusModel.ts:194`, :204-208).
- Listed: `GET /api/contacts?type=partner`, pages of at most 100
  (`app/src/routes/contacts.ts:377-378`, :991-1056); org sweeps read every type
  partition (`app/src/services/orgRecords.ts:367-385`).
- Created: `POST /api/contacts` (role kept, partner status defaults `active`,
  contacts.ts:866-870, :927-930; no housingAuthority/agency/organization parsed,
  :782-957); unmatched-email create (`app/src/routes/unmatchedEmail.ts:428-482`);
  the importer (caseworker-marked rows typed `partner`, see item 5).
- PATCH (`contacts.ts:1449-1963`) writes `type` (:539-545), `role` (`''` -> null
  REMOVE, :675-680), auto-advances a partner to `active` when `type` is set without a
  status (:1495-1514), bumps `classification_revision` on any type/role write
  (`contactsRepo.ts:1318-1320`, :1352-1358), D5-checks a changed
  housingAuthority/agency (:1549-1580), drains a pending type suggestion through
  `canonicalSuggestedContactKind` (:1712-1794), and flips ONLY `unknown_1to1`
  threads found from the scalar primary phone plus every email (:1850-1888). The
  Unknown card's "Mark as Partner" sends `{ type: 'partner', role: '' }`
  (pointer: `dashboard/src/routes/contact/contactProfile.ts:26-34`).

---

## D16 - Caseworkers stay partners

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| D16-1 | A "Caseworker" choice saves `type: partner, role: Caseworker`, like Property Manager | STILL VALID | PATCH takes `type` (contacts.ts:539-545) and `role` (:675-680, trimmed by `app/src/lib/contactProfile.ts:4-7`); POST takes `role` (:866-870). Picker pointer: `dashboard/src/routes/contact/KindPicker.tsx:2-6`, :32-43 (Partner clears the role; Other offers only tenant/landlord bases) | No server change for the choice itself; its role constant belongs beside `PROPERTY_MANAGER_ROLE` (`app/src/services/extraction/contactKinds.ts:4`) |
| D16-2 | No new `ContactType` | STILL VALID | `contactsRepo.ts:51`; compile guard `orgRecords.ts:130-137` | - |
| D16-3 | The canonicalizer treats partner + Caseworker as `partner`, so accepting an AI `partner` suggestion via the Caseworker choice records `accepted` | AMEND | Not done: any non-empty role returns undefined (`contactKinds.ts:15`), so the drain stamps `superseded_by_human_edit` (contacts.ts:1712-1773, appliedKind :1719). Type suggestions are accepted ONLY through this PATCH (`app/src/services/suggestionResolution.ts:269`, `accept_type_via_triage`). The Property Manager preset matches byte-exact and the tests pin case/space variants and `{ partner, 'Inspector' }` as unsupported (`app/test/contactKinds.test.ts:22-35`) | Amend D16: "treats `type: partner` with role exactly `Caseworker` (byte-exact, as Property Manager is) as `partner`; any other partner role stays unsupported." D18's normalized match is for the tab only. (If B wants D18's normalization here, the spec must say so - it cannot stay unstated.) |

## D17 - Organization field on partners

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| D17-1 | `contact.organization`, checked by D5 against either list | AMEND | The pure check already supports a two-kind field: `KINDS_FOR_FIELD` values are kind ARRAYS (`app/src/lib/orgNames.ts:23-31`) and `isOnListFor` / `resolveOrgText` / `checkScalarWrite` take them (:66-72, :89-107, :269-283). Adding `organization: ['housing_authority', 'agency']` is the whole D4/D5 change; an `other_kind` result (and so a 422 `otherKind`) can never occur for it (:102-103). The PATCH must parse the field (parseTriageBody has none; unknown keys are ignored, contacts.ts:364-368; a body of only unknown keys 400s, :749-751), add it to `touchesOrgField` (:1467) and the check loop (:1565). Clearing is unspecified: housingAuthority `''` REMOVEs (:641), agency `''` is stored (:651); `organization` is no GSI key (`contactsRepo.ts:456-460`) | Add to D17 and 5.2: "Clearing organization REMOVEs it (`''` -> null, the `role` convention, contacts.ts:678); Make caseworker's 'left empty' and the rewrite's Clear mean the same absent attribute." |
| D17-2 | Edited on partner contacts | STILL VALID | The PATCH is not type-gated by house rule (contacts.ts:329-331; housingAuthority/agency accepted on any type, :638-653) | Plan decides whether the server gates `organization` to partners or keeps it a UI rule, as housingAuthority is |
| D17-3 | Shown on the partner page and as the Caseworkers tab's filter | STILL VALID | `GET /:contactId` returns the whole item (contacts.ts:1141-1160); `GET ?type=partner` returns full items (`contactsRepo.ts:1154-1156`) | - |
| D17-4 | Counted and rewritten by D10 and D11 (section 10: "Settings counts, Not on the list and the rewrite job include organization") | AMEND | A's records/rewrite code assumes ONE kind per field (full list under "Surfaces" below): `recordFieldsForKind` (`orgRecords.ts:172-175`); `planContactRewrite` sends any non-housingAuthority field to `agency` on Clear and on rename/merge/use (:289-292, :353-356); `resolveNotOnList` fixes `kind = field === 'agency' ? 'agency' : 'housing_authority'` for Use and Add as new (`app/src/services/orgRewrite.ts:445-446`, :467-475, :506-525); `rewriteTargetKind` does the same for Run again and a lapsed claim (:188-201, used :216-222, :276-287, :561-563); `usage` counts per-kind maps into four columns (`orgRecords.ts:403-433`) and `refuseWhileUsed` sums only tenants + otherContacts + properties (`app/src/routes/organizations.ts:116-123`). Move/Split are refused for any field but housingAuthority/agency (`orgRecords.ts:239-244`; `orgRewrite.ts:486-504`) | Amend D10/D11 for organization: (1) a rename or merge of EITHER kind also rewrites `organization` (housing authority: housingAuthority, accepted_authorities, organization; agency: agency, organization); (2) an organization "Not on the list" row offers Use (a name of either kind), Add as new (staff pick the kind - the resolve body gains `kind`) and Clear - never Move or Split (the field has no "other kind"); (3) Run again and the job's claim re-validate an organization Use target against both kinds; (4) Delete counts organization holders (the new caseworkers column must join `refuseWhileUsed`, or Delete orphans them); state whether organization holders also block a kind change (they stay on the list after one); (5) a contact holding one name in two fields counts once for that entry |

## D18 - Caseworkers tab

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| D18-1 | Partners whose role normalizes to "caseworker" or "case worker" | STILL VALID | The list endpoint exists (contacts.ts:991-1056). No partner holds a role today (see D19-2), so the tab starts empty until B's choice or Make caseworker writes `Caseworker`. Matching precedents: `app/src/lib/import/names.ts:30`, `merge.ts:427`, `reviewNotes.ts:47` | - |
| D18-2 | Organization chips built like the Tenants page's housing authority chips | STILL VALID | Dashboard only; no app change | - |

## D19 - Possible caseworkers

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| D19-1 | Tenants whose role mentions caseworker/case manager, whose notes carry the AI line or those words, or who are linked as another contact's caseworker relationship | STILL VALID | The AI line is model-written and dated ("[Auto - <date>]"), example "Identified as a caseworker at Hope Atlanta" (`app/src/services/extraction/prompt.ts:93`); extraction runs only for tenant/unknown contacts (`app/src/jobs/extraction.ts:454-460`) - match the words, not a fixed string. Relationships are `{ role, name, contactId? }` (`app/src/lib/contactProfile.ts:1`, :9-24): only rows carrying `contactId` identify a contact. No index for any signal: a full read of the tenant/landlord/partner partitions (`contactsRepo.ts:1143-1183`) | - |
| D19-2 | Partners with NO role "(the importer's and the AI chip's caseworkers)" | AMEND | No path writes a partner role: the picker clears it and "Mark as Partner" sends `role: ''` (pointers above) -> REMOVE (contacts.ts:678); the importer writes no role (`app/src/lib/import/apply.ts:1079-1162`); the AI writes none. Every partner today is role-less - consistent with spec 1.2's own picker finding. Lean world: Renee Carter, partner with `role_title` (not `role`) and housingAuthority Atlanta Housing Authority (`app/src/lib/seed/lean.ts:159-178`), will be listed | Amend D19's second bullet: "partners with no role - today every partner, since no path has given a partner a role (the importer's caseworkers, the AI chip's, and other outside contacts alike); Not a caseworker dismisses the rest." Plan: lean-world e2e expectations include Renee |
| D19-3 | Tenant- or landlord-based contacts whose custom-kind role says caseworker | STILL VALID | Role on any type via the PATCH (contacts.ts:675-680) | - |
| D19-4 | "Make caseworker" and "Not a caseworker"; dismissal stored as `caseworker_review: 'dismissed'` | STILL VALID | Not in A. The PATCH parser would ignore the key (contacts.ts:364-368) and 400 a body of only it (:749-751) | B adds a parser key or a dedicated route |
| D19-5 | Make caseworker 409 while an open placement, an upcoming or unresolved tour as the tenant, a unit `landlordId`, or a unit roster seat | STILL VALID | Placements: `listByTenant` + `TERMINAL_STAGES` (as at contacts.ts:1822-1827). Tours: `listByTenant` (contacts.ts:1182); open = requested/scheduled/toured/no_show, resolved = canceled/closed (`app/src/lib/toursModel.ts:42-49`). landlordId: `listByLandlord` on byLandlord (`app/src/repos/unitsRepo.ts:366-367`, :723-724). Roster: NO index - only `unitContacts(unit)` (:296-304), i.e. a full unit scan (the `everyUnit` precedent, `orgRecords.ts:388-400`), which also covers landlordId | Plan precision: name the open-tour status set; the roster check is a scan |
| D19-6 | Make caseworker sets partner/Caseworker/`type_source: manual`, organization from agency or housing authority when exactly a list name, REMOVEs housingAuthority, clears agency, re-types the 1:1 thread | AMEND | (a) A tenant or landlord status is invalid for a partner (`statusModel.ts:204-208`); the PATCH auto-advances to `active` (contacts.ts:1495-1514). (b) housingAuthority is an AI provenance field (`app/src/services/extraction/schema.ts:24-33`, :40): a human edit clears `housingAuthority_source` and supersedes a pending housingAuthority suggestion (contacts.ts:1605-1613, :1630-1710), and the rewrite REMOVEs the stamp with the value (`contactsRepo.ts:1696-1701`, review R1-ADV-BE-2); a converted partner is extraction-ineligible (`jobs/extraction.ts:457`), so a pending chip would never resolve. (c) Type/role writes bump `classification_revision` only through `contactsRepo.update` (:1318-1320, :1352-1358). (d) "Exactly a list name" = `isOnListFor` with both kinds (`orgNames.ts:66-72`); the text does not say which wins when both fields hold list names | Amend D19: "Make caseworker also sets status `active` (the partner default the PATCH applies), REMOVEs `housingAuthority_source` with `housingAuthority` and supersedes a pending housingAuthority suggestion, and writes type and role through the classification fence; when both agency and housing authority are list names, [agency / housing authority - pick one] wins." |
| D19-7 | Past tours, closed placements and listing sends stay as history | STILL VALID | - | - |

## D20 - Direct property shares to partners; no blasts

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| D20-1 | A partner's page gets "Properties sent" and its Send action | STILL VALID | Server ready: `GET /:contactId/listings-sent` has no type guard (contacts.ts:1162-1199; A's `plan-research/R2-findings.md:158-160`) | Dashboard PartnerFile only |
| D20-2 | Composer opens with the partner as starting recipient; seed and explicit recipients may be tenants or partners | STILL VALID | Both still drop non-tenants after A: `resolveSeeds` (`app/src/routes/broadcasts.ts:421-454`, `c.type !== 'tenant'` :434) and the explicit list (:827); seeds_only drafts :533-553, :856-868 | - |
| D20-3 | Filter-resolved audiences and the recipient search stay tenant-only | STILL VALID | broadcasts.ts:130-132; `app/src/services/audienceResolution.ts:147` | - |
| D20-4 | Every existing gate applies unchanged | STILL VALID | `fenceFor` is type-agnostic (`app/src/jobs/broadcastFanOut.ts:250-281`); sendMessage refuses only relay/group types (`app/src/services/sendMessage.ts:483-486`) | - |
| D20-5 | A partner with no conversation gets `partner_1to1`; both fan-out sites use the contact's type | STILL VALID | Unchanged by A - both sites still hard-code `'tenant_1to1'`: `broadcastFanOut.ts:871` (the pass) and :1386 (`adoptBroadcastRecipient`, the send.reconcile adoption). The importable helper is the EXPORTED `conversationTypeFor(contact)` in `app/src/lib/voiceMasking.ts:27-39` (already imported by `jobs/placementNudges.ts:32`, `services/groupReceipts.ts:54`, `services/originateCall.ts:24`); the contacts.ts:469-475 copy is module-local. `createOrGetByParticipantPhone` returns any existing OPEN thread whatever its type (`app/src/repos/conversationsRepo.ts:1252-1264`): the type matters only on create | Plan precision: name the voiceMasking helper |
| D20-6 | The property's "Sent to tenants" becomes "Sent to", partner rows labelled by role | STILL VALID | Needs a wider read (A's R2-F5): `GET /api/units/:unitId/recipients` names rows through `getDisplaysByIds` (`app/src/routes/units.ts:999-1013`), whose projection has no type or role (`contactsRepo.ts:914-922`); the wire row carries `tenantName` only (`app/src/repos/listingSendsRepo.ts:105-116`) | - |
| D20-7 | "Recipient wording in the composer preview and results is not tenant-only" (the list of tenant-worded share surfaces) | AMEND | Also tenant-worded: the property Activity `broadcast_sent` row "Sent to N tenant(s)" / "No tenants reached" (pointer `dashboard/src/routes/listing/listingFormat.ts:175-183`) from `tenantCount` (`units.ts:192`, :224, recounted :1295-1322; written `broadcastFanOut.ts:1584`); per R2-F5 the compose reach line and the Matching list label; the results view's unresolved-row fallback is "Tenant" (broadcasts.ts:290-291) | Amend section 10's wording bullet: "recipient wording in the composer preview and results, the compose reach line, the Matching list label and the property Activity's share row ('Sent to N recipients') is not tenant-only." |

## D21 - Type changes keep threads and imports consistent

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| D21-1 | A staff type change re-types the contact's open 1:1 threads - every phone and email - whose type matches the OLD type; a thread typed for another identity is left alone | AMEND | Today the PATCH gathers threads from the scalar primary `phone` plus every email (contacts.ts:1850-1871) and flips ONLY `unknown_1to1` (:1875-1888); `conversationsForContact` already unions every phone and email (`app/src/lib/contactThreads.ts:38-54`; raw, so filter to 1:1 types). Every imported 1:1 thread is written `unknown_1to1` (`apply.ts:1208-1212`, if_not_exists) and only this PATCH ever re-types a thread (`applyTriage` callers: contacts.ts:1882, :2000 and `placementNudges.ts:556`, the last two name-only) - so a literal "matches the OLD type" rule leaves an imported tenant's thread `unknown_1to1` on Make caseworker, contradicting D19. `applyTriage` is an unconditional SET (`conversationsRepo.ts:1516-1561`). `app/test/contactTriage.test.ts:263-276` stays valid under the amended rule | Amend D21: "... whose type matches the OLD type, or is still `unknown_1to1` (today's triage flip, kept), are re-typed to the new type; ...". Plan: make the re-type conditional on the type the GSI read returned. Why it matters: readers pick threads by type - extraction eligibility (contacts.ts:2397; `routes/webhooks/twilio.ts:2668-2670`; `services/inboundEmail.ts:815-817`), tour reminders (`jobs/tourReminders.ts:1093`), placement nudges (`jobs/placementNudges.ts:518-519`), the timeline (`routes/contactTimeline.ts:947`), Today (`routes/today.ts:815-817`) |
| D21-2 | `type_source: 'manual'` stamped on a staff override (tenant/landlord/partner to another type) and by Make caseworker; triage of an `unknown` contact does not stamp | STILL VALID | Not in A. The PATCH reads the stored contact before writing (contacts.ts:1467-1472), so override vs triage is decidable; the edit form sends `type` only on change (pointer `dashboard/src/routes/contact/ContactEditForm.tsx:276`) | Plan: server-owned - refuse a client-sent `type_source` as `consent_captured_by` is refused (contacts.ts:314-319) |
| D21-3 | Importer: for `type_source: 'manual'` writes none of type, status, housingAuthority, agency; others as today | STILL VALID | `upsertContact` SETs `#type = :type` every run (`apply.ts:1079-1080`) and status unless the stored status has non-import provenance (:1074-1077, :1144-1149); since A, housingAuthority and agency are fill-only (:1128-1143). The existing pre-read `prior` (:1057-1060) carries `type_source` at no cost | Partly redundant after A: Make caseworker's agency `''` is never refilled by `if_not_exists`, but its housingAuthority REMOVE would be - the guard is load-bearing for type, status and housingAuthority. Dry runs read no contact (:340-343), so a "protected" count needs a read. Still SET for manual contacts (pre-existing): names, voucherSize, notes, phones (:1079-1127) |
| D21-4 | Triage of an `unknown` contact stays unprotected; filed as a follow-up (section 12) | DONE BY A | `docs/issues/reimport-reverts-unknown-triage.md` (open, low, 2026-10-07) | B keeps triage unstamped and cites it |
| D21-5 | The contact header shows voucher size and housing authority only for tenants | STILL VALID | Not done (pointer): `dashboard/src/routes/contact/ContactDetail.tsx:1322-1335` shows both for every non-landlord, partners included | Dashboard only |

## Other (B) statements (sections 2-5, 9, 11)

| # | Statement | Verdict | Code that decides it | Amendment / note |
|---|---|---|---|---|
| O-1 | Section 3: "caseworker" and "organization (of a caseworker)" vocabulary | STILL VALID | GLOSSARY holds only A's terms (`final-review/conformance.md:169`) | B adds them |
| O-2 | D3/D4 (B): organization is on the list for either kind; spellings counted within both kinds | STILL VALID | `orgNames.ts:66-72`, :89-107 take kind arrays | - |
| O-3 | D6 (B): a caseworker's organization can add either kind; the dialog asks which | STILL VALID | `POST /api/organizations` takes `kind` (`organizations.ts:202-224`) | `POST /check` resolves within ONE kind and scores close names inside it (`app/src/services/orgNames.ts:260-279`; `orgNames.ts:106`): the organization picker needs one call per kind, or B widens /check |
| O-4 | 5.2 (B): `organization`, `caseworker_review`, `type_source` are new | STILL VALID | None exists (`code-review/R1-CONF.md:165`) | - |
| O-5 | Section 9 (B) writers and readers; I2 with the public-intake exception | STILL VALID | PATCH (contacts.ts:1449-1963); intake still mints `tenant_1to1` (`app/src/routes/public.ts:285`) | If organization rows get e2e coverage, the dev seam allows housingAuthority/agency only (`app/src/routes/dev.ts:1229-1232`) - name it as B's stated exception too |
| O-6 | Section 2 non-goals touching B: the free-text tenant `caseworker` stays; intake `tenant_1to1` stays; no partner blasts | STILL VALID | Only the lean seed writes `caseworker` (`lean.ts:121`); public.ts:285; broadcasts.ts:130-132 | - |
| O-7 | Section 11: branch B is deploy only, no script | STILL VALID | No organization value exists before B; `type_source`/`caseworker_review` need no backfill; no index needed (organization is no GSI key, `contactsRepo.ts:456-460`) | - |

---

## Surfaces that enumerate organization fields today (what `contact.organization` touches)

App (each must learn `organization`, or is confirmed generic):

1. `app/src/lib/orgNames.ts:23-31` - `OrgField` + `KINDS_FOR_FIELD`: add
   `organization: ['housing_authority', 'agency']`. Nothing else in the pure module
   changes; `OrgNotOnList.field` (:235-243) follows the type.
2. `app/src/repos/orgListRepo.ts:40-41` - `OrgRecordField`; :60-62 the counts doc
   (`lastRewrite.counts` keys).
3. `app/src/services/orgRecords.ts` - `FIELD_ORDER` (:140, a Record: compile-forced);
   `recordFieldsForKind` (:172-175, add to BOTH kinds); `RewriteCounts` and its
   initializer (:203-212, :502); the action sets (:214-225); `passField` (:228-249 -
   Move/Split already refused for organization); `FieldAudit` (:251-256) and
   `ContactPlan` (:258-267); `planContactRewrite` (:276-358 - organization needs its own
   Clear and rename/merge/use branches; today both fall to `agency`); `OrgUsage` and
   `usage` (:97-100, :403-433 - a both-kinds lookup and a caseworkers column);
   `notOnList` contact loop (:449); `holders` (:478-499) and the contact pass
   (:589-608) are generic once the type widens.
4. `app/src/services/orgRewrite.ts` - `resolveNotOnList` input (:105-113, add `kind`
   for Add as new on organization), its fixed `kind` (:446), `named` (:467-475), Add
   (:506-523), Use (:525); `rewriteTargetKind` (:188-201); rename/merge `fields`
   (:394, :434, via `recordFieldsForKind`); `revalidationProblem` (:213-234) is generic
   (it unions `KINDS_FOR_FIELD` over `fields`, :228); the cleanup lock's field list
   (:585) needs no change while B has no script.
5. `app/src/routes/organizations.ts` - `RECORD_FIELDS` (:61) and its two 400 texts
   (:161, :333); `refuseWhileUsed` (:116-123); the resolve body (:321-364, add
   `kind`); `/check` is single-kind (:172-200).
6. `app/src/repos/contactsRepo.ts` - `rewriteOrgFields` interface and impl
   (:808-826, :1672-1737; `expect`/`next` and the guard are typed
   housingAuthority/agency only).
7. `app/src/routes/contacts.ts` - `parseTriageBody` (:516-758, add the key),
   `touchesOrgField` (:1467), the D5 loop (:1565); `parseCreateBody` (:782-957)
   ignores org fields - section 9 says POST must not start accepting them unchecked,
   so a caseworker made through New contact gets an organization only by an edit.
8. `app/src/routes/dev.ts:1192-1258` - the `/__dev/org-fixture` field allowlist
   (:1229-1232).
9. `app/src/jobs/orgRewrite.ts:148-160` - generic per-field loop (no change).
10. `app/scripts/clean-org-names.ts` - its own enumeration (`CleanupField` :82,
    plan types :127-130, `FIELD_ORDER` :527); unchanged (B has no script); a re-run
    never reads organization.
11. `app/src/lib/import/apply.ts` - resolves housingAuthority/agency only
    (:979-1013; report field type :226-238); never writes organization.
12. Tests: KINDS pins `app/test/orgNames.test.ts:110-115`; seed field map
    `app/test/seedOrgNames.test.ts:50-91` (only if seeds gain organization); the fake
    `rewriteOrgFields` in `app/test/helpers/twilioWebhookHarness.ts:2497-2518`;
    throwing stubs in `audienceResolution.test.ts:120`, `contactCapture.test.ts:144`,
    `scheduledSendSuppression.test.ts:272`, `sendMessage.test.ts:256`; suites to extend:
    `orgRecords.test.ts`, `orgRewriteJob.test.ts`, `orgRewriteService.test.ts`,
    `orgRecordWriters.integration.test.ts`, `organizationsApi.test.ts`,
    `contactOrgNames.test.ts`, `contactKinds.test.ts`, `contactTriage.test.ts`,
    `importOrgNames.test.ts` (D21 rule).

Pointers outside the app (single-kind assumptions mirrored there):
`dashboard/src/api/types.ts:3436-3439` (`OrgField`, `OrgRecordField`);
`dashboard/src/routes/orgs/orgCopy.ts:49-53` (`FIELD_LABEL`) and :64-67
(`kindForField` - one kind per field, the client twin of orgRewrite.ts:446);
`dashboard/src/routes/settings/NotOnListSection.tsx` (:282, :467);
`dashboard/src/api/endpoints.ts:2890`; `e2e/fixtures/orgFixture.ts:24`.

## Possible-caseworker signals in today's data, and what A's importer reports (item 5)

- Imported caseworkers become role-less partners: a "caseworker" name suffix or an
  Airtable `tenant type` of "Casewoker" -> `partner` (`app/src/lib/import/merge.ts:410-414`,
  :424-428) with the workbook flag "Looks like a caseworker - imported as a partner
  contact. Correct?" (:44, :279-281); her "Caseworker" review answer -> `partner`
  (`reviewNotes.ts:123-125`). The marker is stripped from the stored name
  (`names.ts:62-68`). The 2026-08-09 Airtable export typed 10 rows "Casewoker"
  (`airtableSource.ts:20-23`).
- The most direct organization signal is NOT stored: Airtable's `caseworker
  organization` column is read (`airtableSource.ts:71`, :176) and shown in the
  workbook (`workbook.ts:57`, :162) only. A caseworker row's program column is resolved
  into housingAuthority/agency like anyone's (`apply.ts:948`, :979-996), so Make
  caseworker can draw an organization only from those two fields.
- AI: a `partner` type suggestion only for `unknown` contacts (`app/src/services/extraction/apply.ts:577-578`),
  plus a role/organization note line (`prompt.ts:86-88`, :93).
- A's importer reports nothing caseworker-specific: `ApplyReport` = contacts
  {written, skippedDropped, statusPreserved, agencyFromHousingAuthority},
  `orgNotWritten` (field housingAuthority/accepted_authorities), warnings
  (`apply.ts:183-238`; printed by `app/scripts/import-apply.ts:398-457`); the merge
  stats count partners only by type (`merge.ts:344-345`). No `type_source` anywhere.

## A's filed issues that touch B

Must honor (B changes the same code):

1. `reimport-reverts-unknown-triage` (open, low) - D21-4 above; B keeps triage
   unstamped and cites it.
2. `org-rewrite-pass-start-pacing-gap` (open, low) - adding `organization` makes every
   housing authority rename/merge three passes and every agency one two
   (`recordFieldsForKind`), widening residual (b) (a stall in one pass's last page read,
   then the next pass writes unchecked for up to 20 s). Note it in the plan; the issue's
   one-clock fix (`jobs/orgRewrite.ts:151-160`) removes it.
3. `org-rewrite-single-message-pass` (open, low) - the organization pass adds one more
   full contact scan inside the one queue message per rename/merge (120 s visibility
   timeout). Note, not B's to fix.
4. `org-names-backend-review-lows` (open, low) - item 4 (unbounded `value` on
   `POST /not-on-list/resolve`) now covers organization rows too; item 1 (Move/Split
   parity) does not apply to organization.
5. `org-list-write-retry-reads-as-lost-race` (open, low) - every organization action
   starts through the same `start()`/`mutate()`; inherited, awareness only.
6. `org-picker-settings-review-lows`, `org-provisional-entry-concurrent-rename`,
   `org-settings-details-read-no-age-cap` (open, low; dashboard) - the caseworker
   Organization picker reuses OrgPicker / NewOrgDialog / useOrgList and the Settings
   rows, so it inherits stale lists (L1), early "Yes, add it" (L3), Cancel losing text
   (L4), a hung `/check` (L5) and the Settings a11y/refresh items.
7. A's recorded B note (not an issue file): `plan-research/R2-findings.md:139-162`
   (F5) - the "Sent to" role label needs a wider read; Properties sent needs no server
   change; two more tenant-worded sites (folded into D20-6/D20-7).

Context only:

8. `staff-notes-on-landlord-partner-files` (open, low) - converting a tenant to a
   caseworker hides its Staff notes (PartnerFile has no card; nothing is lost). Say so
   in B, or ask Sam about the card.
9. `tenant-support-contacts-structured` (open, med) - the free-text tenant `caseworker`
   attribute (a B non-goal); D19's relationship signal is the structured link it asks for.
10. `housing-authority-free-text-drift` (resolved by A) - names the caseworker link as
    branch B; Sam's caseworker-org list includes DCA, a housing authority - consistent
    with organization taking either kind.
11. `missed-call-autotext-partial-intake` (deferred) - partners never get the intake
    text (`app/src/jobs/missedCallAutoText.ts:70-74`), so organization is not an
    intake fact; no B change.
12. `lean-seed-ha-staffer-should-be-partner`, `caseworker-contact-type` (resolved) -
    background for D19-2 (Renee is a role-less partner).

## Observations for the planner (no spec text depends on them)

- The edit form's type change - and so D16's Caseworker choice - has none of Make
  caseworker's 409 guards: the PATCH re-types a tenant with an open placement today
  (contacts.ts:1449-1963 has no placement or tour check). Decide whether D16 inherits
  D19's refusal.
- A phone held by two contacts shares one 1:1 thread (`broadcastFanOut.ts:1313-1316`);
  re-typing it follows whichever contact changed type last.
- Possible caseworkers reads every tenant, landlord and partner (no index); the
  `tours-tabs-load-every-contact-for-names` issue is the cost precedent.
