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

## Round 2

Scope: spec revision 6 (`git diff 8be5b730..1358fb42 -- docs/superpowers/specs/`)
and the final fix wave (`git diff 8be5b730..1358fb42 -- app dashboard e2e
docs/issues RUNBOOK.md`; commits 437686d6..1358fb42), read cold at 1358fb42
against the planner's `final-review/adjudications.md` and the builder's
`final-review/FWF-report.md` (claims only). Read-only again: no test, vitest,
e2e, server or DynamoDB run. Order as asked: (1) re-walk of the touched spec
items, (2) the fix diff for drift, (3) adjudication contests, (4) C1 / C2.

### Re-walk totals (the touched items only)

| Verdict | Count |
| --- | --- |
| CONFORMS | 33 |
| DEVIATES | 2 |
| MISSING | 0 |

Both deviations are SPEC-TEXT drift in revision 6 (the code is the safer
reading in each); no code deviates from a stated code or copy string.

### Re-walk table

"rN" = round 1 item number. Paths relative to the worktree, lines at 1358fb42.

| # | Spec item (rev 6) | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | (r46) Plain restore: ownerless or landlord-typed -> as today; else 409 `restore_needs_landlord` `{ landlordName? }` | CONFORMS | `app/src/routes/units.ts:1767-1773` (check), `:1775-1801` (plain), `:1803-1810` (409) |
| 2 | (r47) Restore with a landlord: 404 / 409 checks, one conditional write, old row out, new row pinned `landlord`, primary consistent | CONFORMS | units.ts:1812-1830; `app/src/repos/unitsRepo.ts` restoreWithLandlord |
| 3 | (r48) Restore without a landlord: landlordId, old row and a primary_contact naming them removed in one write | CONFORMS | unitsRepo.ts:1331, :1340-1348 |
| 4 | (r49) Sole-landlord promotion: exactly one eligible remaining row -> primary; zero / two-plus -> nobody | CONFORMS | units.ts:462-477 |
| 5 | (r50, rev 6) Promotion eligibility IS the shared automatic-routing rule; consistent reads; write conditioned on the roster read -> 409 | CONFORMS | units.ts:145-153 (`autoRoutingEligible`), :474; unitsRepo.ts:1297-1299 |
| 6 | (r51 replaced, rev 6) A body when the plain restore would apply (no longer deleted / landlord typed again / ownerless) -> 409 `unit_roster_conflict`, no restore, no audit | CONFORMS | units.ts:1779-1786 (before `units.restore` at :1789 and the audit); `app/test/unitsRestoreLandlord.test.ts:200-259` (six cases, unit deep-equal, no audit row) |
| 7 | (rev 6) Dashboard re-reads; closes the dialog when the property is no longer deleted | CONFORMS | `RestoreLandlordDialog.tsx:82-84`; `ListingDetail.tsx:1438-1452` |
| 8 | (r52, rev 6) Plain restore is today's unconditioned write (L1) | CONFORMS | units.ts:1789 -> repo `restore` (condition `attribute_exists(unitId)` only). C1 closed |
| 9 | (rev 6) "only the restore with a body conditions its single write on the `landlordId` and contact list it read, so a concurrent change answers 409" | DEVIATES (R2-F1) | unitsRepo.ts:1297 (list check for `next === null` only), retry at :1355-1360 |
| 10 | (r53) Audit `landlordReplaced` / `landlordCleared` / `primaryPromoted` | CONFORMS | units.ts:1867-1876 |
| 11 | (r54) 409 `restore_needs_landlord` opens the dialog; normal case no dialog | CONFORMS | ListingDetail.tsx:376-386 |
| 12 | (r55) Dialog sentence byte-exact, fallback "This property's landlord" | CONFORMS | RestoreLandlordDialog.tsx:92, :122 |
| 13 | (r56) Picker landlords-only, Add property's source | CONFORMS | RestoreLandlordDialog.tsx:57 |
| 14 | (r57) Three actions; with-landlord disabled until a pick | CONFORMS | RestoreLandlordDialog.tsx:96-116 |
| 15 | (r58) 409 `contact_list_caseworker` for a NEW seat, any role | CONFORMS | units.ts:1220-1225 |
| 16 | (r59) Route order caseworker -> landlord_not_landlord, both before the repo call; repo reassignment after | CONFORMS (see R2-F6) | units.ts:1220-1231; unitsRepo.ts:937-945 |
| 17 | (r60) Add contact picker hides caseworkers | CONFORMS | ListingDetail.tsx:402-404 (unchanged) |
| 18 | (r61, rev 6) Auto-primary eligibility = typed landlord, not soft-deleted, not a pointer; a soft-deleted landlord-typed contact joins non-primary | CONFORMS | units.ts:1250; unitsRepo.ts:961-965 |
| 19 | (rev 6) The I3 claim still asks only the type | CONFORMS (see R2-F7) | unitsRepo.ts:938 (`landlordTyped`); units.ts:1226-1231 |
| 20 | (r62, rev 6) Decided per attempt from a CONSISTENT unit read; contact read consistently by the route | CONFORMS | unitsRepo.ts:907; units.ts:1195 |
| 21 | (r63) FakeWorld mirrors the new fact | CONFORMS | `app/test/helpers/twilioWebhookHarness.ts:2972-2984` |
| 22 | (r65, rev 6) `contact_not_tenant`: "Tours and placements are for tenants. This contact is <phrase>." with the seven-entry phrase table and the "not a tenant" fallback | CONFORMS | `dashboard/src/lib/contactTypeErrors.ts:13-23`, `:34` - byte-exact against spec :389-394. C2 closed |
| 23 | (r64) One shared helper | CONFORMS | contactTypeErrors.ts (unchanged) |
| 24 | (r66) Other four section 4 sentences | CONFORMS | contactTypeErrors.ts:36-43 (unchanged) |
| 25 | (r72) `runRosterWrite` maps typed codes BEFORE the 409 catch-all (now also re-reads) | CONFORMS (see R2-F5) | ListingDetail.tsx:438-474 |
| 26 | (r79-80) RUNBOOK D1 paragraph and L1 paragraph still accurate after the wave | CONFORMS | RUNBOOK.md:475, :477 (untouched; nothing they state changed) |
| 27 | (r81) Three resolved issues | CONFORMS | untouched by the wave |
| 28 | (r82) `tours-placements-no-contact-type-check` corrections | CONFORMS | untouched |
| 29 | (r83) `placement-terminal-stage-exit-unguarded` filed | CONFORMS | untouched |
| 30 | (r84) `import-bypasses-contact-type-rules` + A1 appended (scenario, both fix options, refs) | CONFORMS (see R2-F4) | issue, appended section at its end |
| 31 | (r85) `landlord-of-record-no-reassign-ui` + A6 appended | CONFORMS | issue, appended section at its end |
| 32 | (r86) GLOSSARY: no new noun | CONFORMS | "automatic routing" is a rule name, not a domain noun |
| 33 | Adjudicated issue work (A5 filed, A7 filed, A8 filed, A9 appended to the existing issue, item 2 of `contact-type-refusal-copy-edge-cases` superseded) - frontmatter valid, refs live | CONFORMS | 22 `path:line` refs across the new and edited issues spot-checked at 1358fb42: all land on the cited code |
| 34 | Spec section 8 restore test list vs rev 6 section 4 | DEVIATES (R2-F2) | spec :531-532 |
| 35 | (r100) Restore tests follow rev 6 (six late-body 409 cases; the live-unit PIN now sends no body) | CONFORMS | unitsRestoreLandlord.test.ts:127, :200-259 |

