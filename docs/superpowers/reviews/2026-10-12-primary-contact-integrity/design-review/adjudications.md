# Spec design review - adjudications

Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`.
Planner: Claude (feature-mission planner). Reviewer severity is the
reviewer's; "decision changed" is the planner's call after adjudication.

## Round 1 (spec rev 1 @47a0796e)

Reports: `spec-R1-reviewer-a.md` (18 findings), `spec-R1-reviewer-b.md`
(20 findings). 38 findings, 24 distinct after merging duplicates. Load-bearing
claims about existing behavior were re-checked in the code before accepting
(the delete dialog copy `ContactDetail.tsx:1358-1362`, the test fake's
twin roster logic `twilioWebhookHarness.ts:2940-3017`, the Activity
projection whitelist `routes/units.ts:217-248`, the suggestion source
`useTour.ts:90` / `PlacementDetail.tsx:185` = `getUnit`).

Result: 24 ACCEPT (some with a different mechanism than proposed, noted),
0 REJECT, 0 DEFER. Decisions changed: YES (J1-J10, J12, J16, J19, J21, J22)
-> round 2 required.

| id | findings | verdict | decision changed? | resolution in rev 2 |
|---|---|---|---|---|
| J1 | B1, A4 | ACCEPT | yes | The DELETE handoff moves the flag only to a LIVE heir. With no heir it changes nothing (no flag clear, no materialized landlord row), so delete-then-restore is lossless again. Only REMOVE and the landlord-clearing restore can clear the flag. |
| J2 | B2, A8 | ACCEPT | yes | New section 4.2 liveness contract: one COMPLETE batch read (`requireComplete`) before the conditional roster write, refreshed on every retry; an unread candidate is "unknown", never "deleted". Per-path rule: remove refuses (503 `roster_read_failed`, nothing written); add proceeds without promotion; delete fan-out skips that unit; script counts it. The race with a concurrent contact delete is stated. |
| J3 | B3, A7 | ACCEPT | yes | The 7.5 block is computed from a complete read and is ABSENT when the read is incomplete ("could not tell"); per-row `deleted` is set only on a complete read. No box, no "(deleted)" mark, generic notice on unknown. |
| J4 | B4, A1 | ACCEPT | yes | "Make primary" hidden on deleted rows; the 409 fires only when a write would make a deleted contact primary that is not ALREADY primary (re-role of a legacy deleted primary keeps working); new code mapped to its own copy, not the landlord-of-record catch-all. |
| J5 | B5, A16a | ACCEPT | yes | People card suggestions (`rosterSuggestions`) skip deleted rows; 9.2 corrected (the TourDetail range is no longer listed as landlord-of-record-only). |
| J6 | B6, A6 | ACCEPT (different mechanism) | yes | Not "every unit response carries the block" (heavy, many routes): the page REFETCHES the unit after either restore, and replacements that do not change the roster (PATCH, status, photos) keep the roster rows and block from the last roster source. |
| J7 | B7, A3 | ACCEPT | yes | P1's read-failed outcome carries the candidate id; the default people list keeps today's bare row on it; every P1 outcome is mapped to today's diagnostic code for the equivalent case. |
| J8 | B8, A4 | ACCEPT | yes | P2 runs the heir function (landlord first, then earliest-added live), not "the added contact". Same person in the 470 Bolton case; consistent with P3, the script and the heir field in every other case. |
| J9 | B9, A2 | ACCEPT | yes | The script does its own conditional write against the roster IT read (`skippedOnCondition` real); it never calls `addContact`, so it cannot overwrite a primary set meanwhile. |
| J10 | B10 | ACCEPT | yes | Script target = flagged primary absent OR not live, AND the heir function yields an heir. Units with no heir are counted separately. |
| J11 | B11, A17 | ACCEPT | small | G1 and P4 restated as best-effort with named backstops; P2 with no heir REMOVEs a stale scalar. |
| J12 | B12, A11 | ACCEPT | yes | P1 keeps today's tenant semantics: the walk STOPS at a candidate who is the tenant (no fall-through to the landlord). |
| J13 | B13, A12 | ACCEPT | no | Section 1 corrected: a soft-deleted primary with a phone IS texted today. |
| J14 | B14, A13 | ACCEPT | no | "Partially addresses item 1" (the ownerless leg); the landlord-fallback leg stays open. |
| J15 | B15, A14 | ACCEPT | no | 409 is reachable for a soft-deleted contact only; it is checked after the route's 404 and after caseworker-integrity's type checks (plan pins the order). |
| J16 | B16, A15a | ACCEPT | yes | Heir step 1 includes a live landlord of record who has NO roster row: the handoff re-adds their row (`role: 'landlord'`) as primary. This fixes today's flag/scalar disagreement and the false no-heir notice. The importer's re-import `if_not_exists(landlordId)` is named as a landlordId surface. |
| J17 | B17, A15b | ACCEPT | no | Reason copy says "the contact on file", not "primary contact"; P1's nobody-reason is defined as WHY THE WALK ENDED (is_tenant if it stopped on the tenant; deleted if every candidate examined was deleted/missing; none if there were no candidates). |
| J18 | B18 | ACCEPT | no | The delete fan-out matches the primary through `unitContacts()`, never the scalar; section 3 no longer calls the scalar a mirror (it is absent on every landlord-only unit). |
| J19 | B19, A10 | ACCEPT | yes | Every write that sets or moves the primary goes through the heir function, including caseworker-integrity's SWAP restore (re-run when the old landlord was primary). That branch's tests asserting "no primary after a clear" will change - flagged for the plan. |
| J20 | B20 | ACCEPT | no | Full list of stale "masked call" comments in 9.2. |
| J21 | A5 | ACCEPT | yes | Contact Delete dialog gains one sentence for non-tenant contacts: the next contact takes over as primary, and restoring does not change that back. |
| J22 | A9 | ACCEPT | yes | The heir function is PURE and shared by the real repo and the API-test fake (`twilioWebhookHarness.ts`), which is listed as a surface. |
| J23 | A16b | ACCEPT | no | The property facts subline (`ListingDetail.tsx:291`) skips deleted rows. |
| J24 | A18 | ACCEPT | no | 5.1 wording fixed (owner/unit read failure leaves nothing else decidable); the script takes no lock (every write is conditional); the Activity projection whitelist gains `reason` and the renderer a line; the delete Scan's cost is stated. |

## Round 2 (spec rev 2 @8c2c727e)

Report: `spec-R2-reviewer-b.md` (reviewer B continued, 11 findings + one
section-10 addition). Re-checked: `unitsRepo.list` Scan has no ConsistentRead
(`unitsRepo.ts:1026-1043`); the batch read has none either
(`contactsRepo.ts:979`); `requireComplete` throws `IncompleteBatchReadError`
with no partial map (`contactsRepo.ts:996`).

Result: 11 ACCEPT (R2-9's tenant-typed sub-point accepted as a STATED known gap
rather than fixed), 0 REJECT. Reviewer conceded J6 and did not contest the
other mechanisms. Decisions changed: YES (K1, K2) -> round 3 required.

| id | finding | verdict | decision changed? | resolution in rev 3 |
|---|---|---|---|---|
| K1 | R2-1 HIGH | ACCEPT | yes | P2 triggers on "no LIVE flagged primary" (none flagged OR the flagged contact deleted/missing); every add does the liveness read. "Delete Mark then add a replacement" now promotes, same as the other order. |
| K2 | R2-2 | ACCEPT | yes | The excluded contact counts as not live at EVERY heir step (landlord included); the delete fan-out excludes the just-deleted contact instead of reading it; its Scan is strongly consistent; a conditional-write failure re-reads the unit consistently and re-decides with bounded retries. |
| K3 | R2-3 | ACCEPT | no | The 7.5 read (and every 4.2 read) includes `landlordId`. |
| K4 | R2-4 | ACCEPT | no | P1's tenant test is an id comparison BEFORE the read, as today. |
| K5 | R2-5 | ACCEPT | no | Diagnostics keep their codes AND their texts for the state each describes today; per-reason mapping stated; placement keeps its single code; the plan pins strings against the verbatim tests. |
| K6 | R2-6 | ACCEPT | no | Incomplete 7.5 read falls back to today's best-effort read for names. |
| K7 | R2-7 | ACCEPT | no | The post-restore refetch replaces `rosterUnit` and becomes the roster source. |
| K8 | R2-8 | ACCEPT | small | P4 reworded; the script also aligns a disagreeing scalar on units with a live stored primary (`scalarAligned`, no audit event). |
| K9 | R2-9 | ACCEPT (partly as known gap) | no | 7.4 deleted lead says "This property's contact was deleted."; the 7.5 heir carries a name (off-roster landlord included); 7.6 says "the landlord or another contact"; the tenant-typed-primary dialog case is stated as an accepted gap. |
| K10 | R2-10 | ACCEPT | no | The e2e seam creates its OWN unit + contact, never rewrites a shared lean unit. |
| K11 | R2-11 (contests J24) | ACCEPT - reviewer right | no | A UNIT read failure keeps the decidable tour reasons beside `lookup_failed`; only an OWNER read failure stands alone. |
| K12 | section-10 note | ACCEPT | no | The 503 / unknown paths are tested with an injected contacts repo (the fake ignores `requireComplete`). |
