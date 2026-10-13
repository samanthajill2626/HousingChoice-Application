# R1 spec-conformance review - feat/primary-contact-integrity @ 29114f8c

Kind: CODE REVIEW (spec conformance), round 1. Branch
`feat/primary-contact-integrity`, worktree `W:\tmp\primary-contact-integrity`,
tip 29114f8c, merge-base with main fa35f228. Reviewer: Claude Opus 5.5,
read-only. Date: 2026-10-13.

Contract graded against: the spec
`docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` (rev 6,
sections 4-8 and the 7.x copy tables), the plan's binding sections 0-3
(`docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` lines 1-360),
the rulings file `plan-research/plan-assembly-rulings.md` (R1-R25; R12, R17,
R21 P-1..P-8 and R23 treated as the contract where they refine the spec), and
the research deltas `research/worklist-deltas.md` (its S5.5 "403" item is
wrong - the tree answers 404).

Method. Read the five diff packages (app src, app test, dashboard, e2e, the
non-plan docs), the shipped files at the tip, and the eight slice reports.
Graded every work-map line by locating the code by name and quoting nothing
longer than a line. Copy strings were compared character for character
against the spec tables (all ASCII straight apostrophes). Byte-compared nine
plan code blocks against the shipped source (chooseHeir/applyPrimary,
decideAutoPrimary, landlordWasPrimary, propertyContactBlockOf,
handOffPrimariesOfDeletedContact, introFallbackLines, promotionNotice, the
dev seam route, planUnitPrimary): all identical. Greps for leftover ladder
copies, bare `autoRoutingEligible`, `soleLandlordToPromote`, scalar readers,
masked-call comment claims and non-ASCII added lines (whole branch diff incl.
the plan: zero). NOTHING was run: no test, build, typecheck, eslint or e2e (a
full `npm run e2e` gate is live on this worktree). Gate claims were checked
only by reading the slice logs under `.superpowers/sdd/`.

## Verdict counts

56 rows: **56 CONFORMS, 0 PARTIAL, 0 MISSING.** No BLOCKING, HIGH or
MEDIUM finding. Two LOW findings, seven NOTEs, nine divergences (all
recommended ACCEPT). Rows that carry a divergence say so (`D-n`, section 3).

## 1. Verdict table

File paths are repo-relative; line numbers are at 29114f8c. Test cites are
`file - "title"` (titles abbreviated with "..." only where long).

### S1 - app lookup + heir

