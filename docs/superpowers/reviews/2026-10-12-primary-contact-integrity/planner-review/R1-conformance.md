# Planner review R1 - spec conformance

Date: 2026-10-13. Reviewer: independent spec-conformance reviewer (opus),
dispatched by the planner. READ ONLY: no test, npm, npx, Docker or server was
run; read-only git only (the planner was running the gates in this worktree).

- Worktree: `W:\tmp\primary-contact-integrity`, branch
  `feat/primary-contact-integrity`, tip 971c9551 (gated tip 283c9cb7 + the
  docs-only handback commit; `git diff --stat 283c9cb7 971c9551` = handback.md
  only). `main` is an ancestor of HEAD, 0 commits behind.
- Contract: spec `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
  (rev 6 + three inline-dated on-branch amendments, see N-3).
- Binding: plan sections 0-3 and the 3.2 rulings
  (`plan-research/plan-assembly-rulings.md` R1-R25).
- Claims checked: `handback.md`.
- Evidence: every file:line below was read in this pass. Test evidence is by
  test file and title (read); test RESULTS are UNVERIFIED by this reviewer
  (not run). The gate logs the handback cites exist and show
  `TYPECHECK_EXIT:0`, `NPMTEST_EXIT:0`, `SMOKE_EXIT:0`, `E2E_EXIT:0`
  ("350 passed (21.4m)"), `ESLINT_EXIT:1` (`.superpowers/sdd/p6-gate*.log`);
  the eslint attribution (one pre-existing error) was NOT re-derived here.

## Verdict

**84 rows: 81 CONFORMS / 0 PARTIAL / 0 MISSING / 3 DIVERGES.** All three
DIVERGES rows are divergences from spec TEXT that the build recorded and the
R1 code review adjudicated (D-1, D-3, D-4); none changes behavior a user or
the data sees. No unrecorded behavioral divergence found. Notes N-1..N-6 list
what the handback does not list (none is a defect).

## Conformance table

Paths are relative to the worktree. `pc.ts` = `app/src/lib/propertyContact.ts`,
`ur.ts` = `app/src/repos/unitsRepo.ts`, `ru.ts` = `app/src/routes/units.ts`,
`rf.ts` = `app/src/jobs/relayFanOut.ts`, `LD.tsx` =
`dashboard/src/routes/listing/ListingDetail.tsx`, `RCD.tsx` =
`dashboard/src/routes/shared/RosterConfirmDialog.tsx`, `script` =
`app/scripts/assign-primary-contacts.ts`.

### 4.1 P1 - the shared property-contact lookup

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 1 | Candidates: flagged primary from `unitContacts()`, then non-empty `landlordId` when different | CONFORMS | pc.ts:151-158 (`nonEmptyId` :33-35) | `propertyContactLookup.test.ts` cases at :59, :72, :121, :128 |
| 2 | Tenant test is an id comparison BEFORE any read; STOP `is_tenant`, no fall-through to the landlord | CONFORMS | pc.ts:161-164, :197, :237 | lookup cases :141, :155 |
| 3 | A thrown read STOPS the walk: `read_failed` with `candidateId`, never falls through | CONFORMS | pc.ts:171-172, :208-220 | lookup cases :184, :192; :238 (logs ids, returns read_failed) |
| 4 | Deleted or missing -> skip; exhausted -> `deleted` if any skipped else `none`; never throws | CONFORMS | pc.ts:173-181, :228-246 | lookup cases :79-:114 |
| 5 | Every ladder copy moves onto P1 (tourContacts, rosterResolution default, two rosterProvision diagnostics); no other copy left | CONFORMS | tourContacts.ts:144-160; rosterResolution.ts:329-347; rosterProvision.ts:187-213, :268-282, :567-582. Grep of app/src for `primaryContact === true` / `.primaryContact)` outside pc.ts/ur.ts finds no remaining ladder | `propertyContactLadderSingleSource.test.ts`, `tourContacts.test.ts`, `rosterResolution.test.ts` |
| 6 | Diagnostics keep codes/texts per state: none -> "unit has no landlord...", deleted -> "landlord contact not found", is_tenant -> today's answer, thrown read -> today's throw; placement: none/deleted -> `landlord_unreachable`, is_tenant -> `relay_member_unresolvable` | CONFORMS | rosterProvision.ts:206-211 (rethrows the captured error), :277-281, :573-588. Compared against `git show main:app/src/services/rosterProvision.ts` (tenant===contact reached "fewer than two reachable members" on both owners) | `rosterProvisionPropertyContact.test.ts` |
| 7 | A read failure keeps today's bare `{ contactId }` default-list row | CONFORMS | rosterResolution.ts:337-346 | `rosterPlanMaterializePropertyContact.test.ts` |

### 4.2 Liveness reads for writes

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 8 | ONE batch read with `requireComplete`; ANY throw (raw chunk or `IncompleteBatchReadError`) = unknown, never "deleted"; de-dup, never throws | CONFORMS | pc.ts:86-104 | `propertyContact.test.ts` (both shapes) |
| 9 | Read before the conditional write, refreshed on every retry; unit reads strongly consistent on these paths | CONFORMS (see N-1) | add ur.ts:1158, :1229-1234, :1310; remove :1334, :1373-1376, :1401; restore :1579, :1662-1669, :1713; hand-off :1736, :1745, :1761; restore route ru.ts (consistent `stored` read, ~:1992) | `unitsRepoPrimaryOnAdd.integration.test.ts:418`; `unitsRepoRestoreHandoff.integration.test.ts:289` |
| 10 | A just-deleted contact is never read; it is the EXCLUDED contact | CONFORMS | primaryHandoff.ts:100-105; ur.ts:1744-1746 | `contactDeletePrimaryHandoff.test.ts:200` |
| 11 | Unknown is never skipped as deleted | CONFORMS | pc.ts:294; ur.ts:353-354 | `propertyContactHeir.test.ts:32`; P2 unknown rows below |

### 4.3 The heir function

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 12 | ONE pure function used by the real repo AND the API-test fake | CONFORMS | pc.ts:287-322; ur.ts:1377, :1670, :1746; fake `app/test/helpers/twilioWebhookHarness.ts` removeContact / restoreWithLandlord / handOffPrimaryFrom call `chooseHeir` / `applyPrimary` (diff read) | `primaryHandoffParity.integration.test.ts:253` (remove, delete, swap, P2 cases) |
| 13 | Step 1: landlord of record if live and not excluded, NO type test; off-roster landlord -> `addLandlordRow` and the write adds a `role: 'landlord'` row | CONFORMS | pc.ts:303-310; `applyPrimary` :338-356 | `propertyContactHeir.test.ts:48`, `:59`, `:168` |
| 14 | Step 2: earliest-added roster contact ELIGIBLE (typed landlord, live, not a phone/email pointer) - `main`'s rule moved verbatim | CONFORMS | pc.ts:55-63, :312-320; no `autoRoutingEligible` / `soleLandlordToPromote` left in app/src (grep) | `propertyContactHeir.test.ts:89`; `autoRoutingEligibleSingleSource.test.ts` |
| 15 | Excluded contact counts as not live at EVERY step | CONFORMS | pc.ts:297-301 | `propertyContactHeir.test.ts:67`, `:102`, `:116` |
| 16 | none with `no_live_candidate` vs `no_eligible_candidate`; `unknown` on a failed read | CONFORMS | pc.ts:294, :312-321 | `propertyContactHeir.test.ts:32`, `:130`, `:147` |

### 4.4 P2 - auto-primary on add or edit

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 17 | "No primary" / "no landlord" mean no LIVE one (deleted or missing counts as absent) | CONFORMS | ur.ts:347-361 (`decideAutoPrimary`) | `unitsRepoPrimaryOnAdd.integration.test.ts:166`, `:182`, `:193`, `:210`; `unitsApiPrimaryOnAdd.test.ts:77`, `:99` |
| 18 | Only X: an add or an edit of X's own row; a write for X never promotes another; nothing outside the contact-list routes promotes | CONFORMS | ur.ts:328-337, :1222-1265 (only `contact.contactId` is ever flagged); no PATCH/status/photo hunk touches the roster | `unitsRepoPrimaryOnAdd.int:279`, `:300`; `unitsApiPrimaryOnAdd.test.ts:55`, `:159` |
| 19 | Promotion demotes every other row + sets the scalar in the same conditional write; nobody promoted and no row flagged -> REMOVE a stale scalar; a deleted contact still flagged keeps flag AND scalar | CONFORMS | ur.ts:1263-1285 | `unitsRepoPrimaryOnAdd.int:241`, `:346`, `:366`; `unitsApiPrimaryOnAdd.test.ts:139` |
| 20 | Liveness unknown -> the write succeeds unpromoted, with a WARN | CONFORMS | ur.ts:1229-1235, :1319; WARN ru.ts:1407-1417 | `unitsApiPrimaryOnAdd.test.ts:207` (it.each, both shapes); `unitsRepoPrimaryOnAdd.int:323` |
| 21 | 409 `primary_contact_deleted` only for a soft-deleted contact not already primary; re-sending true for the current primary never refused; deleted non-primary add allowed; ordered after the 404 and the type checks; decided again in the write | CONFORMS | ru.ts:1333-1381 (404 :1334-1337, caseworker :1358, landlord claim :1365, 409 :1370-1381), :1434-1441; ur.ts:1191-1199 | `unitsApiPrimaryOnAdd.test.ts:236-336` (incl. three order cases and the in-write race) |
| 22 | Properties with a live landlord of record are never touched by P2 | CONFORMS | ur.ts:330, :335 | `unitsApiPrimaryOnAdd.test.ts:119`; `unitsRepoPrimaryOnAdd.int:241` |

### 4.5 P2b

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 23 | `primary_contact` dropped from the writable unit fields; refused on create and PATCH like any non-writable key | CONFORMS | `app/src/lib/unitFields.ts:107-110`, refusal path :162-164 | `unitFields.test.ts` (create + update); `unitsApi.test.ts` "refuses primary_contact on create and on PATCH - 400, nothing written" |

### 4.6 P3 - hand-offs

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 24 | Remove the PRIMARY row: heir (removed excluded) -> flagged; no heir -> all flags cleared + scalar REMOVEd; unknown -> 503 `roster_read_failed`, nothing written; a non-primary remove needs no liveness | CONFORMS | ur.ts:1355-1386; ru.ts:1516-1537, :1550-1561 | `unitsApiPrimaryOnRemove.test.ts:53`, `:87`, `:106`, `:139`, `:165` (both shapes), `:194` |
| 25 | Delete the contact: after the soft delete persists, ONE consistent Scan (live + soft-deleted), match the `unitContacts()` flagged primary, excluded contact, heir -> flag+scalar move, no heir -> NOTHING changes, unknown -> skip + WARN, conditional failure -> consistent re-read + re-check + bounded retries, best-effort (never a 500), the deleted row stays | CONFORMS | `app/src/routes/contacts.ts:2251-2279`; `app/src/services/primaryHandoff.ts:63-160`; ur.ts:1502-1527 (`ConsistentRead`), :576-579 (`'any'` = no filter), :1730-1770 | `contactDeletePrimaryHandoff.test.ts:45`, `:80`, `:104`, `:123` (both shapes), `:152`, `:200`, `:224`; `primaryHandoffService.test.ts`; `unitsRepoHandOffPrimary.integration.test.ts` |
| 26 | Restore a contact: no roster change | CONFORMS | no code added to the contact restore route | `contactDeletePrimaryHandoff.test.ts:178` |
| 27 | Restore WITHOUT a landlord: by `landlordWasPrimary`, the remove rule (heir excluding the cleared landlord, earliest eligible; clear; unknown -> refuse); `soleLandlordToPromote` replaced | CONFORMS | ru.ts:581-605, :2062-2090; ur.ts:1624-1625, :1679-1693 | `unitsRestorePrimaryHandoff.test.ts:63`, `:109` (both shapes), `:131`; `unitsRestoreLandlord.test.ts` ("two remaining contacts typed landlord: the EARLIEST-added ... is promoted" replaces main's "nobody") |
| 28 | Landlord SWAP of a primary landlord re-runs the heir after the swap (a soft-deleted new landlord is not made primary); unknown -> 503 | CONFORMS | ur.ts:1650-1678; ru.ts:2105-2112 | `unitsRestorePrimaryHandoff.test.ts:154`, `:174`, `:195`, `:213`; `unitsRepoRestoreHandoff.int:132-289` |
| 29 | `landlordWasPrimary(roster, landlordId)`: flagged landlord row OR no row flagged; never reads the scalar; ONE rule for repo, route and fake; a no-hand-off restore re-aligns the scalar to the flag | CONFORMS | ur.ts:865-868, :1694-1701; ru.ts:595; fake restoreWithLandlord (diff read) | `landlordWasPrimary.test.ts:16-29`; `unitsRepoRestoreHandoff.int:397`, `:425` |
| 30 | Restore vs contact delete on a NO-flag roster differ on purpose (delete matches a flagged primary only) | CONFORMS | primaryHandoff.ts:87-88; ur.ts:1741 | F1 filed: `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md` |

### 4.7 P4

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 31 | What holds afterwards (at most one primary; scalar set/REMOVEd by every primary-moving write; nothing reads the scalar at runtime; known gaps incl. the R2-1 classification gap) | CONFORMS | writes rows 19, 24, 25, 27-29; grep: only `app/src/routes/webhooks/voice.ts:627` (a comment on the unbuilt path, spec 2 non-goal) mentions the scalar outside the writers | gap documented in spec 4.7, GLOSSARY:250-285, RUNBOOK.md:502 |

### 5.1 / 5.2 Intro fallback reasons

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 32 | `RelayComposeInputs.introFallback`, the 8-reason union, `{ reasons, unitId?, street?, propertyContactId? }`, reason order | CONFORMS | rf.ts:356-427 | `relayIntroFallback.test.ts:368` (spec order) |
| 33 | Owner read fails/missing -> `['lookup_failed']` alone; unit read fails -> `lookup_failed` + any tour reason | CONFORMS | rf.ts:429-431, :555, :598, :604, :937; :650-653 | `relayIntroFallback.test.ts:143`, `:164`, `:182`, `:191`, `:210`, `:217` |
| 34 | Every check evaluated; `lookup_failed` ADDED for P1 `read_failed`, a failed/empty settings read, an unformattable time; any reason -> naked (variant rule unchanged) | CONFORMS | rf.ts:655-718 | `relayIntroFallback.test.ts:226-435` (each alone, combinations, once-only lookup_failed) |
| 35 | Placements never carry tour reasons; ownerless never carries `introFallback`; member-added ignores it | CONFORMS | rf.ts:542, :677-678; composer for member-added unchanged | `relayIntroFallback.test.ts:116`, `:437`, `:462`; `relayIntroFallbackJob.test.ts:210` |
| 36 | `RosterPreview.introFallback` set by the tour and placement OPEN previews only (app + dashboard types) | CONFORMS | `app/src/services/rosterEdits.ts:357-364`, :618-630 (only `buildOpenPreview`; callers routes/tours.ts:1113, routes/placements.ts:1323); `dashboard/src/api/types.ts` IntroFallback | `rosterPreviewIntroFallback.test.ts:123-152`; `toursApi.test.ts` / `placementsApi.test.ts` preview-open pairs |
| 37 | Relay intro JOB logs one INFO line "when it SENDS the general intro", ids + reason codes only | DIVERGES (recorded D-4) | rf.ts:1103-1125: the line is logged after compose and BEFORE `sendRelayAnnouncement` (:1126), so it also fires when that send then fails or skips. Content conforms (ids + codes, message text exact) | `relayIntroFallbackJob.test.ts:136-210` |

### 7.1 / 7.2 Open-group dialog

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 38 | Amber box (the `.duplicateWarning` style), `role="status"`, ABOVE the message; heading per owner word for word; one line per reason in reason order, word for word; `<Street>` else "this property" / "This property" | CONFORMS | RCD.tsx:124-127, :131-140, :154-222, :393-424 | `RosterConfirmDialog.test.tsx` REASON_ROWS it.each + order cases |
| 39 | Links open in a NEW TAB; omitted when the id is absent; targets `/listings/<unitId>`, `/contacts/<propertyContactId>` | CONFORMS | RCD.tsx:158-167, :403 (`target="_blank" rel="noreferrer"`) | "omits a link whose id is absent"; e2e (b) asserts `target=_blank` and follows the popup |
| 40 | Check again: optional `onCheckAgain`, secondary/small, disabled while running, failure in the error line; callers re-fetch and replace the preview; 409 `relay_already_provisioned` closes the dialog and refetches the roster | CONFORMS | RCD.tsx:104, :112, :294-306, :408-422; `TourDetail.tsx:470-482`, :963-964; `PlacementDetail.tsx:352-364`, :810-811 | RCD tests (runs/disabled/failure x2/absent); TourDetail + PlacementDetail "Check again ..." x3 each |
| 41 | Edited-draft rule: remember the seed; unedited follows a new preview; edited is KEPT with "The intro changed." + "Use the updated intro"; what is sent: draft != CURRENT body posts `introBody` | CONFORMS | RCD.tsx:255-275, :285, :446-461 | RCD "the edited-draft rule" x5 |

### 7.3 / 7.4 / 7.6 Property page and Delete dialog

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 42 | Remove-the-primary notice reads the heir from the server block, word for word for named heir / unnamed heir / no heir / block absent ("calls and" dropped) | CONFORMS | LD.tsx:130-133, :621-628 | ListingDetail "NAMES the heir", "NO-primary outcome", "no name on record", "no propertyContact block", "LATEST roster write's block" |
| 43 | 503 `roster_read_failed` on remove -> "Couldn't check the other contacts - try again." in the row's error slot (and the landlord-restore dialog, R12) | CONFORMS (N-5) | LD.tsx:540-546; `rosterCopy.ts:13`; `RestoreLandlordDialog.tsx:99-104` | ListingDetail "a 503 roster_read_failed on removing the primary"; RestoreLandlordDialog 503 test |
| 44 | Box shown only when the block is PRESENT, `contactId` null, at least one row, property live | CONFORMS | LD.tsx:354, :478-479, :1027 | ListingDetail "no box when the block is absent / names a contact / soft-deleted property / zero rows" |
| 45 | Lead "No primary contact." or "This property's contact was deleted." (reason `deleted`) + the effect sentence, word for word | CONFORMS | LD.tsx:142-144, :1029-1034 | "a deleted property contact leads with ..." |
| 46 | Action counts ELIGIBLE rows (live, not caseworker): one -> "Make <Name> primary" (the same Make-primary write); two+ -> "Choose a primary" (edit mode); none -> the no-eligible line word for word | CONFORMS | LD.tsx:148, :480-481, :583-599, :1035-1064 | "exactly one eligible row", "counts only ELIGIBLE rows", "two or more", "no eligible row"; e2e (a), (c) |
| 47 | Zero rows: empty state gains "Tours need a primary contact." | CONFORMS | LD.tsx:1073 | "the empty state says tours need a primary contact" |
| 48 | "(deleted)" after the name in view and edit; no Make primary on a deleted row; role select and Remove stay | CONFORMS | LD.tsx:1088, :1122, :1155 | "marks a deleted row", "in edit mode a deleted row ..." |
| 49 | 409 `primary_contact_deleted` maps to its own copy, not the landlord-of-record catch-all | CONFORMS | LD.tsx:125, :553-559 | "a 409 primary_contact_deleted on Make primary names its own reason" |
| 50 | The facts subline's company skips deleted rows | CONFORMS | LD.tsx:365-366 | "the header facts subline skips a deleted row" |
| 51 | Delete dialog: the sentence for a non-tenant contact only, word for word | CONFORMS | `ContactDetail.tsx:140-141`, :1417 | `ContactDetail.test.tsx` landlord + partner yes, tenant no |

### 7.5 Payload additions

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 52 | ONE complete read of the roster ids AND `landlordId`; on a throw in EITHER shape fall back to today's best-effort names; the GET never 500s | CONFORMS | ru.ts:543-561 (`readRosterContacts` + `rosterContactIds`), best-effort :493-508 | `unitsApiPropertyContact.test.ts:258`, `:274-300` (both shapes, and both reads failing -> 200) |
| 53 | Row flags `deleted` (soft-deleted or missing) and `caseworker` only on a complete read | CONFORMS | ru.ts:551-557 | `unitsApiPropertyContact.test.ts:109`, `:211`, `:228` |
| 54 | Unit block `{ contactId (P1, no tenant), reason?, heirIfPrimaryRemoved {contactId, name?} | null }`, name present for an off-roster landlord | CONFORMS (D-2) | ru.ts:298-356 | `unitsApiPropertyContact.test.ts:77-211` |
| 55 | Served on GET and on both contact-list writes; the restore answer keeps today's enrichment (R18) | CONFORMS | ru.ts:742, :1495, :1571 | `unitsApiPropertyContactWrites.test.ts` |
| 56 | Page reads rows + block from the last ROSTER source; non-roster unit replacements keep them; after EITHER restore the page refetches and the refetch becomes the roster source | CONFORMS | LD.tsx:354, :424-441, :1566-1578; `useListing.ts` (block fixed at load) | ListingDetail "a restore re-reads the roster source" x2; `useListing.test.tsx` |
| 57 | Tour and placement People-card suggestions skip `deleted: true` rows | CONFORMS | `rosterPeople.ts:108-110`; `PlacementDetail.tsx:171-184` keeps the GET's rows after a final-rent PATCH (R2-2, beyond plan, consistent with 7.5) | `rosterPeople.test.ts`; PlacementDetail "a deleted row is still not offered after the final-rent PATCH" |

### 8 The one-time script

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 58 | `app/scripts/assign-primary-contacts.ts`, clean-org-names pattern: `--env`, dry run default, `--apply`, documented exit codes, NO lock | CONFORMS | script:40-55, :483-551 | `assignPrimaryContacts.cli.test.ts` |
| 59 | Reads every unit (live + soft-deleted) with a consistent Scan; complete contact reads | CONFORMS | script:281-292, :314 | `assignPrimaryContacts.run.test.ts:212`; `.integration.test.ts:138` |
| 60 | TARGET = flagged primary absent or not live AND the heir function yields an heir | CONFORMS | script:130-158 | `assignPrimaryContacts.plan.test.ts:46-119` (no primary, deleted primary + live landlord, missing, off-roster landlord, soft-deleted unit) |
| 61 | Its OWN conditional write against the roster + `landlordId` it read (never `addContact`); changed unit -> `skippedOnCondition`; flags the heir (landlord row added) and sets the scalar | CONFORMS | script:385-413; ur.ts:1558-1573 (one `updateRosterIfCurrent`, no retry) | `run.test.ts:219`, `:288`; `unitsRepoAssignPrimary.integration.test.ts` |
| 62 | Counted not written: `noHeir`, `noEligible` (listed by unit id), `unknown` | CONFORMS | script:150, :320-339 | `plan.test.ts:158`, `:170`, `:175`; `run.test.ts:313` (both shapes) |
| 63 | `scalarAligned`: live flagged primary with absent/other scalar, same conditional write, no audit; landlord-only units left alone | CONFORMS | script:135-147, :340-352 | `plan.test.ts:126`, `:141`, `:146` |
| 64 | `unit_primary_contact_assigned` `{ contactId, reason }` for backfill and every P2/P3 write (`auto_on_add`, `handoff_on_remove`, `handoff_on_delete`, `handoff_on_restore`); none on an explicit Make primary | CONFORMS | script:365-369; ru.ts:1469, :1477-1483, :1552-1561, :2136-2146; primaryHandoff.ts:119-124 | `unitsApiPrimaryOnAdd.test.ts:55`; `unitsApiPrimaryOnRemove.test.ts:53`; `contactDeletePrimaryHandoff.test.ts:45`; `unitsRestorePrimaryHandoff.test.ts:63`; `unitsApiRosterAutoPrimary.test.ts` (h3) |
| 65 | Activity projection serves `reason` for that event ONLY (R17); the renderer gains a line | CONFORMS | ru.ts:233-238, :270-275; `listingFormat.ts:172-178`, :237-245 | `unitsApiActivity.test.ts` (3, incl. listing_status_changed free text stays off the wire); `listingFormat.test.ts` |
| 66 | Dry run prints counts and unit ids only - never a person's name | DIVERGES (recorded D-1) | printed summary is unit ids only (script:441-476), but per-unit and summary JSON log lines also carry contact ids (`contactId`, `from`, script:357-359, :378). No name, phone or street anywhere | `run.test.ts:361` |
| 67 | Idempotent: a completed apply plans nothing on a re-run | CONFORMS | follows from row 60 + 63 | `run.test.ts:269`; `.integration.test.ts:138` |
| 68 | RUNBOOK section owed with the deploy (dry run, apply, dev then prod) | CONFORMS | `RUNBOOK.md:500-523` | - |

### 9.1 Mutation surfaces

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 69 | Unit create / PATCH: P2b only; `landlordId` reassign UNCHANGED | CONFORMS | no PATCH hunk in the ru.ts diff; row 23 | row 23 |
| 70 | Importer upsert / retract unchanged; P1 treats a missing contact as deleted | CONFORMS | no diff under `app/src/lib/import`; pc.ts:173-174 | lookup case :86 |
| 71 | API-test fake mirrors every new signature through the shared functions (addContact, removeContact, restoreWithLandlord, handOffPrimaryFrom, assignPrimaryIfCurrent) | CONFORMS | harness diff (read) | parity row 12 |
| 72 | Dashboard callers send unchanged requests | CONFORMS | LD.tsx:583-599 (same `addUnitContact` upsert) | - |
| 73 | Seeds UNCHANGED (lean byte-stable; performance seed) | CONFORMS | `git diff --name-only main...HEAD` lists nothing under `app/src/lib/seed*` | - |
| 74 | NEW dev-only seam, hermetic-only, structurally absent in deployed envs like `/__dev/reseed`; contract 2.7 as refined by R23 | CONFORMS | `app/src/routes/dev.ts:1263-1351` (1-5 rows, pm/owner/other only, contacts must exist, `setup`, no `landlordId`, no authorities, 201 `{ unitId }`, ids-only log); mounted only through `app/src/lib/devRoutes.ts:19-23` (unchanged gate) | `devZeroPrimaryFixture.test.ts:70-170` |

### 9.2 / 9.3 Readers and the filed gap

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 75 | Readers through `resolveTourContactNames` / `resolveRoster` inherit P1 (describeRoster's default re-resolves through `resolveRoster`); landlord-of-RECORD readers untouched | CONFORMS | rosterResolution.ts:638-656; no diff in placementNudges / personEvents / contactTimeline | shared-function coverage (R5) |
| 76 | The scalar has no runtime reader; the false comments are corrected (unitsRepo, conversationsRepo, routes/units, ListingDetail, rosterPeople, the rosterResolution docblock) | CONFORMS | grep (row 31); `conversationsRepo.ts:203-210`; rosterResolution.ts docblock (diff); LD.tsx diff; `rosterPeople.ts:58-59` | - |
| 77 | 9.3 filed as `docs/issues/relay-provision-includes-deleted-contacts.md` | CONFORMS | issue file (new) | - |

### 10 Testing

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 78 | App unit tests: P1, heir, P2 (incl. 409 only for deleted not-already-primary), P3 per path, the reasons | CONFORMS | - | rows 1-37 |
| 79 | Parity (real repo and fake share the function, pinned through both); injected batch read throwing in BOTH shapes on add, remove, GET and the delete fan-out; the 7.4 eligible count pinned separately from the automatic rule | CONFORMS | - | `primaryHandoffParity.integration.test.ts:253`; both-shape it.each in `unitsApiPrimaryOnAdd:207`, `unitsApiPrimaryOnRemove:165`, `unitsApiPropertyContact:274-280`, `contactDeletePrimaryHandoff:123` (and restore, `unitsRestorePrimaryHandoff:109`, `:213`); ListingDetail "counts only ELIGIBLE rows" (row flags, no type rule) |
| 80 | App API tests (7.5 block, preview `introFallback`, contact DELETE hand-off, P2b, Activity `reason`) | CONFORMS | - | rows 23, 36, 25, 52-55, 65 |
| 81 | Dashboard tests (dialog box, links, Check again, edited draft both ways, absent for standalone; property box variants; notice; 409 copy; suggestions; Delete sentence) | CONFORMS | - | rows 38-51, 57 |
| 82 | E2E: the seam + specs (a) box + Make <Name> primary, (b) dialog box + new-tab fix + Check again -> tour intro, (c) remove hand-off to the earliest eligible; no lean unit rewritten | CONFORMS | `e2e/tests/dashboard-next/primary-contact-integrity.spec.ts` (a) :120, (b) :166, (c) :253; `e2e/fixtures/primaryContact.ts` | gate 4 log: 350 passed (UNVERIFIED re-run) |

### 12 Docs and issues

| # | decision | verdict | code | test |
|---|---|---|---|---|
| 83 | GLOSSARY: add **property contact**; update **primary contact** (flag is truth; scalar absent on landlord-only units; handoff rule; "zero primary is reachable only with no live heir or for legacy data") | DIVERGES (recorded D-3) | `documentation/GLOSSARY.md:250-285`, :299-313. Everything is delivered, but the entry lists MORE zero-primary paths than spec 12's "only" (non-eligible adds, a later type change, an explicit API `primaryContact: false` on the primary's own row). The glossary is the accurate statement: spec 12's sentence contradicts the spec's own 4.4 and 4.7 | - |
| 84 | `tour-reminder-zero-primary-e2e-gap` item 1 partially addressed (ownerless leg); records under the reviews folder | CONFORMS | `docs/issues/tour-reminder-zero-primary-e2e-gap.md` (dated UPDATE block); `docs/superpowers/reviews/2026-10-12-primary-contact-integrity/` committed | - |

(RUNBOOK, spec 12's third bullet, is row 68; `relay-provision-includes-deleted-contacts`, its fifth, is row 77.)

## Non-CONFORMS rows

1. Row 37 - DIVERGES, LOW. The general-intro INFO line fires at compose time,
   before `sendRelayAnnouncement` (rf.ts:1103-1126), not "when it sends".
   Recorded as D-4 and accepted at build research and in R1 adjudications.
   Observability only; the line can over-report a general intro whose send
   then failed or was skipped.
2. Row 66 - DIVERGES, LOW. Script log lines carry contact ids beside unit ids
   (script:357-359, :378). Recorded D-1, accepted: spec 8's "unit ids only" is
   a PII rule and no name, phone or street is printed or logged.
3. Row 83 - DIVERGES, LOW. GLOSSARY's zero-primary list is longer than spec
   12's "only with no live heir or for legacy data". Recorded D-3, accepted;
   the glossary is right and spec 12's bullet is the stale text. Suggest the
   spec 12 bullet be corrected when the spec is frozen historical.

## Handback divergences - recorded and justified?

| handback item | recorded where | justified | reviewer view |
|---|---|---|---|
| (1) PlacementDetail keeps load-time rows/block across a final-rent PATCH | handback; R2-rereview R2-2; fix-wave-2 report | yes - spec 7.5 applied to the placement page | consistent with spec 7.5 (row 57) |
| (2) box button wraps (CSS) | handback; self-qa.md | yes - measured overflow | presentation only (`ListingDetail.module.css` `.noPrimaryBox p > button`) |
| (3) extra DynamoDB-Local test of the script's real wiring | handback; research deltas | yes | additive test |
| (4) comment/title/issue tidies | fix-wave reports | yes | - |
| spec amended on-branch: 8 (R17), 10 seam (R23), 4.7 known gap (R2-1), 10 reachability (R2-3) | handback; inline-dated in the spec; `git diff 14c2856b HEAD` on the spec shows exactly these three hunks | yes - two fold plan rulings, two correct facts | see N-3 |
| GLOSSARY lists more zero-primary paths (D-3) | handback; R1 adjudications | yes | row 83 |
| S3-F2 "403" withdrawn | handback; worklist-deltas | yes | n/a to conformance |
| staff copy not given by the spec: Check-again failure (P-2), Activity label + sub-lines (P-3), `Make <contactId> primary` (D-5), script operator text | handback; R21 at the launch gate | yes - spec silent on each | spec 7.1 asks only that a failure render in the error line; 8 asks only for "a line" |
| D-2 (block's heir null with no flagged row), D-6, D-7, D-8, D-9 | R1 adjudications | yes | spec silent or stricter; counted CONFORMS (rows 25, 54, 64) |

Every divergence the handback lists is recorded and carries a reason.

## Notes - what the handback does not list

- N-1 (row 9). P2's liveness read covers only the flagged primary and the
  landlord of record (`autoPrimaryLivenessIds`, ur.ts:328-337), not "the
  roster's contact ids and landlordId" as spec 4.2 words it. Plan contract 2.2
  (binding) specifies exactly this narrower read, and the decision needs no
  other id, so it CONFORMS to the binding plan; noted because the spec text
  reads wider and the handback does not mention it.
- N-2 (row 38). The fallback box renders only when the caller also passes
  `introOwner` (RCD.tsx:392), a gate the spec does not state ("when
  `preview.introFallback` is present"). Behaviorally equivalent: the server
  sets `introFallback` only on the two OPEN previews, and both callers pass
  `introOwner` (TourDetail.tsx:963, PlacementDetail.tsx:810).
- N-3. The spec's status line still reads "rev 6 - APPROVED", while sections
  4.7, 8 and 10 were edited on-branch after approval (6c68f342, 613edf85,
  913c1142). Each edit is dated inline and listed in the handback; the 4.7
  addition documents a gap whose product call (R2-1) is still Cameron's open
  question 3. No behavior hangs on it, but the header does not say the text
  moved after approval.
- N-4. The unit Activity projection also serves `from` for
  `unit_primary_contact_assigned` (ru.ts:263, the pre-existing generic `from`
  key, not a new whitelist entry). R17 narrows only `reason`, so this is
  within the rule; the dashboard does not render it (listingFormat.ts:237-245).
- N-5 (row 43). The remove 503 sentence renders twice while the confirm modal
  is open (row slot and modal, LD.tsx:1657-1661, same key). Listed in the
  handback as "your eye" item 4, not as a divergence; spec 7.3 names only the
  row slot.
- N-6. Spec 7.4's no-eligible line ("Add the landlord or property manager -
  they become the primary automatically.") is shipped verbatim and is false
  for the Landlord ROLE when a soft-deleted landlord of record exists (409
  `landlord_reassignment_required`). This is a spec copy defect, not a
  conformance gap; it is handback open question 1.

## Not verified here

- Test RESULTS and gate exit codes (not run; logs read only).
- The eslint baseline attribution of `TourDetail.tsx 342:85 react-hooks/purity`.
- Runtime behavior of the ESM import cycle `propertyContact.ts <-> unitsRepo.ts`
  (R3); the smoke gate log claims it resolves.
