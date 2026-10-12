# Spec review R1 - planner adjudications

Spec: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`,
revision 1 (cc10cb44) reviewed; revision 2 carries the outcome.
Reviewers: A (`R1-reviewer-a.md`, 12 findings) and B (`R1-reviewer-b.md`,
15 findings), both opus, independent, spec + repo only.

Totals: 27 findings, 19 distinct (rows 1-19). ACCEPT 17 (row 4 accepted as
a scoping), ACCEPT-NARROWED 2, REJECT 0. Row 20 is a follow-up the planner
filed out of row 1, not a reviewer finding. Load-bearing claims about
existing behavior were re-checked in code before acceptance (noted per item).

Decision changes in this round (so the round was NOT terminal): the
landlord-of-record rule for a type change now counts live units only and
unit restore became a new I3 surface (A1/B3); a plan-time "contact is not a
tenant" refusal was added for tenant-only accepts (A2/B6); the roster
checks were narrowed to new seats and new landlord claims (B8); the new
"deleted contact -> 404" behavior was dropped (B9). Cameron asked for ONE
spec round, so no round 2 runs unless he asks for it at the spec gate.

| # | Finding (reviewer) | Ruling | Reason / change |
| --- | --- | --- | --- |
| 1 | Landlord-of-record refusal on a type change is a dead end: no UI reassigns `landlordId`, soft-deleted units count, copy instructs an impossible action (A1 HIGH, B3 MED) | ACCEPT | Verified: no dashboard writer of `landlordId` after create (`UnitCreateForm.tsx:192` only), deleted property page is read-only. Rev 2: the type change counts LIVE units only; unit restore (`POST /api/units/:id/restore`, `units.ts:1517`) becomes an I3 surface and refuses when the landlord of record is no longer a landlord (remedy exists: re-type the contact back). Type-change sentence rewritten to say the landlord cannot be changed in the dashboard yet. The conversion is unchanged (non-goal). |
| 2 | Fence covers only a reclassification inside the claim; an accept planned against an already non-tenant contact commits (A2 MED, B6 LOW) | ACCEPT | Verified: `buildPlan` reads no type for the six fact targets; extraction itself only produces them for tenants (`extraction/apply.ts:137-142` `fieldApplies`). Rev 2 adds D1.2: refuse a tenant-only accept before the claim when the contact is not typed `tenant` (409 `suggestion_contact_not_tenant`, chip kept so staff can dismiss it). |
| 3 | New 409 `suggestion_contact_reclassified` unknown to the SSE emit, the copy map and the refetch list (A3 MED, B1 HIGH) | ACCEPT | Verified `routes/suggestions.ts:224-226`, `ContactDetail.tsx:720-725`, `api/types.ts:1677`. Rev 2 names all three sites and their tests. |
| 4 | The specific answer cannot reach a requester whose journal is helped or replayed (A4 MED) | ACCEPT (scope) | Pre-existing for `suggestion_field_edited`. Rev 2 scopes the new answer to the uninterrupted request; helped/replayed requests keep today's answers. No new durable disposition. |
| 5 | Tour PATCH can move `canceled` -> `toured` / `no_show`; the revive row names only the reschedule (A5, B2 MED) | ACCEPT | Verified `tours.ts:1210-1265`. Rev 2 states the rule by RESULT: check when the current status is `canceled` or `closed` and the resulting status is open. |
| 6 | Dashboard surfaces for the new refusals not enumerated; several show raw codes or fixed copy (A6 MED) | ACCEPT | Verified TourDetail `err.message` at :382/:514/:589, bare catches in ScheduleTourForm :326 and PlacementCreateForm :248, fixed copy PlacementsPage :96 and PlacementDetail :402. Rev 2 lists each site and a shared copy helper. |
| 7 | 409 body carries only the stored type, so "Caseworker" cannot be shown (A7, B7 LOW) | ACCEPT | Rev 2 body carries `contactKind` (`caseworker` when `isCaseworker`, else the type). |
| 8 | Tie-break "report the field edit" mislabels conversion cases; role-only edits read as "type changed" (A8, B5 LOW) | ACCEPT | Rev 2: a classification mismatch wins the tie; copy says "type or role". |
| 9 | Reporting the reason changes the repo result union, the fake and the service flag (A9, B5 LOW) | ACCEPT | Rev 2 names the new result value `superseded_by_reclassification`; the stored journal outcome and run-log verdict stay as today. |
| 10 | Transition error mapping (400 / contact_not_found) cannot carry the new refusal (A10, B7 LOW) | ACCEPT | Verified `routes/statusTransition.ts:330-342`. Rev 2 specifies a dedicated error class mapped to 409 with the body. |
| 11 | Factual errors: section cross-refs, edit-form copy claim, phone accepts use `commitPhoneEffect`, I4 overstated (A11, B12, B13 LOW) | ACCEPT | Fixed in rev 2. |
| 12 | Importer also escapes I1 (never bumps the revision) (A11, B11 LOW) | ACCEPT | Verified `import/apply.ts:1071-1073`. The filed importer issue names I1 too. |
| 13 | Check order on `POST /api/units/:id/contacts` unspecified (A12 LOW) | ACCEPT | Rev 2: caseworker check, then landlord-claim check, both before the repo call; the repo's `landlord_reassignment_required` after. |
| 14 | Legacy effective guard must reach all three real-repo guard sites (commit :798, stale-vs-mismatch :827, mismatch check :831) or the journal loops as stale forever (B4 LOW) | ACCEPT | Verified. Rev 2 names the three sites and requires the legacy case on the real repo. |
| 15 | Roster row actions (Make primary, role select) hit the new checks; `runRosterWrite` catch-all copy is false for them (B8 LOW) | ACCEPT-NARROWED | Verified `ListingDetail.tsx:115-116,388-445`. Rev 2: the caseworker check applies to a NEW seat only and the landlord check to a NEW claim only (an existing owner re-asserting or an existing seat being edited is not refused); `runRosterWrite` maps the new codes before its catch-all. |
| 16 | "Deleted -> 404" is new behavior with no UI handling and strands a convertible tour (B9 LOW) | ACCEPT-NARROWED | Dropped from rev 2: create paths keep today's existence semantics (a soft-deleted contact passes the existence check as now, and is still type-checked). Out of scope. |
| 17 | L2 rationale wrong: caseworkers can be created directly via POST /api/contacts (B10 LOW) | ACCEPT | Rev 2 restates L2 without the claim; production data unverified. |
| 18 | Tenant-only (not `unknown`) is an unrecorded departure from the issue's suggestion (B14 LOW) | ACCEPT | Rev 2 records Cameron's 2026-10-12 ruling and why the readers' `unknown_1to1` acceptance stays. |
| 19 | L1 understates its window: refusal reads are GSI reads; D3 contact reads unspecified (B15 LOW) | ACCEPT | Rev 2 requires consistent contact reads in D3 and restates L1 as an index-propagation window. |
| 20 | No UI exists to reassign a property's landlord of record | DEFER | Filed as `landlord-of-record-no-reassign-ui` in this branch (named in rev 2 section 7). |
