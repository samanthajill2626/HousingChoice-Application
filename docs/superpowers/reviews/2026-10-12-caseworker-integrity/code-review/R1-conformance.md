# Code review R1 - spec conformance (caseworker-integrity)

- Reviewer: round-1 spec-conformance reviewer (read-only), 2026-10-12.
- Branch `fix/caseworker-integrity`, worktree `W:\tmp\caseworker-integrity`,
  HEAD `f11e46fb` (base = merge-base with main `19607658`).
- Contract checked: spec rev 3 (all sections), plan v2 sections 0-3 and each
  slice's "Surfaces covered", plan-assembly rulings, plan-review adjudications,
  build-research README (incl. planner rulings Q1 and Q2).
- Method: every row below was verified by reading the code at HEAD (build
  reports used only to locate code). Copy strings were checked byte-for-byte
  with `grep -F` against plan section 1, spec section 2 and the Q2 ruling (all
  21 strings matched). Added lines on the branch are ASCII-only (checked).
- Empirical checks: none run and no throwaway file created. Gate evidence
  read from the orchestrator's logs: `p3-typecheck` exit 0, `p3-smoke` exit 0,
  `p3-npmtest` exit 0 (app 9441 passed / 1 pre-existing diagnostic skip in
  `staticSmoke.test.ts`; the DynamoDB Local suites this branch adds or
  extends RAN, not skipped: `suggestionReclassification.integration` 7 (new),
  `unitsRepoRestoreWithLandlord.integration` 9 (new),
  `suggestionResolutionRepo.integration` 32 (extended); zero `[dynamoAdmin]` lines).
  `p3-e2e` exit 0: 345 passed (22.5m), 0 failed, including all ten new
  caseworker-integrity e2e cases (read after its exit marker appeared).
- Lint gate 5 was NOT run by this reviewer (orchestrator gate). The two known
  baseline lines are untouched: `TourDetail.tsx:342` (`Date.now()`) and
  `ScheduleTourForm.tsx:242` (`setTourType(DEFAULT_TOUR_TYPE)`), each shifted
  +1 by an added import.

## Verdict

Every row CONFORMS (most with a binding ruling cited where the plan or a
ruling refines the spec). Counts over the 190 rows below: CONFORMS 190,
PARTIAL 0, MISSING 0, DEVIATES 0. Non-CONFORMS list: none. Six INFO observations (all on
conforming code) follow the table.

## Table

Paths are repo-relative; `:N` is a line at HEAD f11e46fb.

