# Final review - spec conformance (fix/caseworker-integrity)

Reviewer: independent spec-conformance reviewer for the planner (not the
builder). Read-only: no test, vitest, e2e, server or DynamoDB run; git reads,
grep and file reads only.

- Worktree / branch: `W:\tmp\caseworker-integrity`, `fix/caseworker-integrity`,
  tip 63b66bc1 (product tip 5ffcb6c6; main @5c0d3f6a merged in, so
  `git diff main...HEAD` is the branch's own change).
- Contract: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`
  revision 5.
- Method: every decision, rule, error code, copy string, ordering rule,
  consistency requirement, test requirement (section 8) and doc obligation
  (section 7) walked to the code / test / doc at the tip. The builder's
  handback was treated as claims only. Copy strings were compared byte for
  byte (spec and all copy sources are pure ASCII; verified with a non-ASCII
  grep). Section 9 (gates) is not assessed here: it needs runs, which this
  review may not do.

## Totals

| Verdict | Count |
| --- | --- |
| CONFORMS | 100 |
| DEVIATES | 2 |
| MISSING | 0 |

Both deviations are recorded planner rulings (not silent drift), both LOW.
No BLOCKING, HIGH or MEDIUM finding.

## Item table

Paths are relative to the worktree. "repo" = `app/src/repos/suggestionResolutionRepo.ts`;
"svc" = `app/src/services/suggestionResolution.ts`.

### Section 2 - D1 accept fence

| # | Spec item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | D1.1 the contact read feeding buildPlan is consistent | CONFORMS | svc:812 |
| 2 | D1.2 ACCEPT of a tenant-only target on a non-tenant -> 409 `suggestion_contact_not_tenant`, before the claim | CONFORMS | svc:819-826 (precedes claim at :849) |
| 3 | D1.2 chip not consumed; dismiss never refused | CONFORMS | svc:820 (`action === 'accept'` only); test `app/test/suggestionReclassification.test.ts:294,334` |
| 4 | D1.2 for `status`, the type check runs before the allowlist check | CONFORMS | svc:819 runs before buildPlan (:835), whose allowlist is at :297 |
| 5 | I1 tenant-only set (seven targets); neutral targets untouched | CONFORMS | `app/src/services/extraction/runTypes.ts:28-30` |
| 6 | D1.3 guard carries `classification_revision` (`{exists:false}` / `{exists:true,value}`) for tenant-only accepts, every plan arm | CONFORMS | svc:221-234, :309 (status), :368 (housingAuthority), :391 (generic); address/phone arms unfenced |
| 7 | D1.4 ONE exported pure `effectiveGuard(journal)`; legacy tenant-only journal without the key gets `caseworker_conversion: {exists:false}` | CONFORMS | repo:485-492 (no mutation of the stored plan) |
| 8 | D1.4 used at all three real-repo sites (commit condition, consistent re-read, mismatch ConditionCheck) | CONFORMS | repo:867-868, :898, :912; no `.plan.guard` read remains |
| 9 | D1.4 the fake uses the same function | CONFORMS | `app/test/helpers/suggestionResolutionFake.ts:21,344` |
| 10 | D1.5 result union gains `superseded_by_reclassification` (real and fake) | CONFORMS | repo:168; fake:175-177 |
| 11 | D1.5 returned when the mismatch is in a classification key; classification wins a tie | CONFORMS | repo:500-511 (`guardMismatchIsClassification`), :907-910, :931/:941; fake:345-348 |
| 12 | D1.5 stored outcome and run-log verdict as for `superseded_by_human_edit` | CONFORMS | repo:407 (journalSuperseded unchanged); fake:200; verdict asserted at test:542-545 |
| 13 | D1.5 service answers 409 `suggestion_contact_reclassified` for its own claim only; helpers keep today's answers | CONFORMS | svc:894-896; help path ignores flags svc:779-783 |
| 14 | D1.6 route emits `suggestion.updated` for reclassified exactly as field_edited; not_tenant emits nothing | CONFORMS | `app/src/routes/suggestions.ts:227-229` |
| 15 | D1.6 dashboard copy map: both strings byte-exact | CONFORMS | `dashboard/src/api/types.ts:1697-1702` |
| 16 | D1.6 refetch list adds `suggestion_contact_reclassified` | CONFORMS | `dashboard/src/routes/contact/ContactDetail.tsx:738-743` |
| 17 | D1.7 no repair step | CONFORMS | none built |

### Section 3 - D2 type-change refusals

| # | Spec item | Verdict | Evidence |
| --- | --- | --- | --- |
| 18 | Applies to the contacts PATCH (edit form and Unknown card both reach it), every target type incl. `team_member` / `unknown` | CONFORMS | `app/src/routes/contacts.ts:1644-1645` |
| 19 | Result not `tenant` -> refused by any open placement / open tour (I2) | CONFORMS | `app/src/services/contactHoldings.ts:129-136` |
| 20 | Result not `landlord` -> refused by LIVE landlord-of-record units; soft-deleted not counted | CONFORMS | contactHoldings.ts:137-141 (`deleted: false`) |
| 21 | Contact-list seats never refuse | CONFORMS | no roster read in typeChangeRefusals |
| 22 | Order: after 409 `caseworker_use_conversion`, before any write; role-only change not checked | CONFORMS | contacts.ts:1631-1655 (`'type' in patch && newType !== stored.type`) |
| 23 | 409 `{ error: 'type_change_refused', refusals }`, codes open_placement / open_tour / landlord_of_record, kind order then id ascending | CONFORMS | contacts.ts:1651; contactHoldings.ts:41-42,123-143 |
| 24 | Shared module returns kinds separately; per-call live-only or any-deleted | CONFORMS | contactHoldings.ts:46-114 |
| 25 | Conversion unchanged: codes `caseworker_*`, read order, id order, deleted-unit counting, roster Scan excluding landlord units | CONFORMS | `app/src/services/caseworkerConversion.ts:224-239` (diff read line by line against main; its three test files are not in the diff) |
| 26 | PATCH asks only for the kinds its rule needs; never the roster Scan | CONFORMS | contactHoldings.ts:123-143 |
| 27 | `refusalCopy` moved to a shared module keyed by KIND; dialog's four sentences and links byte-identical | CONFORMS | `dashboard/src/lib/holdingRefusals.ts:39-66`; `CaseworkerDialog.tsx:66-77` (removed literals match) |
| 28 | Generic change: same sentences for placement / tour; own landlord-of-record sentence byte-exact with View property | CONFORMS | holdingRefusals.ts:35-36, :70-79 |
| 29 | Edit form: on 409 keeps the draft, shows each sentence + View link beside the kind picker; caseworker copy and "Couldn't save - please try again." kept | CONFORMS | `ContactEditForm.tsx:524-534, :609` |
| 30 | Unknown card stops swallowing; refusals with links on the card; any other failure "Couldn't save - please try again." | CONFORMS | `ContactDetail.tsx:673-691`; `UnknownFile.tsx:155-165` |

### Section 4 - D3 tours, placements, properties

| # | Spec item | Verdict | Evidence |
| --- | --- | --- | --- |
| 31 | All new contact reads consistent; a soft-deleted contact still "exists" | CONFORMS (see F4) | `app/src/services/contactTypeGuards.ts:68-74, :86-92` |
| 32 | `POST /api/tours`: 404 `tenant_not_found` / 409 `contact_not_tenant` | CONFORMS | `app/src/routes/tours.ts:354-359` (after body validation, before any write) |
| 33 | Tour PATCH from `canceled` into any open status (reschedule auto-advance, `toured`, `no_show`) checked; open->open and ->closed not | CONFORMS | tours.ts:1404-1411 (keys on `effectiveStatus`, before the write) |
| 34 | `POST /api/tours/:id/reopen` checked | CONFORMS | tours.ts:1695-1700 (after the reopen decision, before `reopenIf`) |
| 35 | `POST /api/placements`: 404 kept, adds 409 | CONFORMS | `app/src/routes/placements.ts:581-586` |
| 36 | `POST /api/placements/from-tour`: adds 409 before any write | CONFORMS | placements.ts:677-682 (before the conversion claim) |
| 37 | Placement terminal -> non-terminal checked in the service; other moves not | CONFORMS (see F8) | `app/src/services/statusTransition.ts:420-422`; the route is the only caller |
| 38 | 409 body `{ error: 'contact_not_tenant', contactKind }`; caseworker when isCaseworker, else stored type | CONFORMS (see F3) | contactTypeGuards.ts:107-110; `app/src/lib/caseworkers.ts:98-101` |
| 39 | Dedicated error class; `handleTransitionError` maps 409 / 404 `tenant_not_found` | CONFORMS | `app/src/routes/statusTransition.ts:336` |
| 40 | `deriveTenantStatus` writes nothing for a non-tenant, logs info; listing derivation unchanged | CONFORMS | services/statusTransition.ts:345-351; listing derivation separate at :399, :540 |
| 41 | TenantFile hides "+ Schedule" and "+ Start placement" for a team member | CONFORMS | `TenantFile.tsx:169, :325, :353` (only entry points; ContactDetail.tsx:1230-1231) |
| 42 | Server refuses a team member like any non-tenant | CONFORMS | contactTypeGuards.ts:73 |
| 43 | `POST /api/units`: 404 `landlord_not_found` / 409 `landlord_not_landlord` | CONFORMS | `app/src/routes/units.ts:549-557` |
| 44 | `PATCH /api/units/:id` with a CHANGED landlordId: same | CONFORMS | units.ts:1599-1621 (changed decided on a consistent unit read) |
| 45 | Roster landlord claim of a vacant slot -> 409 `landlord_not_landlord`; re-assert of the owner not checked | CONFORMS | units.ts:1210-1216; `app/src/repos/unitsRepo.ts:925` |
| 46 | Plain restore: ownerless or landlord-typed -> as today; else 409 `restore_needs_landlord` `{ landlordName? }`, nothing written | CONFORMS (see F5) | units.ts:1734-1771 |
| 47 | Restore with a landlord: 404 / 409; ONE conditional write; old row removed; new row role `landlord`, kept if seated; primary consistent | CONFORMS | units.ts:1774-1791, :1803-1805; unitsRepo.ts:1251-1360 |
| 48 | Restore without a landlord: landlordId removed, old row removed, primary_contact pointing at them cleared, same write | CONFORMS | unitsRepo.ts restoreWithLandlord (patch landlordId null, scalar null) |
| 49 | Sole-landlord promotion: cleared landlord was primary and exactly ONE remaining landlord-typed row (any role) -> primary in the same write; zero / two-plus -> nobody | CONFORMS | units.ts:435-464; unitsRepo.ts (promote branch) |
| 50 | Promotion inputs read consistently; write conditioned on the roster read -> 409 `unit_roster_conflict`; soft-deleted / missing / pointer contacts not eligible | CONFORMS | units.ts:452-462, :1800-1811; unitsRepo.ts:1281-1283 |
| 51 | A body is honored only when the plain restore would refuse; otherwise ignored | CONFORMS | units.ts:1747-1771 |
| 52 | "Each write conditions on the landlordId it read" -> 409 `unit_roster_conflict` | DEVIATES (F1) | units.ts:1750 (plain path unconditioned) |
| 53 | Audit `unit_restored` gains `landlordReplaced {from,to}` / `landlordCleared {from}` / `primaryPromoted {to}` | CONFORMS | units.ts:1829-1837 |
| 54 | Dashboard: 409 `restore_needs_landlord` opens the dialog; normal case no dialog | CONFORMS | `ListingDetail.tsx:376-386` (all three Restore buttons call onRestore) |
| 55 | Dialog sentence byte-exact with the "This property's landlord" fallback | CONFORMS | `RestoreLandlordDialog.tsx:108, :122` |
| 56 | Picker: landlords only, same source as Add property | CONFORMS | RestoreLandlordDialog.tsx:57; `UnitCreateForm.tsx:144` |
| 57 | Three actions; "Restore with this landlord" disabled until a pick | CONFORMS | RestoreLandlordDialog.tsx:96-116 |
| 58 | Contact list: 409 `contact_list_caseworker` for a NEW seat, any role; an existing seat stays editable | CONFORMS | units.ts:1203-1209 |
| 59 | Check order `contact_list_caseworker` then `landlord_not_landlord`, both before the repo call; repo's `landlord_reassignment_required` after | CONFORMS | units.ts:1203-1216; unitsRepo.ts:924-932 |
| 60 | Add contact picker hides caseworkers | CONFORMS | ListingDetail.tsx:402-404 |
| 61 | Auto-primary: NEW seat, contact typed `landlord`, no primary row, no landlordId -> primary (Landlord-role claim included); any other type joins non-primary | CONFORMS | unitsRepo.ts:945-949, :959 |
| 62 | Auto-primary decided inside the conditional write from each attempt's read; type read consistently by the route | CONFORMS | units.ts:1182, :1233; unitsRepo.ts:945 |
| 63 | FakeWorld mirrors addContact rules and restoreWithLandlord | CONFORMS | `app/test/helpers/twilioWebhookHarness.ts` (diff) |
| 64 | One shared dashboard helper for the section 4 codes | CONFORMS | `dashboard/src/lib/contactTypeErrors.ts` |
| 65 | `contact_not_tenant`: "Tours and placements are for tenants. This contact is a <kind label>." | DEVIATES (F2) | contactTypeErrors.ts:13-23, :34 |
| 66 | `tenant_not_found`, `landlord_not_landlord`, `landlord_not_found`, `contact_list_caseworker` sentences byte-exact | CONFORMS | contactTypeErrors.ts:36-43 |
| 67 | TourDetail status changes, Start placement / from-tour, outcome then from-tour | CONFORMS | `TourDetail.tsx:383, :516, :592` |
| 68 | Tour dialogs (Reschedule / Reopen) | CONFORMS | `TourModals.tsx:50-54` (before the 409 reload copy) |
| 69 | ScheduleTourForm and PlacementCreateForm | CONFORMS | `ScheduleTourForm.tsx:330`; `PlacementCreateForm.tsx:252` |
| 70 | PlacementsPage and PlacementDetail stage moves (the only two dashboard transition callers) | CONFORMS | `PlacementsPage.tsx:98`; `PlacementDetail.tsx:407-411` |
| 71 | UnitCreateForm | CONFORMS | UnitCreateForm.tsx:261 |
| 72 | `runRosterWrite` maps the new codes BEFORE its 409 catch-all | CONFORMS | ListingDetail.tsx:443-447 |
| 73 | Restore action (dialog's own landlord_* refusals included) | CONFORMS | RestoreLandlordDialog.tsx:77-80 |
| 74 | Any other failure keeps each site's copy | CONFORMS | each site falls through to its prior copy |

### Sections 5, 6, 10 - surfaces, limits, non-goals

| # | Spec item | Verdict | Evidence |
| --- | --- | --- | --- |
| 75 | Seeds satisfy I2-I4; invariant test over every profile (lean, full = cast + matrix + live, performance) | CONFORMS | `app/test/seedContactTypeInvariants.test.ts:54-59, :123-135` |
| 76 | e2e fixtures use correctly typed contacts | CONFORMS | fixture edits in `toursApi`, `unitsApi*`, `placementsVoiceRouting` tests; e2e green per handback (not re-run here) |
| 77 | L1 / L2 / L3: no lock, no backfill, extraction untouched | CONFORMS | no such code in the diff |
| 78 | Non-goals: conversion behavior / codes / copy unchanged; no deleted-contact refusal; no reassign UI; importer untouched | CONFORMS | items 25, 27, 31; `app/src/lib/import` not in the diff |

### Section 7 - docs

| # | Spec item | Verdict | Evidence |
| --- | --- | --- | --- |
| 79 | RUNBOOK "What the conversion does not fence": accept refused / fenced (D1), hand-clear now for extraction + importer only | CONFORMS | `RUNBOOK.md:475` |
| 80 | RUNBOOK adds L1 | CONFORMS | RUNBOOK.md:477 |
| 81 | Three issues resolved (status, resolved date, Resolution paragraph) | CONFORMS | frontmatter + `**Resolution (2026-10-12).**` in each |
| 82 | `tours-placements-no-contact-type-check` corrected: `units.ts` not `rosterEdits.ts`; terminal exit unguarded; tenant-only ruling | CONFORMS | that file :45-56, :80-82 |
| 83 | File `placement-terminal-stage-exit-unguarded` | CONFORMS | docs/issues, status open |
| 84 | File `import-bypasses-contact-type-rules` (re-type, landlordId, no revision bump) | CONFORMS | title and refs name all three |
| 85 | File `landlord-of-record-no-reassign-ui` | CONFORMS | docs/issues, status open |
| 86 | GLOSSARY only if a new noun appears | CONFORMS | no new noun; GLOSSARY untouched |

### Section 8 - tests

| # | Spec item | Verdict | Evidence |
| --- | --- | --- | --- |
| 87 | D1 schedule A on FakeWorld routes: 409, no authority, emit, journal completed | CONFORMS | test:521-546 (409, no authority, completed), test:656-677 (emit) |
| 88 | D1 schedule A on the real repos | CONFORMS (see F6) | `suggestionReclassification.integration.test.ts:211` |
| 89 | D1 schedule B (suggestions read, journal sweep) on both | CONFORMS | test:415, :440; integration:279, :291 |
| 90 | Address and phone accepts claimed before the conversion still commit | CONFORMS | test:616, :635; repo integration:658 |
| 91 | voucherSize spanning a generic tenant -> landlord re-type refused as reclassified | CONFORMS | test:551; integration:232 |
| 92 | Each tenant-only target on a non-tenant -> not_tenant, chip survives; dismiss not refused | CONFORMS | test:286-345 (all seven targets) |
| 93 | Status and prior-authority accepts spanning a conversion -> reclassified (tie) | CONFORMS | test:572, :592; integration:257; repo integration:598 |
| 94 | Legacy journal on the REAL repo: converted -> superseded not stale; unconverted -> commits | CONFORMS | integration:322, :339; repo integration:613, :631 |
| 95 | `effectiveGuard` is the one function at the three sites and in the fake | CONFORMS | `suggestionReclassificationGuard.test.ts:324-350` |
| 96 | D1 dashboard: both copy entries; refetch on reclassified | CONFORMS | `dashboard/src/api/types.test.ts`; ContactDetail.test.tsx refetch it.each + not_tenant PIN |
| 97 | D2 PATCH matrix (five types), live landlord refused, soft-deleted allowed, seat never refuses; conversion tests unchanged | CONFORMS | `contactTypeChangeRefusals.test.ts:91-215`; no conversion test file in the diff |
| 98 | D2 dashboard tests: edit form and Unknown card | CONFORMS | ContactEditForm.test.tsx, UnknownFile.test.tsx, ContactDetail.test.tsx |
| 99 | D3 each surface refuses and accepts the valid case; tour PATCH canceled -> toured / no_show / scheduled; roster re-assert and existing-seat edits allowed | CONFORMS | tours*ContactType, placements*ContactType, statusTransitionContactType, transitionRoutesContactType, unitsLandlordOfRecord, unitsApiRosterTypeChecks:93,:174 |
| 100 | Restore: plain (valid, ownerless), needs_landlord (non-landlord, missing), with, without, body ignored, dialog's three actions | CONFORMS | `unitsRestoreLandlord.test.ts:56-266`; `RestoreLandlordDialog.test.tsx` |
| 101 | deriveTenantStatus skip; TenantFile team member; picker hides caseworkers; every copy site | CONFORMS | deriveTenantStatusSkip.test.ts; TenantFile.test.tsx; ListingDetail.test.tsx; each site's test file |
| 102 | e2e: edit-form type change; Add contact hides a caseworker; a refused tour action shows its sentence | CONFORMS | caseworkers.spec.ts, property-roster.spec.ts, tour-auto-close.spec.ts (+ placements-page.spec.ts) |

## Findings

### F1 - LOW - The plain restore is not conditioned on the landlordId it read

Spec section 4 "Restore": "Each write conditions on the landlordId it read,
so a concurrent change answers 409 `unit_roster_conflict`". The body paths
do (`restoreWithLandlord`, unitsRepo.ts:1251-1360, `expectLandlordId` plus
`updateRosterIfCurrent`). The plain path calls today's unconditioned
`units.restore(unitId)` (units.ts:1750; the repo's condition is only
`attribute_exists(unitId)`). This is plan ruling 2 (plan
`2026-10-12-caseworker-integrity.md:9273`), which read "restore exactly as
today" as overriding "each write". Impact is small: every in-scope writer of
`landlordId` is now type-checked, so a concurrent landlordId change can only
install another landlord, and the residual window (the landlord CONTACT
re-typed between the restore's read and its write - the type change does not
count soft-deleted units) is the L1 read-then-write class, which a landlordId
condition would not catch anyway. Disposition suggestion: accept as ruled and
say so in the spec (or the handback's deviations line, which currently says
"none ... except where Cameron or the planner ruled" without naming this one).

### F2 - LOW - `contact_not_tenant` sentence is not the spec's literal form

Spec section 4: "Tours and placements are for tenants. This contact is a
<kind label>." with labels "Caseworker, Landlord, Partner, Team member,
Unknown". The helper renders "This contact is a landlord." (lowercase), "...is
not classified yet." for `unknown`, and "...is not a tenant." for a missing or
unrecognized kind (contactTypeErrors.ts:13-23, :34). This is planner ruling
P-1 as amended by plan review R1 row 2 (adjudications row 2: revert to the
two-sentence form, keep only the phrase handling so "a Unknown" never
appears). The reading is sensible, but spec revision 5 never folded it in, so
the approved contract and the shipped copy differ. Disposition suggestion:
fold the phrase table into the spec, or name it for Cameron as a planner copy
ruling.

### F3 - INFO - `contactKind` falls back to `unknown` for a typeless contact

Spec: "`contactKind` is `caseworker` when `isCaseworker` holds, else the stored
type." `contactKind` (caseworkers.ts:98-101) returns `unknown` when no
non-empty string type is stored, rather than sending `undefined`. Safer than
the literal text; no action.

### F4 - INFO - Routing pointer rows are treated as nonexistent

`requireTenantContact` / `requireLandlordContact` (contactTypeGuards.ts:69,
:87) and the contact-list route (units.ts:1182) answer 404 for a
`phone_ref` / `email_ref` row. The spec's "'Exists' keeps today's meaning"
addressed soft-deleted contacts only; previously a pointer id passed the
placements existence check. This tightens (a pointer row is never a contact,
matching the conversion's readSubject) and changes only 409 -> 404 for an id
that was never a contact. No action.

### F5 - INFO - Restore of a unit that is not soft-deleted skips the landlord check

units.ts:1739 runs the landlord check only when `isDeleted(stored)`; a live
unit "restores" as before (a no-op) and any body is ignored. The spec does not
distinguish; plan ruling 3 chose this so restore can never reassign a LIVE
property's landlord (section 10 non-goal). Consistent with the spec's intent.

### F6 - INFO - Schedule A on the real repos does not assert the emit

The DynamoDB Local run of schedule A (integration:211) drives the service,
not the route, so `suggestion.updated` is asserted only on FakeWorld routes
(test:656-677). The emit is route-only behavior independent of the repo, so
the pair together covers the spec's list. No action.

### F7 - INFO - Ruled additions beyond the spec text (none contradicts it)

- Planner Q1: a housing-authority chip on a non-tenant skips "Is this really
  new?" and sends the plain accept (ContactDetail.tsx:844), closing a path
  where the review's close-name edit would write a tenant fact by plain PATCH.
- `unit_contact_added` audit now records the EFFECTIVE primary flag plus
  `autoPrimary` (units.ts:1265-1278; R2 FW2-2) - a payload change the spec did
  not ask for.
- `addContact` re-decides both contact-list rules per attempt
  (unitsRepo.ts:924-925; R2 challenge B-1) - the route pre-checks keep the
  spec's answer order.
- The ownerless "no primary contact" sentence (ListingDetail.tsx:542) is
  Cameron's SA-1 copy, not spec text.

### F8 - INFO - The terminal-exit check has a window wider than L1 describes

Spec L1 describes the window as GSI propagation lag. The placement transition
decides "leaving a terminal stage" from `placementsRepo.getById`
(services/statusTransition.ts:408), a base-table read that is not consistent,
and the stage write that follows is not conditioned on the stage read, so a
concurrent move can also slip past. This is outside what the spec asked to
build (the check exists, in the service, as specified), it is documented
(RUNBOOK.md:477) and the fix is recorded in
`placement-terminal-stage-exit-unguarded`. No action for this branch.

## Not assessed

Section 9 gates (typecheck, npm test, smoke, e2e, eslint): this review is
read-only and ran nothing; the handback's gate table is a claim for the
planner's own gate run to confirm.