| # | item | verdict | evidence | pinning test |
|---|---|---|---|---|
| 1 | C1 lookup: candidates primary-then-landlord; is_tenant STOP by id before any read; read throw STOP `read_failed` + `candidateId`; deleted/missing SKIP; exhausted -> `deleted` if any skipped else `none`; never throws | CONFORMS | `app/src/lib/propertyContact.ts:145-152` (candidates), `:155-158` (tenant test), `:165-175` (judge/exhausted), `:184-200` (decide), `:222-240` (resolve, lazy) | `app/test/propertyContactLookup.test.ts` - "the property-contact lookup (spec 4.1) - decide and resolve give ONE answer" (17 table cases, both functions); "resolvePropertyContact - a failed read is an ANSWER, never a throw" |
| 2 | C3 eligibility moved verbatim; units.ts imports it | CONFORMS | `propertyContact.ts:49-57` (body identical to base `routes/units.ts` `autoRoutingEligible`); `app/src/routes/units.ts:90-96` import, `:1397` call | `app/test/propertyContact.test.ts` - "is true for an existing, live, landlord-typed, non-pointer contact" / "is false for a missing, soft-deleted, non-landlord or routing-pointer contact"; `autoRoutingEligibleSingleSource.test.ts` - "no module outside lib/propertyContact.ts defines it" |
| 3 | C2 liveness read: ONE batch read, `requireComplete`, ANY throw -> `{ ok: false }`; ids = every `unitContacts()` row + off-roster `landlordId` | CONFORMS | `propertyContact.ts:80-98`, `:107-114` | `propertyContact.test.ts` - "reads the de-duplicated, non-empty ids ONCE with requireComplete"; "a RAW chunk error is liveness UNKNOWN ..."; "an IncompleteBatchReadError is liveness UNKNOWN too ..."; "lists every roster row in order, then an OFF-roster landlord of record" |
| 4 | C4 heir: landlord of record first (no type test, `addLandlordRow`), else earliest-added eligible, else none + why; unknown; exclude = not live everywhere; `applyPrimary` | CONFORMS | `propertyContact.ts:281-316` (chooseHeir), `:332-350` (applyPrimary; throws on an impossible heir, R4) | `app/test/propertyContactHeir.test.ts` - "chooseHeir (spec 4.3)" (10 tests incl. "1. the landlord of record is NOT type-tested", "3. none - no_live_candidate ...", "3. none - no_eligible_candidate ...") and "applyPrimary (spec 4.7 ...)" (7) |
| 5 | Ladder copy: `lib/tourContacts.ts` onto C1 | CONFORMS | `app/src/lib/tourContacts.ts:144-174` (`propertyReadFailed` only on `read_failed`; `propertyContact?` present exactly when a unit was passed, R1) | `app/test/tourContacts.test.ts` - "a DELETED primary is skipped: the names and the en-route body come from the landlord of record"; "exposes the shared lookup answer for every outcome - and none at all without a unit"; `relayIntroPropertyContact.test.ts` (4) |
| 6 | Ladder copy: `lib/rosterResolution.ts` default branch; bare row kept on a failed read | CONFORMS | `app/src/lib/rosterResolution.ts:329-347` | `rosterResolution.test.ts` - "a DELETED primary is not on the list - the live landlord of record takes its slot"; "(PIN) a THROWING property-contact read keeps the BARE row for that candidate and never falls through"; `rosterPlanMaterializePropertyContact.test.ts` - "(PIN) a THROWING property-contact read keeps the candidate as a bare entry ..." |
| 7 | Ladder copies: `services/rosterProvision.ts` two diagnostics, codes/texts per state | CONFORMS | `app/src/services/rosterProvision.ts:187-217` (re-throws the read's own error), `:276-280` (tour: none/deleted/is_tenant texts), `:572-587` (placement: is_tenant -> relay_member_unresolvable, none/deleted -> landlord_unreachable) | `rosterProvisionPropertyContact.test.ts` (12, e.g. "deleted -> \"landlord contact not found\" ...", "(PIN) is_tenant -> relay_member_unresolvable", "(PIN) a property-contact read that THROWS is thrown out as the SAME error"); `propertyContactLadderSingleSource.test.ts` - "no module outside lib/propertyContact.ts re-derives it" |
| 8 | False `memberFromContact` docblock corrected (and the `RosterResolutionDeps` docblock, delta) | CONFORMS | `rosterResolution.ts:200-220` (soft-deleted vs dangling stated truthfully; filed issue named) | comment only |

### S2 - app writes

| # | item | verdict | evidence | pinning test |
|---|---|---|---|---|
| 9 | P2 widened: deleted/missing flagged primary or landlord counts as absent | CONFORMS | `app/src/repos/unitsRepo.ts:328-360` (`autoPrimaryLivenessIds` / `decideAutoPrimary`), `:1222-1236` (per attempt) | `unitsRepoAutoPrimaryDecision.test.ts` - "a soft-deleted flagged primary counts as absent: promote", "a MISSING flagged primary (no record) counts as absent: promote", "a soft-deleted landlord of record counts as absent: promote"; `unitsApiPrimaryOnAdd.test.ts` - "delete the primary, then add the replacement: the replacement is promoted ..." |
| 10 | P2: an edit of X's own row counts; never another contact | CONFORMS | `unitsRepo.ts:328-339` (no new-seat test), `:1245`/`:1264` (only X flagged) | `unitsRepoPrimaryOnAdd.integration.test.ts` - "an edit of a seated contact (a role change) ... makes THAT contact the primary", "a write for one contact never promotes ANOTHER ..."; `unitsApiPrimaryOnAdd.test.ts` - "470 Bolton: an edit of the only contact (typed landlord) ..."; `unitsApiRosterAutoPrimary.test.ts` - "(f) an edit of a contact already on an ownerless no-primary list ..." |
| 11 | P2: no flag after the write -> stale scalar REMOVEd; a deleted flagged contact keeps flag + scalar | CONFORMS | `unitsRepo.ts:1276-1280` (scalar = flagged row, else null -> REMOVE) | `unitsRepoPrimaryOnAdd.integration.test.ts` - "no row flagged after the write: a stale primary_contact scalar is REMOVEd", "(PIN) a LIVE landlord of record beside a soft-deleted flagged primary: nothing promoted - the deleted row keeps its flag AND the scalar" |
| 12 | P2: unknown liveness -> write succeeds unpromoted, WARN | CONFORMS | `unitsRepo.ts:1229-1236`, `:1319`; route WARN `app/src/routes/units.ts:1405-1414` | `unitsRepoPrimaryOnAdd.integration.test.ts` - "liveness unknown (the read failed): the add succeeds without a promotion ..."; `unitsApiPrimaryOnAdd.test.ts` - "liveness unknown (%s): 200, the add joins non-primary, and the route WARNs" (raw error AND IncompleteBatchReadError) |
| 13 | 409 `primary_contact_deleted`: only for a not-already-primary deleted contact; after the 404s and the I4/I3 type checks; decided again per attempt (R8) | CONFORMS | `units.ts:1368-1379` (route), `:1434-1440` (repo error map); `unitsRepo.ts:1190-1199` | `unitsApiPrimaryOnAdd.test.ts` describe "POST ... - 409 primary_contact_deleted (spec 4.4)" (8: incl. "re-sending primaryContact true ... whose row IS the primary: 200", "order: an unknown contact answers 404 contact_not_found first", "order: a soft-deleted caseworker ... contact_list_caseworker first", "order: ... landlord_not_landlord first", "decided again in the roster write ...") |
| 14 | P2b: `primary_contact` not client-writable (create + PATCH) | CONFORMS | `app/src/lib/unitFields.ts:107-110` (removed from `WRITABLE_FIELDS`; `unknown field` refusal at `:162-164`) | `unitFields.test.ts` - "refuses primary_contact on create" / "... on update, even beside a writable field"; `unitsApi.test.ts` - "refuses primary_contact on create and on PATCH - 400, nothing written" |
| 15 | Remove of the primary -> heir / clear + REMOVE scalar / unknown -> 503 `roster_read_failed`, nothing written; non-primary remove needs no liveness | CONFORMS | `unitsRepo.ts:1328-1415` (consistent reads; heir `:1366-1385`); `units.ts:1510-1569` (503 `:1525-1533`) | `unitsRepoPrimaryOnRemove.integration.test.ts` (9); `unitsApiPrimaryOnRemove.test.ts` - "liveness unknown (%s): 503 roster_read_failed - nothing written, no audit", "(PIN) removing a NON-primary row needs no liveness ..." |
| 16 | "Restore without a landlord": the remove rule (earliest-added eligible, unknown -> 503) REPLACES `soleLandlordToPromote` | CONFORMS | `units.ts:581-605` (`clearedLandlordHeir`), `:2077-2087` (503 before any write); `unitsRepo.ts:1677-1690`; no `soleLandlordToPromote` left anywhere | `unitsRestorePrimaryHandoff.test.ts` - "rows that are not eligible ... are skipped for the earliest eligible one; the hand-off is audited", "liveness unknown (%s): 503 ..." (clear); `unitsRestoreLandlord.test.ts` - "two remaining contacts typed landlord: the EARLIEST-added (c-pm) is promoted ..." |
| 17 | Landlord SWAP of a primary landlord re-runs the heir per attempt (R6) | CONFORMS | `unitsRepo.ts:1654-1679` | `unitsRepoRestoreHandoff.integration.test.ts` - "swap, the new landlord is SOFT-DELETED: the earliest eligible remaining contact takes the primary ...", "a swap retried after a contacts-only race decides the heir again on a fresh read"; `unitsRestorePrimaryHandoff.test.ts` swap describe (5) |
| 18 | `landlordWasPrimary` never reads the scalar; ONE rule for repo, route, fake | CONFORMS | `unitsRepo.ts:865-868`; callers `unitsRepo.ts:1622`, `units.ts:593`, `app/test/helpers/twilioWebhookHarness.ts:3199`; no-handoff branch re-aligns the scalar `unitsRepo.ts:1691-1698` | `landlordWasPrimary.test.ts` (4); `unitsRepoRestoreHandoff.integration.test.ts` - "swap: a stale scalar naming the old landlord does NOT move the primary off a live flagged row ..."; `unitsRestoreLandlord.test.ts` - "a stale primary_contact naming the cleared landlord does NOT move the primary ..." |
| 19 | Contact-DELETE fan-out: consistent Scan of live + soft-deleted units; deleted contact excluded and never read; heir -> move / none -> nothing / unknown -> skip + WARN; conditional retry with re-check (3); best-effort, never fails the delete | CONFORMS (D-9) | `app/src/services/primaryHandoff.ts:63-160`; `unitsRepo.ts:1727-1767` (`handOffPrimaryFrom`), `:1510` (`ConsistentRead`); wiring `app/src/routes/contacts.ts:2268-2280` | `contactDeletePrimaryHandoff.test.ts` (9, incl. "one unit failing does not fail the delete ...", "Scans consistently over live and deleted units and never reads the deleted contact for liveness"); `primaryHandoffService.test.ts` (9); `unitsRepoHandOffPrimary.integration.test.ts` (13, incl. "gives up after 3 lost writes ...") |
| 20 | Contact RESTORE changes no roster | CONFORMS | `routes/contacts.ts` restore handler untouched by the branch | `contactDeletePrimaryHandoff.test.ts` - "restoring the contact afterwards changes no roster - the heir keeps the primary"; "no heir: nothing changes - and restoring the contact leaves the property exactly as it was" |
| 21 | Audit `unit_primary_contact_assigned { contactId, reason, from? }` per path | CONFORMS (F2, D-7, D-8) | `units.ts:1464-1481` (auto_on_add, from the written row), `:1550-1559` (handoff_on_remove), `:2136-2144` (handoff_on_restore); `primaryHandoff.ts:116-131` (handoff_on_delete); `app/scripts/assign-primary-contacts.ts:365-369` (backfill) | `unitsApiPrimaryOnAdd.test.ts` - "470 Bolton ... audited auto_on_add"; `unitsApiPrimaryOnRemove.test.ts` - "the live landlord of record takes over - flag and scalar - audited handoff_on_remove"; `contactDeletePrimaryHandoff.test.ts` - "moves the primary ... audited handoff_on_delete"; `unitsRestorePrimaryHandoff.test.ts` - "the new landlord is live: ... audited handoff_on_restore from the old landlord"; `assignPrimaryContacts.run.test.ts` - "assigns each target its heir in ONE conditional write with one backfill audit event ..." |
| 22 | API-test fake shares the pure functions (no twin logic) | CONFORMS | `twilioWebhookHarness.ts:2955` (addContact, `decideAutoPrimary` `:3002`), `:3034` (removeContact), `:3121` (assignPrimaryIfCurrent), `:3174` (restoreWithLandlord), `:3271` (handOffPrimaryFrom) | `primaryHandoffParity.integration.test.ts` - "%s: the real repo and the fake agree" (9 cases) |

### S3 - app reads

| # | item | verdict | evidence | pinning test |
|---|---|---|---|---|
| 23 | `introFallback` reasons: exact union and order; owner failure -> `lookup_failed` alone; unit failure -> `lookup_failed` + tour reasons; every check evaluated; `lookup_failed` added beside (P1 read_failed, settings fail/empty, unformattable time); variant unchanged; placements never tour reasons; ownerless none; member-added ignores | CONFORMS | `app/src/jobs/relayFanOut.ts:370-417` (union, order, NOBODY_REASON), `:429-431` (ownerUnreadable), `:533-726` (resolver; `reasons.add` at `:588`, `:593`, `:653`, `:658`, `:660`, `:662`, `:667`, `:687`, `:690`, `:704`), `:542` (ownerless) | `relayIntroFallback.test.ts` (31: "an owner read that THROWS is lookup_failed ALONE ...", "a failed unit read keeps tour_not_scheduled / tour_started beside lookup_failed", "reports in SPEC order, not evaluation order", "does not stop at the first miss ...", "never carry a tour reason, and never read settings", "an ownerless conversation never carries it ...", "NEVER throws ...") |
| 24 | `RosterPreview.introFallback` on tour/placement OPEN previews only | CONFORMS | `app/src/services/rosterEdits.ts:364`, `:625-629` (attached in `buildOpenPreview` only) | `rosterPreviewIntroFallback.test.ts` - "the STANDALONE preview never carries introFallback", "the ADD-MEMBER preview never carries introFallback ..."; `toursApi.test.ts` / `placementsApi.test.ts` - "preview-open explains ..." / "preview-open carries NO introFallback when ..." |
| 25 | Job INFO line `relay intro: general intro used` `{ conversationId, ownerType, ownerId, reasons }`, ids + codes only | CONFORMS (D-4) | `relayFanOut.ts:1114-1124` | `relayIntroFallbackJob.test.ts` - "a tour whose start has passed: the general intro and ONE INFO line, ids and reason codes only", "... operator-edited intro ... logs NO fallback line", "the member-added announcement logs NO fallback line ..." |
| 26 | Row flags + `propertyContact` block on GET and the two roster writes ONLY on a complete read; absent otherwise; GET never 500s; best-effort names fallback | CONFORMS (D-2) | `units.ts:319-354` (`propertyContactBlockOf`), `:516-526` (`enrichRow`), `:543-556` (`enrichRosterView`), `:740` (GET), `:1493`, `:1569` (writes); restore keeps `enrichRoster` `:2157` (R18) | `unitsApiPropertyContact.test.ts` (13, incl. "the complete read is ONE requireComplete batch read of the roster ids AND landlordId", "<shape>: best-effort names, no deleted/caseworker flags, no propertyContact", "both reads failing: bare rows, no block, still 200"); `unitsApiPropertyContactWrites.test.ts` (7) |
| 27 | Activity `reason` for `unit_primary_contact_assigned` ONLY (R17) | CONFORMS | `units.ts:232-237` (field), `:274-275` (event-gated lift) | `unitsApiActivity.test.ts` - "projects every primary-assignment reason code verbatim", "keeps a listing_status_changed free-text reason OFF the wire" |

### S4 - dashboard

| # | item | verdict | evidence | pinning test |
|---|---|---|---|---|
| 28 | Dialog box heading per owner (exact 7.1) | CONFORMS | `dashboard/src/routes/shared/RosterConfirmDialog.tsx:124-127`, `:392-396` (needs `introOwner`, R21 P-1) | `RosterConfirmDialog.test.tsx` - "renders ABOVE the message with the tour heading ...", "uses the placement heading on a placement" |
| 29 | Per-reason lines and link labels EXACTLY the 7.1 table; `<Street>` / "this property" / "This property" | CONFORMS | `RosterConfirmDialog.tsx:154-223` (byte-identical to plan; every string char-for-char = spec 7.1) | `RosterConfirmDialog.test.tsx` - "%s renders its line and its link (%o)" (10 rows incl. street and no-street variants) |
| 30 | Links open a NEW TAB; omitted when the id is absent; hrefs `/listings/<unitId>`, `/contacts/<propertyContactId>` | CONFORMS | `RosterConfirmDialog.tsx:158-167`, `:403`; routes exist `dashboard/src/App.tsx:264`, `:271` | same test (asserts `target="_blank"`, `rel`, href); "omits a link whose id is absent" |
| 31 | `role="status"`, duplicate-warning style, ABOVE the message | CONFORMS | `RosterConfirmDialog.tsx:393` (`styles.duplicateWarning`) | "renders ABOVE the message ..."; "sits beside the duplicate warning: two status blocks ..." |
| 32 | Check again (secondary, small), disabled while running, failure in the dialog's error line | CONFORMS | `RosterConfirmDialog.tsx:298-305`, `:410-422`, `:505-509`; failure copy `:228-233` (P-2) | "Check again runs the caller, is disabled while it runs, and comes back"; "a failed Check again renders in the error line and the dialog stays open"; "... shows the server's own sentence when it sent one" |
| 33 | Re-fetch 409 `relay_already_provisioned` closes the dialog and refetches the roster | CONFORMS | `dashboard/src/routes/tours/TourDetail.tsx:470-482`, `:963-964`; `dashboard/src/routes/placements/PlacementDetail.tsx:335-347`, `:793-794` | `TourDetail.test.tsx` / `PlacementDetail.test.tsx` - "Check again answered 409 relay_already_provisioned closes the dialog and refetches the roster" |
| 34 | Edited-draft rule (7.2): seed remembered; unedited follows; edited kept + "The intro changed." + "Use the updated intro"; send rule unchanged | CONFORMS | `RosterConfirmDialog.tsx:260-274` (adjust during render), `:285`, `:448-461` | describe "RosterConfirmDialog - the edited-draft rule (... 7.2)" (5, both ways) |
| 35 | Property box leads: "No primary contact." / "This property's contact was deleted." + effect line | CONFORMS | `dashboard/src/routes/listing/ListingDetail.tsx:142-144`, `:1027-1034` | `ListingDetail.test.tsx` - "exactly one eligible row ...", "a deleted property contact leads with \"This property's contact was deleted.\"" |
| 36 | Box actions counting ELIGIBLE rows (live, not caseworker): one -> "Make <Name> primary" (same write); 2+ -> "Choose a primary" (edit mode); 0 -> no button + line | CONFORMS (D-5) | `ListingDetail.tsx:478-481`, `:1035-1064`, `:148` | "exactly one eligible row: \"Make <Name> primary\" above the rows - the same write as Make primary"; "counts only ELIGIBLE rows: a deleted row and a caseworker row do not count"; "two or more eligible rows: \"Choose a primary\" opens the edit mode"; "no eligible row: no button ..." |
| 37 | No box on a deleted property / absent block / zero rows; empty-state second sentence | CONFORMS | `ListingDetail.tsx:478-479`, `:1073` | "no box on a soft-deleted property ...", "no box when the block is absent ...", "no box with zero roster rows - the empty state speaks instead", "the empty state says tours need a primary contact" |
| 38 | "(deleted)" after the name in view and edit modes; no "Make primary" on such a row; role select and Remove stay | CONFORMS | `ListingDetail.tsx:1088`, `:1155`, `:1122` (`r.primaryContact \|\| r.deleted === true ? null`) | "marks a deleted row \"(deleted)\" in view mode"; "in edit mode a deleted row says \"(deleted)\" and offers no Make primary - its role select and Remove stay" |
| 39 | 409 `primary_contact_deleted` own copy in the conflict map | CONFORMS | `ListingDetail.tsx:125`, `:550-559` (`:556`) | "a 409 primary_contact_deleted on Make primary names its own reason, and the re-read marks the row deleted" |
| 40 | 503 `roster_read_failed` copy on remove AND in the restore dialog (R12 / S4.10b), one shared literal | CONFORMS | `dashboard/src/routes/listing/rosterCopy.ts:12`; `ListingDetail.tsx:541-547`; `RestoreLandlordDialog.tsx:99-105` | "a 503 roster_read_failed on removing the primary says the other contacts could not be checked, and re-reads nothing"; `RestoreLandlordDialog.test.tsx` - "a 503 roster_read_failed says the other contacts could not be checked, and stays open" |
| 41 | Remove notice from the server block: named heir / unnamed heir / no heir / block absent; "calls and" dropped | CONFORMS | `ListingDetail.tsx:621-628` (byte-identical to plan), constants `:130-133` | "removing the CURRENT primary confirms first and NAMES the heir the server reports", "names the NO-primary outcome when the server reports no heir", "an heir with no name on record ...", "no propertyContact block (the server could not tell): another contact MAY take over", "the notice reads the LATEST roster write's block ..." |
| 42 | Restore (plain + landlord dialog) re-reads; the re-read REPLACES the roster source | CONFORMS | `ListingDetail.tsx:426-440` (plain), `:1566-1579` (dialog); block source `:354` | "a plain restore re-reads the property, and the re-read becomes the Contacts card roster"; "a restore through the landlord dialog re-reads ...; the re-read REPLACES the restore answer ..." |
| 43 | Facts subline skips deleted rows | CONFORMS | `ListingDetail.tsx:365-366` | "the header facts subline skips a deleted row when naming the company" |
| 44 | People-card suggestions skip deleted rows | CONFORMS | `dashboard/src/routes/shared/rosterPeople.ts:110`; fed by the GET rows at `TourDetail.tsx:231-241`, `PlacementDetail.tsx:261-274` | `rosterPeople.test.ts` - "never suggests a row whose contact is deleted, primary or not" |
| 45 | Delete-dialog sentence for non-tenants only (7.6) | CONFORMS | `dashboard/src/routes/contact/ContactDetail.tsx:140-141`, `:1417` | `ContactDetail.test.tsx` - "%s gets the handoff sentence" (landlord, partner), "a tenant does not" |
| 46 | Activity line for the event | CONFORMS (copy P-3, section 4) | `dashboard/src/routes/listing/listingFormat.ts:172-178`, `:237-245` | `listingFormat.test.ts` - "describes an automatic primary-contact pick with who, why, and a contact link ..." |

### S5 - script, seam, e2e, docs

| # | item | verdict | evidence | pinning test |
|---|---|---|---|---|
| 47 | Script (spec 8): clean-org-names pattern (`--env`, dry run default, `--apply`, exit codes 0/1/2, PII-free), no lock, own conditional write (`assignPrimaryIfCurrent`, one attempt), consistent Scan of live + deleted units, targets, counts incl. `noEligible` by unit id, `scalarAligned` without audit, landlord-only left alone, backfill audit, idempotent | CONFORMS (D-1) | `app/scripts/assign-primary-contacts.ts:130-164` (planUnitPrimary), `:278-301` (Scan), `:303-382` (per unit), `:441-476` (summary), `:486-489` (usage), `:511-551` (CLI); `unitsRepo.ts:1558-1573` | `assignPrimaryContacts.plan.test.ts` (13), `.run.test.ts` (10, incl. "is idempotent: a re-run of a completed apply plans nothing and writes nothing", "a unit changed after the read is SKIPPED ..."), `.cli.test.ts` (11), `.integration.test.ts` - "a dry run, an --apply and a re-run, end to end ..."; `unitsRepoAssignPrimary.integration.test.ts` (6) |
| 48 | Dev seam per R23 / contract 2.7 | CONFORMS | `app/src/routes/dev.ts:1263-1345` (route `:1293`; 1-5 rows, pm/owner/other, each contact once, existence check, `setup`, no landlordId, no authorities, non-primary rows in order, 201 `{ unitId }`) | `devZeroPrimaryFixture.test.ts` (13, incl. "creates a NEW property ...", "never touches an existing property", "is absent when the dev router is not mounted") |
| 49 | e2e specs (a)(b)(c) on the seam | CONFORMS | `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts:115`, `:161`, `:248`; `e2e/fixtures/primaryContact.ts`; `property-roster.spec.ts` step 4 updated (R20) | the specs themselves; S5b run logs `.superpowers/sdd/S5b-e2e-run2-...log` ("7 passed", EXIT:0) and `...run5-pci-repeat3.log` ("9 passed", EXIT:0) read, not re-run |
| 50 | Lean seed byte-stable | CONFORMS | `git diff --name-only fa35f228 HEAD` lists no seed file (`app/src/lib/seed/*` untouched) | by construction; seedHistory ran green in S3 neighbors |
| 51 | GLOSSARY: property contact added; primary contact updated | CONFORMS (D-3) | `documentation/GLOSSARY.md` (primary contact, landlord of record, property contact entries) | docs |
| 52 | RUNBOOK backfill section, owed with the deploy (dev then prod, dry run then `--apply`) | CONFORMS | `RUNBOOK.md` section "Primary contacts backfill (`feat/primary-contact-integrity`)" | docs (commands and printed lines match `formatAssignSummary`) |
| 53 | `tour-reminder-zero-primary-e2e-gap` updated: ownerless leg addressed, landlord leg open | CONFORMS | `docs/issues/tour-reminder-zero-primary-e2e-gap.md` item 1 Update block | docs |
| 54 | `relay-provision-includes-deleted-contacts` filed | CONFORMS (F1) | `docs/issues/relay-provision-includes-deleted-contacts.md` (status open; filed at 47a0796e) | docs |

### Cross-cutting (spec 9.2)

| # | item | verdict | evidence | pinning test |
|---|---|---|---|---|
| 55 | "Unchanged on purpose" landlord-of-RECORD readers not moved onto the lookup | CONFORMS | untouched by the branch: `jobs/placementNudges.ts`, `routes/placementNudges.ts`, `lib/personEvents.ts`, `routes/contactTimeline.ts`, `dashboard/src/routes/tours/useTour.ts`, `PlacementNowCard.tsx`; `TourDetail.tsx` / `PlacementDetail.tsx` changed only in the open-dialog wiring hunks; `units.ts` related-units route not in any hunk | n/a (no edits) |
| 56 | Comment corrections: `unitsRepo.ts`, `conversationsRepo.ts`, `routes/units.ts`, `ListingDetail.tsx`, `rosterPeople.ts`, the rosterResolution docblock | CONFORMS | `unitsRepo.ts:66-79`, `:476-495`; `app/src/repos/conversationsRepo.ts:202-210`; `units.ts:1260-1267`; `ListingDetail.tsx:456-460`, `:614-620`; `rosterPeople.ts:58-59`; `rosterResolution.ts:200-220`. Grep: no remaining claim that a masked call dials or routes on the primary/scalar | comments |

## 2. Findings

None BLOCKING, HIGH or MEDIUM.

1. **LOW - docs** - `docs/issues/relay-provision-includes-deleted-contacts.md`
   (Problem bullet 1 and "Suggested fix"). Spec 12 asks for the issue to be
   filed (it is). Its first bullet still says the `memberFromContact`
   docblock (`rosterResolution.ts:174-180`) claims a soft-deleted row "is
   excluded from every send", and the suggested fix ends "and correct the
   docblock" - but S1 (03b058e9) already rewrote that docblock
   (`rosterResolution.ts:200-220`), and the property-contact route into the
   bug is closed by the lookup. The file was written with spec rev 1 and
   never touched since (S5b W1). Fix: append a dated Update block (docblock
   corrected; property-contact route closed by P1; hand-added members still
   exposed), refresh the line refs; keep it open.

2. **LOW - test-coverage** - `app/src/routes/units.ts:1464-1481`. Plan
   contract 2.4: `unit_primary_contact_assigned` is NOT appended for an
   explicit Make primary. The code is right (`autoPrimary =
   effectivePrimary && !primaryContact`), but the only API pin of the
   negative is "re-sending primaryContact true for a soft-deleted contact
   whose row IS the primary" (`unitsApiPrimaryOnAdd.test.ts`), a no-change
   write. `unitsApiRosterAutoPrimary.test.ts` "(h) (PIN) a requested primary
   is audited primary without autoPrimary ..." checks only
   `unit_contact_added`. Fix: add one assertion there that no
   `unit_primary_contact_assigned` event was written for the requested
   primary (one line, no behavior change).

3. **NOTE - spec copy edge (the spec may be the bug)** -
   `dashboard/src/routes/listing/ListingDetail.tsx:148` (spec 7.4 text,
   reproduced exactly). "Add the landlord or property manager - they become
   the primary automatically." is true only for an added contact typed
   landlord. On a live property whose landlord of RECORD is soft-deleted (the
   box then leads "This property's contact was deleted."), adding the
   replacement with the Landlord ROLE is refused 409
   `landlord_reassignment_required` (`unitsRepo.ts` addContact reassignment
   refusal; the card says "This property already has a landlord of record -
   reassign it before choosing Landlord.") and no dashboard path reassigns a
   live property's landlord of record; the same person added as Property
   manager or Owner IS promoted. Faithful to the spec - flag for Cameron:
   keep, or file a copy/flow follow-up.

4. **NOTE - spec/doc wording** - spec section 10 ("the zero-primary state
   cannot be reached through the UI") and `e2e/support/selectors.md` (the
   no-primary-box row) overstate it: a property with NO primary is reachable
   through the UI (Restore without a landlord with no eligible contact left;
   an ownerless property whose only additions are tenants; deleting the only
   eligible contact). What the UI cannot build is the imported 470 Bolton
   shape - an ELIGIBLE contact left non-primary - which is why the seam is
   still needed (S5b W3). Fix (optional): one-clause wording change in
   selectors.md.

5. **NOTE - style duplication** - `ListingDetail.module.css:355-373`
   `.noPrimaryBox` copies `.duplicateWarning`'s declarations
   (`RosterConfirmDialog.module.css:75-85`) instead of sharing them. "Same
   style as 7.1" holds today; the two can drift. Accept, or extract a shared
   class later.

6. **NOTE - a11y nit** - a 503 on removing the primary renders the same
   sentence in two `role="alert"` nodes (the confirm dialog
   `ListingDetail.tsx:1657-1661` and the edit row behind it, same error
   key), so a screen reader may announce it twice (S5b W2). selectors.md
   documents scoping. Accept.

7. **NOTE - activity double entry** - a promoting "Restore without a
   landlord" writes `unit_restored.primaryPromoted` AND
   `unit_primary_contact_assigned { reason: 'handoff_on_restore' }`; the
   Activity card shows "Property restored" plus "Primary contact set
   automatically" (S2b W2 / S3 W3). Accept.

8. **NOTE - stale comments** - `dashboard/src/routes/listing/rosterCopy.ts:1-3`
   says the shared literals cover "the same 409" (it now also holds the 503
   sentence); `dashboard/src/routes/listing/useListing.ts:244` says a unit
   is applied "after restore ... without a refetch" (true of `setUnit`, but
   the page now re-reads after a restore) (S4b W6). Accept or fix in a
   comment sweep.

9. **NOTE - log volume** - a failed liveness read logs twice
   (`readRosterContacts` WARN with `err`, then the route/service ids-only
   WARN; per attempt on the add path), and the GET's failed complete read
   logs "liveness unknown" wording on a page view (S2a W2, S3 W4). Accept.

## 3. Divergences (code vs spec text) - all recommended ACCEPT

- **D-1 (accept)** - spec 8: "Dry run prints counts ... and unit ids only -
  never a person's name." The printed summary is counts + unit ids only, but
  the per-unit JSON log lines also carry the heir's `contactId` and `from`
  (`assign-primary-contacts.ts:357-360`). Plan C12 says "ids only"; contact
  ids are not PII and the RUNBOOK says so. The spec's intent (no names) is
  met.
- **D-2 (accept)** - spec 7.5 defines `heirIfPrimaryRemoved` as "the heir
  function excluding the primary". With NO flagged row the code serves
  `null` (`units.ts:338-354`): there is no primary to remove, and the
  dashboard reads the field only when removing a flagged row. `null` then
  means "nothing to remove", not "nobody would take over" (S3 W6).
- **D-3 (accept; the spec is the bug)** - spec 12 says the GLOSSARY should
  say zero primary is reachable "only with no live heir or for legacy data".
  The shipped entry also lists non-eligible-only additions (spec 4.7's own
  rule) and an explicit API `primaryContact: false` on the primary's own row
  (ruling R10). The shipped text is the accurate one.
- **D-4 (accept)** - spec 5.2 says the job logs the INFO line "when it sends
  the general intro". It is emitted when the intro is composed
  (`relayFanOut.ts:1114-1124`), just before `sendRelayAnnouncement` (which
  can still no-op on an unusable conversation), and also on the dev
  intro-replay endpoint. Accepted at build research (worklist S3).
- **D-5 (accept)** - spec 7.4 gives "Make <Name> primary"; a row with no name
  on record renders `Make <contactId> primary` (`ListingDetail.tsx:1044`),
  the same fallback the card's rows use.
- **D-6 (accept)** - mockup A put the link and Check again on one line; the
  code renders each reason's link inline after its line and Check again as
  the box's last line - which is what the spec TEXT says (7.1 table + "Last
  line").
- **D-7 (accept)** - `auto_on_add` carries no `from`, even when the promotion
  replaced a soft-deleted flagged primary (`units.ts:1475-1481`). Plan 2.4
  makes `from` optional and R7 derives the event from the written row; the
  Activity line does not render `from` anyway.
- **D-8 (accept)** - `handoff_on_restore` names the old landlord as `from`
  also in the no-flag case (`landlordWasPrimary` true because NO row was
  flagged), when that landlord was the effective property contact (P1's
  fallback) but not a flagged primary.
- **D-9 (accept; stronger than the spec)** - spec 4.6 words the delete
  fan-out's consistent re-read as happening after a lost conditional write;
  `handOffPrimaryFrom` re-reads consistently and re-checks on EVERY attempt,
  including the first, so it never writes against the Scan's snapshot
  (`unitsRepo.ts:1727-1737`).

Rulings applied as the contract (not divergences): R12 (restore-dialog 503),
R17 (Activity `reason` on the one event), R21 P-1..P-8 (`introOwner` prop,
Check-again failure copy, Activity copy, property box `role="status"` with its
own error slot, box stays in edit mode, no re-read on 503, best-effort
post-restore re-read, client-side reason sort with unknown reasons dropped),
R23 (the refined seam), R10 (explicit `false` on X's own primary row demotes).

## 4. Staff-facing copy the diff adds that the spec does not give verbatim

Dashboard (Sam sees these):

- `Couldn't check again - please try again.` - the Check again failure
  fallback when the server sent no sentence
  (`RosterConfirmDialog.tsx:228`; ruling R21 P-2).
- Activity label `Primary contact set automatically`, sub-line
  `<Name> - <why>` (the contact id stands in for a missing name; no reason
  -> just the name; an unknown reason is humanized)
  (`listingFormat.ts:172-178`, `:237-245`; R21 P-3), with:
  - auto_on_add: `the property had no primary contact`
  - handoff_on_remove: `the previous primary contact was removed`
  - handoff_on_delete: `the previous primary contact was deleted`
  - handoff_on_restore: `the property's landlord changed when it was restored`
  - backfill: `set by a one-time data repair`
- `Make <contactId> primary` - the box button's fallback when the eligible
  row has no name (`ListingDetail.tsx:1044`; D-5).
- New PLACEMENTS of existing copy (no new words): the box's own error line
  reuses `Couldn't save that change - please try again.` and the mapped 409
  sentences (`ListingDetail.tsx:1065-1069`); the restore dialog reuses the
  spec 4.6 sentence `Couldn't check the other contacts - try again.` (R12).

Operator-facing (Cameron runs the backfill; printed to the terminal):

- `app/scripts/assign-primary-contacts.ts:441-476` (`formatAssignSummary`):
  `Primary contacts - DRY RUN, nothing written:` / `Primary contacts -
  APPLIED:`; `Properties scanned: N (D soft-deleted)`; `Would get a primary
  contact: T (S on soft-deleted properties)` / `Planned a primary contact:
  ...`; `Primary contacts assigned: N`; `primary_contact field would be
  aligned with the flagged primary: A` / `... aligned ...`; `No heir - no
  live contact and no live landlord of record (nothing to do): H`; `No
  eligible contact - only a tenant or a caseworker is live (choose one on
  the property page): E`; `Unknown - a contact read failed (re-run): U`;
  `Already fine: F`; `Skipped - the property changed after the run read it
  (re-run): S`; `Writes that FAILED (re-run the dry run to see): W`; `Audit
  events that may not have been written: X (expected 0)`; and the id lines
  `Properties that would get a primary contact: ...`, `Properties whose
  primary_contact field would be aligned: ...`, `Properties with no
  eligible contact (open each one and choose a primary contact): ...`,
  `Properties that could not be decided (re-run): ...`, `Properties skipped
  because they changed (re-run): ...`, `Properties whose write failed:
  ...` (apply-mode variants `Properties planned for ...`).
- The usage text (`:486-489`) and the WARN/ERROR summary lines
  (`COMPLETED WITH FAILURES ...`, `PARTIAL result: the run ABORTED ...`,
  `FAILED before the run started (no table was read or written)`).

Not staff copy, not listed: the dev seam's 400 bodies (hermetic-only), log
messages, docblocks, RUNBOOK/selectors prose.

## 5. Slice-report claims not verified, or found false

Verified by reading (spot checks, at least three per slice): S1 - contract
2.1 signatures and the heir block byte-identical to the plan; zero reads for
an empty id list; S2a - the addContact refusal order (I4, I3, 409,
reassignment) in the repo AND the fake; consistent removeContact reads; the
route WARN text; S2b - no bare `autoRoutingEligible` and no
`soleLandlordToPromote` left; `landlordWasPrimary` reads no scalar; the
DELETE wiring after the `contact_deleted` append; S3 - owner failure ->
`lookup_failed` alone with no unitId; settings read only for a known-unit,
usable-time tour; both contact-list responses use `enrichRosterView` while
the restore keeps `enrichRoster`; S4a - every 7.1 string and both headings;
Check again disabled and its failure copy; the pre-existing
`TourDetail.tsx:342` purity error (blame 23f7d568, 2026-07-22); S4b - one
definition of `ROSTER_READ_FAILED_COPY`; "(deleted)" and no Make primary;
restore re-read as roster source; S5a - the 404 (not 403) claim
(`app/src/middleware/originSecret.ts:45` exempts every `/__dev/` path); the
seam's 400/404/201 table; `assignPrimaryIfCurrent` one attempt, no retry;
S5b - spec files (a)(b)(c) present, property-roster step 4 updated, issue
status changes, the relay-provision issue untouched since 47a0796e, run 2
"7 passed" / run 5 "9 passed" / merge-tree log (tree id only) / repo lint
22 errors, all from the logs.

Not verified (would need running, which this review must not do): every
RED/GREEN count and gate exit code beyond the log tails named above; the
S5b roster-paging 60-delete timing; the S5a mutation checks; the AST
cycle-safety checks; the S5b "no commit while an e2e run was live" claim;
the S5.12 completion gates and main sync (not yet run - the branch is two
docs-only commits behind main 16ca96cc).

Stale at the tip (true when written, not defects): S2a W1 and S2b W1 said
the add-route header comment lacked "live" - fixed by S3.6
(`units.ts:1264-1267`). S1 section 4's `routes/units.ts:87` alias import -
superseded by S2.8 (`units.ts:90-96` imports the plain names). The worklist
delta's S5.5 "403" - wrong, as S5a D1 records.

Found false: none.