### A. Work map (mission block), split into its parts

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| A1 | S1 plan-time 409 `suggestion_contact_not_tenant` | CONFORMS | `app/src/services/suggestionResolution.ts:819-826` | accept only; after the consistent read :812, before the org-list read :831 and `buildPlan` :835 (ruling S1-2) |
| A2 | S1 `classification_revision` guard | CONFORMS | `suggestionResolution.ts:221-235` (`withClassificationFence`), applied :309 (status), :368 (housingAuthority), :391 (generic field) | neutral targets untouched (the address guard :340 has no fence; `withClassificationFence` skips firstName/lastName :226) |
| A3 | S1 consistent plan read | CONFORMS | `suggestionResolution.ts:812` | `getById(..., { consistentRead: true })`; same object passed to `buildPlan` :835 |
| A4 | S1 `effectiveGuard` at all three real-repo sites | CONFORMS | `app/src/repos/suggestionResolutionRepo.ts:480-487`; sites :862-863 (commit), :893 (re-read), :907 (mismatch ConditionCheck) | no `.plan.guard` read left in the repo (source pin `app/test/suggestionReclassificationGuard.test.ts:329`) |
| A5 | S1 `effectiveGuard` in the fake | CONFORMS | `app/test/helpers/suggestionResolutionFake.ts:344-349` | imports both functions from the repo module (pin `suggestionReclassificationGuard.test.ts:339`) |
| A6 | S1 `superseded_by_reclassification` -> 409 `suggestion_contact_reclassified` | CONFORMS | repo :168, :899-905, :927, :936; service :894-896 | own claim only; helped journals ignore the flag (:779-783) |
| A7 | S1 SSE emit | CONFORMS | `app/src/routes/suggestions.ts:227-229` | not_tenant emits nothing |
| A8 | S1 dashboard copy | CONFORMS | `dashboard/src/api/types.ts:1697-1702` | byte-exact |
| A9 | S1 dashboard refetch | CONFORMS | `dashboard/src/routes/contact/ContactDetail.tsx:738-745` | not_tenant not refetched |
| A10 | S1 FakeWorld AND DynamoDB Local regressions (schedules A and B) | CONFORMS | `app/test/suggestionReclassification.test.ts:377,402,483`; `app/test/suggestionReclassification.integration.test.ts:211,279,291` | real suites ran in `p3-npmtest` |
| A11 | S2 `contactHoldings.ts` extraction, conversion byte-identical | CONFORMS | `app/src/services/contactHoldings.ts:42-112`; `app/src/services/caseworkerConversion.ts:225-243` | same read order, comparator, `deleted: 'any'`, landlord-exclusion of the roster Scan |
| A12 | S2 `contactKind` | CONFORMS | `app/src/lib/caseworkers.ts:96-98` | |
| A13 | S2 PATCH 409 `type_change_refused` (live landlord units only) | CONFORMS | `app/src/routes/contacts.ts:1644-1653`; `contactHoldings.ts:123-143` (`deleted: false` :138) | |
| A14 | S2 edit form | CONFORMS | `dashboard/src/routes/contact/ContactEditForm.tsx:529-533,606-609` | cleared on kind change :268 and at save :498 |
| A15 | S2 Unknown card | CONFORMS | `ContactDetail.tsx:673-693`; `dashboard/src/routes/contact/UnknownFile.tsx:155-165` | |
| A16 | CK after S2 (typecheck + npm test + smoke) | CONFORMS | `.superpowers/sdd/logs/ck1-*` (smoke OK, typecheck clean, npm test exit=0) | |
| A17 | S3 `contactTypeGuards.ts` | CONFORMS | `app/src/services/contactTypeGuards.ts:25-109` | four classes, two consistent reads (:66, :81), one mapper |
| A18 | S3 tour create | CONFORMS | `app/src/routes/tours.ts:350-360` | after body validation, before `tours.create` :367 |
| A19 | S3 revive from canceled | CONFORMS | `tours.ts:1398-1412` | `currentStatus === 'canceled' && OPEN_TOUR_STATUSES.has(effectiveStatus)` :1404 |
| A20 | S3 reopen | CONFORMS | `tours.ts:1691-1700` | after `reopenTargetFor`, before `reopenIf` :1701 |
| A21 | S3 placement create | CONFORMS | `app/src/routes/placements.ts:577-587` | before the unit check |
| A22 | S3 placement from-tour | CONFORMS | `placements.ts:673-683` | before the conversion claim; only reads precede it |
| A23 | S3 placement terminal exit (service) | CONFORMS | `app/src/services/statusTransition.ts:420-422` | the route is the service's only caller (`app/src/routes/statusTransition.ts:200`) |
| A24 | S3 `handleTransitionError` | CONFORMS | `app/src/routes/statusTransition.ts:331-336` | 409 body / 404 `tenant_not_found` via `sendContactTypeError` |
| A25 | S3 `deriveTenantStatus` skip | CONFORMS | `services/statusTransition.ts:345-351` | no write, no audit, no milestone; info log |
| A26 | S3 TenantFile team-member buttons | CONFORMS | `dashboard/src/routes/contact/TenantFile.tsx:169,325,353` | no other Schedule / Start placement entry on the contact page |
| A27 | S3 `contactTypeErrors.ts` + every tour/placement copy site incl. TourModals `failureCopy` | CONFORMS | `dashboard/src/lib/contactTypeErrors.ts:26-47`; sites in D30-D36 | |
| A28 | S4 unit create landlord type | CONFORMS | `app/src/routes/units.ts:492-507` | after the 400s and org-list 422 |
| A29 | S4 unit PATCH landlord type | CONFORMS | `units.ts:1481-1510` | changed id only, consistent unit read; `''` -> 404 without a read |
| A30 | S4 contact-list caseworker (new seat) + landlord claim checks, in order | CONFORMS | `units.ts:1131-1143`, both before `addContact` :1149 | |
| A31 | S4 `restoreWithLandlord` | CONFORMS | `app/src/repos/unitsRepo.ts:1103-1175` | one `UpdateCommand` via `updateRosterIfCurrent` :1164 (conditions landlordId + contacts[] :572-586, sent :595) |
| A32 | S4 restore route | CONFORMS | `units.ts:1587-1703` | see D19-D26 |
| A33 | S4 "Restore property" dialog | CONFORMS | `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:35-128`; `ListingDetail.tsx:373-377,1400-1424` | |
| A34 | S4 Add contact picker hides caseworkers | CONFORMS | `dashboard/src/routes/listing/ListingDetail.tsx:395-397` | `isCaseworkerContact` mirrors server `isCaseworker` |
| A35 | S4 `runRosterWrite` mapping | CONFORMS | `ListingDetail.tsx:432-440` | before the 409 catch-all :441 |
| A36 | S4 ownerless crash fix + optional `landlordId` | CONFORMS | `dashboard/src/api/types.ts:2447`; `ListingDetail.tsx:308` | every other dashboard `landlordId` read already guards absence (`useListing.ts:118-122`, `buildListingFile.ts:64,97`, `TourDetail.tsx:202`, `useTour.ts:96`, `PlacementDetail.tsx:188,228`) |
| A37 | CK after S4 | CONFORMS | `.superpowers/sdd/logs/ck2-*` | |
| A38 | S5 seed invariant test | CONFORMS | `app/test/seedContactTypeInvariants.test.ts:55-135` | lean, full (lean+cast+matrix+live), performance (two variants); non-vacuous counts |
| A39 | S5 e2e edit-form refusal | CONFORMS | `e2e/tests/dashboard-next/caseworkers.spec.ts:635` | passed in the full gate (#46) |
| A40 | S5 e2e picker | CONFORMS | `e2e/tests/dashboard-next/property-roster.spec.ts:342` | positive control present; passed (#170) |
| A41 | S5 e2e Reopen-dialog refusal | CONFORMS | `e2e/tests/dashboard-next/tour-auto-close.spec.ts:380` | passed (#222) |
| A42 | S5 e2e placement refusal | CONFORMS | `e2e/tests/dashboard-next/placements-page.spec.ts:346` | passed (#165) |
| A43 | S5 e2e restore dialog | CONFORMS | `property-roster.spec.ts:371,409` | Cancel, without, with; passed (#171, #172) |
| A44 | S5 RUNBOOK | CONFORMS | `RUNBOOK.md:473,475` | see F1 |
| A45 | S5 resolve 3 issues (correct the third) | CONFORMS | see F2-F7 | |
| A46 | S5 file 4 issues | CONFORMS | see F8-F11 | |
| A47 | Known lint baseline not fixed | CONFORMS | `dashboard/src/routes/tours/TourDetail.tsx:342`, `dashboard/src/routes/tours/ScheduleTourForm.tsx:242` | unchanged lines; gate 5 itself not run here |

### B. Spec section 2 (D1), changes 1-7

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| B1 | Change 1 consistent plan read | CONFORMS | `suggestionResolution.ts:812` | test `suggestionReclassification.test.ts:226` |
| B2 | Change 2 tenant-only ACCEPT on a non-tenant refused before the claim, chip not consumed | CONFORMS | `suggestionResolution.ts:819-826` | no claim, no write; test :249 it.each (seven targets), chip kept |
| B3 | Change 2 dismissals never refused | CONFORMS | `suggestionResolution.ts:821` (`action === 'accept'`) | test :296 |
| B4 | Change 2 for `status`, type check before the allowlist | CONFORMS | check :819-826 precedes `buildPlan`'s allowlist :298 | the spec premise holds: extraction proposes `status` for tenants only (`app/src/services/extraction/apply.ts:535`) |
| B5 | Change 3 guard carries `classification_revision` (`exists:false` / `exists:true,value`) | CONFORMS | `suggestionResolution.ts:221-235` | tests :322, :344 |
| B6 | Change 4 legacy fallback via ONE exported `effectiveGuard(journal)` | CONFORMS | `suggestionResolutionRepo.ts:480-487` | `{}` for phone/dismiss (ruling S1-4); never mutates the stored plan |
| B7 | Change 4 used at :798/:827/:831 equivalents and in the fake | CONFORMS | repo :862-863, :893, :907; fake :344 | |
| B8 | Change 4 legacy journal on a converted contact ends a mismatch, never `stale` | CONFORMS | repo :893-905 | DynamoDB Local `app/test/suggestionResolutionRepo.integration.test.ts:572`, `suggestionReclassification.integration.test.ts:322` |
| B9 | Change 5 union gains `superseded_by_reclassification` (real + fake) | CONFORMS | repo :160-168; fake :175-177 | |
| B10 | Change 5 classification wins a tie | CONFORMS | `guardMismatchIsClassification` repo :495-505; decided at the consistent re-read (ruling S1-3) | tests guard :127, repo-int tie case |
| B11 | Change 5 stored outcome + run-log verdict as for a human edit | CONFORMS | real `journalSuperseded` unchanged; fake :193-201 stores `superseded_by_human_edit` | verdict asserted `suggestionReclassification.test.ts:507-509` |
| B12 | Change 5 `resolve()` answers 409 `suggestion_contact_reclassified`; helped/replayed journals keep today's answers | CONFORMS | service :894-896; help path :779-783 discards flags; replay branches unchanged | |
| B13 | Change 6 route emit for reclassified; nothing for not_tenant | CONFORMS | `suggestions.ts:227-229` | tests :618, :641 |
| B14 | Change 6 dashboard copy map (both sentences) | CONFORMS | `types.ts:1697-1702` | byte-exact; `dashboard/src/api/types.test.ts:133` |
| B15 | Change 6 refetch list adds reclassified | CONFORMS | `ContactDetail.tsx:742` | `ContactDetail.test.tsx:776` |
| B16 | Change 6 "every reader": no other reader of the refusal codes | CONFORMS | repo-wide grep: only route, copy map, ContactDetail consume `suggestion_field_edited` | |
| B17 | Change 7 no repair step | CONFORMS | nothing built | premise changed (#19 deployed) - see INFO-2 |

### C. Spec section 3 (D2)

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| C1 | Rule: result not tenant -> refused by open placement / open tour (I2) | CONFORMS | `contactHoldings.ts:129-136` | open = not in `TERMINAL_STAGES`; tours per `OPEN_TOUR_STATUSES` :19 |
| C2 | Rule: result not landlord -> refused by LIVE landlord-of-record units only (I3) | CONFORMS | `contactHoldings.ts:137-141`; `unitsRepo.ts:336-337` (`deleted: false` = live only) | conversion keeps `'any'` (`caseworkerConversion.ts:229`) |
| C3 | Rule: contact-list seats never refuse | CONFORMS | `typeChangeRefusals` never calls `rosterUnitIds` | test `contactTypeChangeRefusals.test.ts:188` |
| C4 | Applies to every target type (incl. team_member, unknown) | CONFORMS | `contacts.ts:1644-1646` | 20-pair matrix `contactTypeChangeRefusals.test.ts:91-144` |
| C5 | Only when the type differs from the stored type | CONFORMS | `contacts.ts:1644` | re-sent type not read (test :242) |
| C6 | Order: after the caseworker 409 (W6), before any write | CONFORMS | 409 :1635 then :1644; only reads until the first write, `contacts.update` :1781 | role-only change not checked (test :218) |
| C7 | Response body and order (placement, tour, landlord; id asc) | CONFORMS | `contacts.ts:1651`; `contactHoldings.ts:39,52,60,83` | test :195 |
| C8 | Shared reads extracted; four kinds separately; per-call live/any | CONFORMS | `contactHoldings.ts:42-112` | |
| C9 | Conversion keeps behavior, codes, order, deleted counting (W2) | CONFORMS | `caseworkerConversion.ts:225-243` | conversion test files untouched (`caseworkerConversion.test.ts`, `caseworkerRepoParity.integration.test.ts`, `caseworkerReviewApi.test.ts`, `CaseworkerDialog.test.tsx`) |
| C10 | The PATCH never runs the roster Scan | CONFORMS | `contactHoldings.ts:123-143` | test :275 |
| C11 | Dashboard: `refusalCopy` keyed by kind in a shared module; dialog output byte-identical | CONFORMS | `dashboard/src/lib/holdingRefusals.ts:39-66`; `dashboard/src/routes/contact/CaseworkerDialog.tsx:66-77` | sentences/links identical to base; pinned `holdingRefusals.test.ts` (W2 case) |
| C12 | Dashboard: placement/tour reuse conversion copy; own landlord sentence + View property | CONFORMS | `holdingRefusals.ts:35-36,70-79` | byte-exact |
| C13 | Edit form: keep draft, sentences + View links beside the kind picker; other copy unchanged | CONFORMS | `ContactEditForm.tsx:520-533,606-609` | `caseworker_use_conversion` copy and "Couldn't save - please try again." kept |
| C14 | Unknown card: stops swallowing; refusals or "Couldn't save - please try again." on the card | CONFORMS | `ContactDetail.tsx:673-693`; `UnknownFile.tsx:155-165` | stale-contact guard via `reviewGenerationRef` |

### D. Spec section 4 (D3)

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| D1 | All new contact reads consistent; "exists" keeps `getById` meaning | CONFORMS | `contactTypeGuards.ts:66,81`; `units.ts:1107,1116,1615,1625` | soft-deleted contacts pass (no deleted-contact refusal) |
| D2 | `POST /api/tours`: 404 `tenant_not_found` / 409 `contact_not_tenant` | CONFORMS | `tours.ts:350-360` | `app/test/toursCreateContactType.test.ts` |
| D3 | Tour PATCH canceled -> open (scheduled via reschedule or status, toured, no_show); open-to-open and into-closed not checked | CONFORMS | `tours.ts:1398-1412` | `app/test/toursReviveContactType.test.ts:58-63,116-159`; nothing written before the check |
| D4 | `POST /api/tours/:id/reopen` | CONFORMS | `tours.ts:1691-1700` | `app/test/toursReopenContactType.test.ts` |
| D5 | `POST /api/placements`: keeps 404, adds 409 | CONFORMS | `placements.ts:577-587` | any starting stage |
| D6 | `POST /api/placements/from-tour`: 409 before any write | CONFORMS | `placements.ts:673-683` | |
| D7 | Terminal -> non-terminal transition, in the service | CONFORMS | `services/statusTransition.ts:420-422` | between terminals / into terminal / between non-terminals not checked (tests) |
| D8 | 409 body `{ error, contactKind }`, contactKind = caseworker else stored type | CONFORMS | `contactTypeGuards.ts:68,97`; `caseworkers.ts:96-98` | |
| D9 | Dedicated error class mapped by `handleTransitionError` to 409; missing -> 404 | CONFORMS | `routes/statusTransition.ts:336` | uses the shared classes (plan section 2) |
| D10 | Derived tenant status: non-tenant writes nothing, info log; listing derivation unchanged | CONFORMS | `services/statusTransition.ts:345-351`; only contact derived-status writer is :355 | W5 tests `app/test/deriveTenantStatusSkip.test.ts:62-118` |
| D11 | Team members: hide "+ Schedule" and "+ Start placement" | CONFORMS | `TenantFile.tsx:169,325,353` | server refuses team members (D2-D7) |
| D12 | `POST /api/units`: 404 `landlord_not_found` / 409 `landlord_not_landlord` | CONFORMS | `units.ts:492-507` | `app/test/unitsLandlordOfRecord.test.ts:34-98` |
| D13 | `PATCH /api/units/:id` CHANGED `landlordId`: same | CONFORMS | `units.ts:1481-1510` | unchanged id not checked (L2 PIN :144); `landlordId: null` is still a 400 (`app/src/lib/unitFields.ts:162-164`) |
| D14 | Contact-list landlord CLAIM of a vacant slot: 409; re-assert not checked | CONFORMS | `units.ts:1137-1143` | mirrors repo `claimsVacantLandlord`; tests `unitsApiRosterTypeChecks.test.ts:135-192` |
| D15 | Restore never dead-ends (row in the I3 table) | CONFORMS | `units.ts:1587-1703` | |
| D16 | Plain restore: ownerless or landlord-typed -> exactly as today | CONFORMS | `units.ts:1632-1646` | raw unit, unchanged audit; live unit not checked (ruling S4-3, :1624) |
| D17 | Plain restore otherwise: 409 `restore_needs_landlord { landlordName? }`, nothing written | CONFORMS | `units.ts:1624-1630,1649-1656` | name omitted for a missing/nameless contact |
| D18 | Restore with a landlord: 404/409 contact checks; ONE conditional write; landlordId set, old row out, new row (kept if seated, role pinned), primary consistent | CONFORMS | `units.ts:1658-1678`; `unitsRepo.ts:1103-1175` (old row dropped :1128-1129, upsert with role pinned :1130-1145, primary moved :1151-1154) | `app/test/unitsRestoreLandlord.test.ts:146-196`; repo-int `:87,110` |
| D19 | Restore without a landlord: REMOVE landlordId, old row out, primary cleared | CONFORMS | `unitsRepo.ts:1128-1129,1148,1155-1159` | repo-int `:127,144`; route test `:228` |
| D20 | Body honored only when the plain restore would refuse; else ignored | CONFORMS | `units.ts:1632` (`!needsLandlord` -> plain path) | test `:196` |
| D21 | Each write conditions on the landlordId read; conflict 409 `unit_roster_conflict`; dashboard re-reads | CONFORMS (ruling S4-2) | `unitsRepo.ts:1118,1164-1170`; `units.ts:1680-1683`; `ListingDetail.tsx:1408-1421` | body writes conditioned; plain path unconditioned as ruled - see INFO-3 |
| D22 | Audit `unit_restored` gains `landlordReplaced { from, to }` / `landlordCleared { from }` | CONFORMS | `units.ts:1690-1695` | |
| D23 | Restore dialog: sentence, landlords-only picker (Add property's source), three buttons, disabled until picked | CONFORMS | `RestoreLandlordDialog.tsx:52,86-120` | source matches `UnitCreateForm.tsx:144`; bound copy per ruling S4-8 |
| D24 | Normal case: no dialog | CONFORMS | `ListingDetail.tsx:364-381` | only 409 `restore_needs_landlord` opens it; other failures keep today's behavior (W7 pins) |
| D25 | Contact list: caseworker NEW seat -> 409 `contact_list_caseworker` (any role) | CONFORMS | `units.ts:1131-1136` | seat = `unitContacts(unit)` row |
| D26 | Contact list: editing/removing a held seat not refused | CONFORMS | `units.ts:1131-1132` | test `unitsApiRosterTypeChecks.test.ts:93` |
| D27 | Contact list: check order caseworker -> landlord -> repo `landlord_reassignment_required` | CONFORMS | `units.ts:1132,1139,1149` | tests :83, :183 |
| D28 | Add contact picker hides caseworkers | CONFORMS | `ListingDetail.tsx:395-397` | |
| D29 | Copy: five codes, plan section 1 sentences and phrase table | CONFORMS | `contactTypeErrors.ts:13-47` | byte-exact; null otherwise (W7) |
| D30 | Site `TourDetail.tsx` status changes (spec :382) | CONFORMS | `TourDetail.tsx:383` | |
| D31 | Site `TourDetail.tsx` Start placement / from-tour (spec :514) | CONFORMS | `TourDetail.tsx:515-517` | |
| D32 | Site `TourDetail.tsx` outcome then from-tour (spec :589) | CONFORMS | `TourDetail.tsx:591-594` | |
| D33 | Site `ScheduleTourForm.tsx` (spec :326) | CONFORMS | `ScheduleTourForm.tsx:327-337` | fallback line untouched (ruling S3-4) |
| D34 | Site `PlacementCreateForm.tsx` (spec :248) | CONFORMS | `dashboard/src/routes/placements/PlacementCreateForm.tsx:249-259` | |
| D35 | Site `PlacementsPage.tsx` (spec :96) | CONFORMS | `dashboard/src/routes/placements/PlacementsPage.tsx:96-99` | |
| D36 | Site `PlacementDetail.tsx` (spec :402) | CONFORMS | `dashboard/src/routes/placements/PlacementDetail.tsx:403-412`, alert bar :571 | |
| D37 | Site `UnitCreateForm` | CONFORMS | `dashboard/src/routes/listing/UnitCreateForm.tsx:258-266` | |
| D38 | Site `ListingDetail.tsx` `runRosterWrite`, mapped before the catch-all 409 | CONFORMS | `ListingDetail.tsx:432-441` | |
| D39 | Site: the restore action | CONFORMS | `ListingDetail.tsx:373-377`; dialog errors `RestoreLandlordDialog.tsx:67-79` | |
| D40 | Added site (ruling S3-1): `TourModals.tsx` `failureCopy` (Reschedule revive + Reopen) | CONFORMS | `dashboard/src/routes/tours/TourModals.tsx:50-54` | contact-type copy first, then today's 409 rule |

### E. Spec section 5 (surface inventory)

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| E1 | Classification writers: contacts PATCH (D2) | CONFORMS | C1-C10 | |
| E2 | `POST /api/contacts` any type: no check needed | CONFORMS | unchanged | |
| E3 | Conversion unchanged | CONFORMS | C9 | |
| E4 | Importer re-type: out of scope, filed | CONFORMS | F9 | |
| E5 | AI extraction only suggests a type | CONFORMS | unchanged | |
| E6 | Tenant-only accept effects: `resolve`, `recoverAbandoned`, journal sweep all via `commitContactEffect` | CONFORMS | B6-B8; sweep tests `suggestionReclassification.test.ts:402`, `suggestionReclassification.integration.test.ts:291` | |
| E7 | Tour/placement create, revive, reopen: the six surfaces; no job or dev seam creates/reopens | CONFORMS | D2-D7; `tours.create` / `placements.create` / `reopenIf` called only from the routes; placements PATCH refuses `stage` (`placements.ts:284-286`) | |
| E8 | landlordId writers: four surfaces; importer filed | CONFORMS | D12-D22; F9 | `units` WRITABLE_FIELDS has no `contacts` key |
| E9 | Contact-list seats: `POST /api/units/:id/contacts` only | CONFORMS | D25-D27 | restore-with-landlord seats a landlord-typed contact (RF2-N3, I4 holds) |
| E10 | Seeds satisfy I2-I4; invariant test over every profile | CONFORMS | `seedContactTypeInvariants.test.ts:55-135` | other seed modules write no tours/placements/units |
| E11 | e2e fixtures correctly typed (W3) | CONFORMS | S5 sweep; full gate `p3-e2e` 345/345 passed, exit 0 | no e2e fixture needed a change |
| E12 | Readers unchanged (tour reminders, nudges, relay fan-out, timeline, UnknownFile placements list, Possible caseworkers) | CONFORMS | no file under `app/src/jobs/` or the reminder/nudge routes changed; UnknownFile placements list untouched | |

### F. Spec section 7 (docs)

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| F1 | RUNBOOK "What the conversion does not fence": accept refused/fenced, hand-clear for extraction + importer only; add L1 | CONFORMS | `RUNBOOK.md:473,475` | also the RF1-F3 clause (:475) |
| F2 | Resolve `claimed-suggestion-accept-after-caseworker-conversion` (status, date, Resolution) | CONFORMS | `docs/issues/claimed-suggestion-accept-after-caseworker-conversion.md:6-7,62-92` | records the #19 deploy |
| F3 | Resolve `contact-retype-skips-caseworker-refusals` | CONFORMS | `docs/issues/contact-retype-skips-caseworker-refusals.md:6-7,34-57` | |
| F4 | Resolve `tours-placements-no-contact-type-check` | CONFORMS | `docs/issues/tours-placements-no-contact-type-check.md:6-7,45-88` | |
| F5 | Third issue correction: contact-list add is in `units.ts`, not `rosterEdits.ts` | CONFORMS | same file :77-80; refs line fixed :10 | |
| F6 | Third issue correction: a placement can leave lost/moved_in with no guard | CONFORMS | same file :80-84 | |
| F7 | Third issue: tenant-only ruling (not `unknown`) recorded | CONFORMS | same file :50-54 | |
| F8 | File `placement-terminal-stage-exit-unguarded` | CONFORMS | `docs/issues/placement-terminal-stage-exit-unguarded.md` | |
| F9 | File `import-bypasses-contact-type-rules` | CONFORMS | `docs/issues/import-bypasses-contact-type-rules.md` | incl. RF1-F2 voucherSize/notes bullet |
| F10 | File `landlord-of-record-no-reassign-ui` | CONFORMS | `docs/issues/landlord-of-record-no-reassign-ui.md` | incl. RF2-N2 row-swap sentence, RE-5 wording |
| F11 | File `unit-primary-contact-unchecked` (plan review row 7) | CONFORMS | `docs/issues/unit-primary-contact-unchecked.md` | refs re-derived (RE-2) match HEAD |
| F12 | GLOSSARY only if a new noun appears | CONFORMS | no GLOSSARY change; no new domain noun | |
| F13 | `stale-suggestions-survive-contact-retype` partly-addressed note (RE-4) | CONFORMS | `docs/issues/stale-suggestions-survive-contact-retype.md:9,37-49` | status stays open |

### G. Spec section 8 (tests), each bullet

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| G1 | D1 (A) paused claim + conversion -> 409 reclassified, no authority, emit, journal completed - fake and real | CONFORMS | fake `app/test/suggestionReclassification.test.ts:483-511`, emit :618; real `suggestionReclassification.integration.test.ts:211` | emit on FakeWorld only (ruling S1-5) |
| G2 | D1 (B) crash after claim, convert, recover via read and via sweep - fake and real | CONFORMS | fake :377, :402; real :279, :291 | |
| G3 | Address and phone accepts claimed before the conversion still commit | CONFORMS | fake :578, :597; real address at repo level (`suggestionResolutionRepo.integration` neutral-guard case) | phone fake-only (plan review row 8) |
| G4 | voucherSize accept spanning a generic tenant -> landlord re-type refused as reclassified | CONFORMS | fake :513, :424 (recovery); real `suggestionReclassification.integration.test.ts:232` | |
| G5 | Each tenant-only target on a non-tenant refused, chip survives; dismiss not refused | CONFORMS | `suggestionReclassification.test.ts:249,277,296` | FakeWorld (plan Task 1.2); pre-claim, no repo write involved |
| G6 | Status and prior-authority accepts spanning a conversion answer reclassified | CONFORMS | fake :534, :554; real status `suggestionReclassification.integration.test.ts:257`; repo-level tie on DynamoDB Local | |
| G7 | Legacy journal onto a converted contact ends superseded (not stale) ON THE REAL REPO; onto an unconverted one commits | CONFORMS | `suggestionResolutionRepo.integration.test.ts:572` + PIN; `suggestionReclassification.integration.test.ts:322,339` | W4 |
| G8 | `effectiveGuard` is the one function the three sites and the fake call | CONFORMS | `suggestionReclassificationGuard.test.ts:324-350` + behavior suites | |
| G9 | D1 dashboard: both copy entries; refetch on reclassified | CONFORMS | `types.test.ts:133`; `ContactDetail.test.tsx:776` | |
| G10 | D2 PATCH matrix (all types; placement, tour, live unit refused; deleted-only allowed; seat never) | CONFORMS | `app/test/contactTypeChangeRefusals.test.ts:91-285` | |
| G11 | D2 conversion unchanged (its tests stay green) | CONFORMS | conversion test files untouched; `p3-npmtest` exit 0 | |
| G12 | D2 dashboard tests: edit form and Unknown card | CONFORMS | `ContactEditForm.test.tsx` (3 cases), `UnknownFile.test.tsx` (3), `ContactDetail.test.tsx` (3 Mark-as cases) | |
| G13 | D3 each surface refuses and still accepts the valid case | CONFORMS | `toursCreateContactType`, `toursReviveContactType`, `toursReopenContactType`, `placementsCreateContactType`, `placementsFromTourContactType`, `statusTransitionContactType`, `transitionRoutesContactType`, `unitsLandlordOfRecord`, `unitsApiRosterTypeChecks` | |
| G14 | D3 tour PATCH canceled -> toured / no_show / scheduled | CONFORMS | `toursReviveContactType.test.ts:58-90` | |
| G15 | D3 roster re-assert and existing-seat edits stay allowed | CONFORMS | `unitsApiRosterTypeChecks.test.ts:93,174` | |
| G16 | D3 restore: plain (valid, ownerless), 409 (non-landlord, missing), with, without, body ignored, dialog's three actions | CONFORMS | `unitsRestoreLandlord.test.ts:57-241`; `RestoreLandlordDialog.test.tsx` (9 cases) | |
| G17 | D3 `deriveTenantStatus` skips a non-tenant | CONFORMS | `deriveTenantStatusSkip.test.ts:62-118` | |
| G18 | D3 TenantFile hides both buttons for a team member | CONFORMS | `TenantFile.test.tsx` (2 cases) | |
| G19 | D3 Add contact picker hides caseworkers | CONFORMS | `ListingDetail.test.tsx` (picker case) | |
| G20 | D3 each dashboard copy site shows its sentence | CONFORMS | tests in TourDetail (3), TourModals (5), ScheduleTourForm (2), PlacementCreateForm (2), PlacementsPage (2), PlacementDetail (2), UnitCreateForm (it.each), ListingDetail (roster it.each, restore cases) | |
| G21 | Seeds: invariant test | CONFORMS | E10 | |
| G22 | e2e: type change from the edit form | CONFORMS | A39 | |
| G23 | e2e: Add contact hides a caseworker | CONFORMS | A40 | |
| G24 | e2e: a refused tour action shows its sentence | CONFORMS | A41 | plus the placement path A42 and restore A43 |

### H. Watch items

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| H1 | W1 invariant rule (unlisted surface -> STOP-and-record) | CONFORMS | RF1-F1 and RF2-N1 were stopped and ruled (Q1, Q2); this review's sweep found no further writer (E7-E9) | |
| H2 | W2 conversion byte-identical | CONFORMS | C9, C11 | |
| H3 | W3 fixture fixes never weaken a rule | CONFORMS | app fixes seed correctly typed contacts only (`toursApi.test.ts:61-103`, units fixtures `world.contacts.push({..., type: 'landlord'})`); no guard stubbed | e2e: no fixture change needed; full gate 345/345 |
| H4 | W4 legacy case on DynamoDB Local | CONFORMS | G7 | |
| H5 | W5 listing-status derivation untouched | CONFORMS | D10 | property-status asserted in the skip tests |
| H6 | W6 `caseworker_use_conversion` wins | CONFORMS | `contacts.ts:1635` before :1644; test `contactTypeChangeRefusals.test.ts:264` | |
| H7 | W7 fallbacks untouched; helper null otherwise | CONFORMS | `contactTypeErrors.ts:44-45`; every site falls through to its prior copy | null cases pinned `contactTypeErrors.test.ts` |

### I. Planner rulings Q1 / Q2

| # | Item | Status | Evidence | Note |
|---|---|---|---|---|
| I1 | Q1: HA chip on a non-tenant skips the review, sends the plain accept, shows the D1 sentence, no PATCH | CONFORMS | `ContactDetail.tsx:844-849` | test `ContactDetail.test.tsx` "a TEAM MEMBER chip skips the review..." + tenant PIN |
| I2 | Q2: ownerless notice sentence (exact), two test pins, selectors row, stale comment fixed; other branch unchanged | CONFORMS | `ListingDetail.tsx:505-521` (:520 sentence); `ListingDetail.test.tsx:1728,1749`; `e2e/support/selectors.md:85` | old sentence absent repo-wide |

### J. Binding rulings and adjudications, spot-verified

| # | Item | Status | Evidence |
|---|---|---|---|
| J1 | P-1 two-sentence form + phrase table, fallback "not a tenant" | CONFORMS | `contactTypeErrors.ts:13-23,34` |
| J2 | S1-1 `TENANT_ONLY_TARGETS` in `runTypes.ts`, re-exported | CONFORMS | `app/src/services/extraction/runTypes.ts:28`; `suggestionResolution.ts:34` |
| J3 | S2-2 conversion drops `TERMINAL_STAGES` / `unitContacts` / private set | CONFORMS | conversion diff |
| J4 | S2-3 `contactTriage.test.ts` precondition -> roster seat | CONFORMS | `app/test/contactTriage.test.ts` diff |
| J5 | S2-5 type check inside the classification block, before the org-name 422 | CONFORMS | `contacts.ts:1644` vs :1681 |
| J6 | S3-3 tour fixture seeds absent tenants only, pinned | CONFORMS | `toursApi.test.ts:61-103,120-144` |
| J7 | S4-4/RD-1 conditions on landlordId + contacts[], 3 attempts pinned | CONFORMS | `unitsRepo.ts:1164-1170`; `unitsRepoRestoreWithLandlord.integration.test.ts:228` |
| J8 | S4-5 contact-list contact read consistent | CONFORMS | `units.ts:1116` |
| J9 | S4-6 / S4-7 empty PATCH id -> 404; bad restore body -> 400 | CONFORMS | `units.ts:1495-1497,1610-1612` |
| J10 | S4-9 enriched roster on the body path | CONFORMS | `units.ts:1702` |
| J11 | S4-12 three Restore entry points share `onRestore` | CONFORMS | `ListingDetail.tsx:710,721,733` |
| J12 | Plan review row 5 / row 6: conflict settles via `applyRosterUnit`; one `ROSTER_RETRY_COPY` | CONFORMS | `ListingDetail.tsx:1413`; `dashboard/src/routes/listing/rosterCopy.ts:7` (value identical to base) |
| J13 | Plan review row 11: `landlordId` optional, no unsafe read | CONFORMS | A36 |
| J14 | RA-N1, RC-F1, RE-1 dispositions | CONFORMS | `ContactDetail.test.tsx:762`; `toursApi.test.ts:2616-2619`; `placements-page.spec.ts:373` |

## Non-CONFORMS items

None. No row is PARTIAL, MISSING or DEVIATES.

## Observations (INFO; the code conforms - recorded for the handback)

1. **INFO - the legacy fallback refuses a pre-deploy claim on a conversion
   that was later put back.** `effectiveGuard` (`suggestionResolutionRepo.ts:480-487`)
   requires `caseworker_conversion` absent for a pre-deploy tenant-only
   journal, exactly as spec D1 change 4 defines. `caseworker_conversion` is
   server-owned and never removed (`contacts.ts:298`), so a contact converted
   and then returned to tenant by the RUNBOOK's "putting a mistaken conversion
   back" steps keeps it: an old-code claim on that tenant, crashed and finished
   by recovery after this deploy, ends `superseded` (nothing written, chip
   gone) although no reclassification spanned the claim. Safe direction, tiny
   window (pre-deploy crashed claims only). Fix: none required; optionally one
   clause in the resolved issue's known-limit sentence.
2. **INFO - spec premise changed; one RUNBOOK sentence becomes due at deploy.**
   #19 was deployed to dev and prod on 2026-10-12 (release 1.5.1) before this
   fix (build-research README "Main moved"). D1 change 7 (no repair step) is
   still built as specified, but the legacy fallback is now load-bearing in
   production and any authority an accept wrote onto a converted caseworker in
   the meantime stays until hand-cleared (`RUNBOOK.md:473` has the call). Main
   @794de277 also adds to the RUNBOOK Caseworkers heading: "Until it is live,
   a caseworker converted while a housing authority suggestion accept was in
   flight can end up holding that authority". Fix: at the one main sync,
   reconcile that line with this branch's :473 paragraph, and name in the
   handback a post-deploy RUNBOOK update (mark that sentence done once this
   branch is live) - the mission block says "none expected".
3. **INFO - the plain restore stays unconditioned (ruling S4-2).** Spec
   section 4 says "Each write conditions on the landlordId it read"; the body
   writes do (`unitsRepo.ts:1118,1164`), the plain path (`units.ts:1635`) does
   not, as ruled. Its residual risk is the contact re-type between the route's
   consistent read and the write - the L1 class, which a landlordId condition
   would not catch anyway. Fix: none.
4. **INFO - two restore success shapes.** The plain path answers the raw unit,
   the body path the enriched roster (`units.ts:1702`, ruling S4-9). A dialog
   restore that lands on the plain path (stored landlord re-typed back to
   landlord meanwhile) applies a raw roster to the Contacts card and ignores
   the pick, as the spec requires. Cosmetic and rare; already recorded in the
   S4a/S4b reports. Fix: none in this branch.
5. **INFO - D1 "not a tenant" refusal and phone commit are FakeWorld-only.**
   Spec 8's "real AND fake" header is met for the schedules, the generic
   re-type, the status tie and the legacy case (plan review row 8); the
   per-target pre-claim refusal (no repo write involved) and the phone case
   (`commitPhoneEffect`, untouched) run on FakeWorld only, as the plan maps
   them (Task 1.2, row 8). Fix: none.
6. **INFO - gates not settled by this review.** Lint gate 5 was not run here
   (the full e2e did finish green: 345/345, exit 0). The main sync is still owed
   (main is three commits ahead: `e27868bc`, `794de277`, `5c0d3f6a`; they meet
   `app/src/repos/unitsRepo.ts`, `app/test/unitsApi.test.ts` and `RUNBOOK.md`;
   `unitFields.ts` there adds only a clearable `voucher_size_accepted`, which
   does not change the S4 `landlordId` check). Fix: the orchestrator's gate
   battery after the sync.