### Findings (round 2)

#### R2-F1 - LOW - Revision 6 overstates the with-landlord restore's conditioning

Spec :333-337: "only the restore with a body conditions its single write on
the `landlordId` and contact list it read, so a concurrent change answers
409 `unit_roster_conflict`". True for `{ landlordId: null }` (the repo
rejects any list other than the route's `expectContacts`,
unitsRepo.ts:1297-1299). NOT true for `{ landlordId: <id> }`: the repo
checks only the route's `landlordId` (`expectLandlordId`), conditions each
attempt on the list THAT ATTEMPT read, and on a contacts-only race re-reads
and retries (unitsRepo.ts:1355-1360; its own doc says "a contacts-only race
retries"), so a concurrent contact-list change is absorbed into the write,
not answered 409. The code is the safe reading (the swap is recomputed on the
fresh list, and revision 5 asked this path to condition on `landlordId`
only); the sentence is what drifted when C1 was folded in. Fix: spec wording,
e.g. "conditions on the `landlordId` it read (and, without a landlord, on the
contact list it read)".

#### R2-F2 - LOW - Spec section 8 still requires "a body ignored when not needed"

Spec :531-532 lists "a body ignored when not needed" among the restore tests.
Revision 6 section 4 (:326-333) replaced that behavior with 409
`unit_roster_conflict`, and the tests now assert the 409
(unitsRestoreLandlord.test.ts:200-259), so the approved contract contradicts
itself. Fix: "a body that arrives when the plain restore applies answers 409
`unit_roster_conflict` and writes nothing". Same pass, cosmetic: spec :343
still calls `ListingDetail.tsx:349` "the only Restore button"; there are three
Restore entry points (ListingDetail.tsx:741, :752, :764), all on `onRestore`,
so behavior is unaffected.

#### R2-F3 - LOW - Contest A2's code choice: the still-deleted late body loops in the dialog

A2 answers a late body with `unit_roster_conflict`, the code the dialog
already reads as "retry" (RestoreLandlordDialog.tsx:82-84 sets
"The property contacts changed - try that change again." and calls
`onConflict`; ListingDetail.tsx:1443-1447 keeps the dialog open while the
re-read is still deleted). When the plain restore applies but the property is
STILL deleted - its stored landlord re-typed to landlord while the dialog
was open, or the property restored-with-a-landlord and deleted again - every
retry of either restore action answers the same 409, the copy keeps saying
"try that change again", and the first sentence ("... is no longer a
landlord") is false. The only exit is Cancel, then the banner's Restore. This
IS recorded (FWF report "The still-deleted behavior, recorded";
`contact-type-refusal-copy-edge-cases.md` item 2 replacement paragraph), so it
was not missed - but the record stops at "kept as is by the fix wave's brief"
with no direction, and inside the dialog it is the dead end spec revision 3
ruled out ("restore never dead-ends"). Rare (needs one of the two races
above). The client cannot tell this 409 from the without-landlord list race
(where staying open and retrying is right), so a fix needs a distinct answer,
e.g. 409 `restore_landlord_not_needed`, on which the dialog closes and the
page says to press Restore (or re-sends the plain restore). Suggest adding
that direction to the issue; no change needed for merge.

#### R2-F4 - LOW - Contest A1's deferral placement: the import gate is not where an operator meets it

DEFER is consistent with the spec's non-goal (the importer is filed). But the
issue's own ruling is "First to fix before the next `import:apply` run", and
that gate lives only in `docs/issues/import-bypasses-contact-type-rules.md`.
The RUNBOOK's `import:apply` procedure (RUNBOOK.md:1648-1690, the dry-run and
apply commands at :1689-1690) carries no caution, so anyone following the
runbook will run the importer with the gate unmet - and the failure is a
landlord-nudge send to a contact now typed tenant
(`app/src/jobs/placementNudges.ts:436-443`, per the issue). Suggest one
operational line in that RUNBOOK section pointing at the issue until it is
fixed (RUNBOOK stays operational; the issue stays the bug record).

#### R2-F5 - INFO - FWF-2's comment overstates when the typed codes arrive

ListingDetail.tsx:449-454 says the roster write answers
`contact_list_caseworker` / `landlord_not_landlord` "only when the property
changed after the route's read". The route's own pre-checks
(units.ts:1220-1231) answer the same codes in the no-race case (an API
caller, or a stale picker). The extra re-read is harmless there. It also
brings the typed path under the already-filed late-answer navigation race
(`listing-detail-dialogs-survive-property-navigation`), as the catch-all
path already was. No action.

#### R2-F6 - INFO - Under a lost write, `landlord_reassignment_required` can precede the contact-list refusals

`addContact`'s re-read after a lost conditional write (unitsRepo.ts:1018) is
eventually consistent and throws `LandlordReassignmentRequiredError`
(:1025-1030) before the next attempt re-decides the two contact-list rules
(:937-938). In that race the answer order can be reassignment first, not the
spec's caseworker -> claim -> reassignment; every path writes nothing. The
route's no-race order (row 16) is exact. FWF "Noticed, not fixed" 1 records
the read; no action.

#### R2-F7 - INFO - A soft-deleted landlord can still become landlord of record by claim

Per revision 6 the I3 claim asks only the type (row 19), so an API caller can
add a SOFT-DELETED landlord-typed contact with role Landlord to an ownerless
property: it claims `landlordId` and joins non-primary - and the roster
resolvers then fall back to the landlord of record anyway, so the
auto-primary exclusion does not keep routing off a deleted contact on that
shape. Conformant to the text and API-only (the Add contact picker offers
live contacts only); FWF "Noticed, not fixed" 2 is the sibling for the
restore. Worth one line in `auto-routing-changes-not-named` or
`contact-list-rule-duplication-and-fake-drift` if the rule is ever
generalized.

#### R2-F8 - INFO - "Automatic routing eligibility is one rule" is scoped to the two new choices

The revision 6 header reads globally, but `removeContact`'s pre-existing
promotion of the landlord of record when the primary row leaves
(unitsRepo.ts:1087-1093) is a third automatic routing choice outside the
rule (structural, pre-existing, and the landlord of record of a live unit is
landlord-typed under I3). Section 4's own text scopes the rule correctly; no
action.

### Adjudications not contested

A3, A4, A5 (client fix plus filed server fence), A6, A7, A8, A9 and C3-C8 are
sound against the spec and the code at 1358fb42; the FWF changes for A2-A5
and A7 do what the rulings say (rows 6, 18-20, 25 and the FWF-4 render-time
reset at `ContactDetail.tsx:289`, which also covers a review whose org check
resolves after the type change, since the reset runs on every render).

### C1 / C2

- C1: CLOSED. Revision 6 states the plain restore is an unconditioned write
  (L1), which is what units.ts:1789 does. The sentence that closed it
  introduced R2-F1.
- C2: CLOSED. Spec :389-394 and contactTypeErrors.ts:13-23, :34 match byte
  for byte (sentence frame, seven phrases, fallback).
