# Plan assembly - planner rulings on the section writers' CONTRACT ISSUES

Plan: `docs/superpowers/plans/2026-10-12-caseworker-integrity.md` (skeleton
@54f9e6ed; drafts S1-S5 by five opus section writers, 2026-10-12). Each
writer listed contract issues at the top of its draft; the rulings below are
binding and override a draft where they differ. Findings file from research:
`plan-research/S5-findings.md` (F1, F2).

Totals: 33 issues (S1 6, S2 5, S3 5, S4 12, S5 5) plus findings F1/F2,
which S3-1 and S5-1 carry. ACCEPT 31, ACCEPT-AMENDED 1, noted 1 (line
drift), REJECT 0. Decision-level changes: the tour Reopen /
Reschedule dialogs join the copy sites (F1); the e2e proves the tour
refusals at the API and the on-screen sentence on the placement path (F2);
a ListingDetail crash on ownerless properties is fixed in scope (S4-10).

## S1 (accept fence)

| # | Issue | Ruling |
|---|---|---|
| 1 | `TENANT_ONLY_TARGETS` in the service would create an import cycle | ACCEPT: defined in `services/extraction/runTypes.ts`, re-exported from `suggestionResolution.ts` under the binding name |
| 2 | Position of the plan-time refusal | ACCEPT: in `resolve()` right after the consistent contact read, before `buildPlan`, for ACCEPT only (so before the org-list read and the 422 value check); a dismiss is never refused |
| 3 | Which read decides a classification-vs-field tie | ACCEPT: the repo's consistent re-read at `suggestionResolutionRepo.ts:822`; a narrow window can change only the answer code, never durable state |
| 4 | `guardMismatchIsClassification` on a missing contact; `effectiveGuard` on phone/dismiss plans | ACCEPT: false; `{}` |
| 5 | Emit assertion on the real-repo run (no router there) | ACCEPT: the `suggestion.updated` emit is asserted on FakeWorld routes only |
| 6 | Line drift in `types.ts` | noted |

## S2 (type change)

| # | Issue | Ruling |
|---|---|---|
| 1 | `refusalCopyByKind` cannot choose between two landlord sentences | ACCEPT: `holdingRefusals.ts` exports `typeChangeRefusalCopy`, `TYPE_CHANGE_LANDLORD_SENTENCE`, `typeChangeRefusalsFrom` and one shared `TypeChangeRefusalList` component (binding names amended) |
| 2 | Conversion importing `OPEN_TOUR_STATUSES` would leave unused imports (lint gate 5) | ACCEPT: the set moves to `contactHoldings.ts`; the conversion drops the now-unused imports |
| 3 | `contactTriage.test.ts:740-822` retypes a tenant with an open placement and is now refused | ACCEPT: the test's precondition becomes a contact-list seat (the conversion then answers `caseworker_on_roster`); the conversion's own test files stay unchanged (W2 holds) |
| 4 | W3 should include fixtures that retype contacts | ACCEPT: S5's sweep already covered type changes (none breaks) |
| 5 | Order vs the organization-name 422 | ACCEPT: the type check runs right after the caseworker 409, inside the classification block |

## S3 (tours / placements)

| # | Issue | Ruling |
|---|---|---|
| 1 | Tour dialogs (`TourModals.tsx` `failureCopy`) are the real revive/reopen sites | ACCEPT (planner-added from S5 F1): Task 3.13 |
| 2 | No phrase for a missing / unrecognized `contactKind` | ACCEPT: fallback phrase "not a tenant" |
| 3 | `toursApi.test.ts` posts tours for tenants never put in the world (113 blocks) | ACCEPT: a file-local fixture seeds the posted tenantId as a typed tenant only when absent, pinned by its own tests; the one test needing a missing tenant creates its tour directly in the store |
| 4 | Three fallback strings contain an em dash (ASCII rule vs W7) | ACCEPT: those lines are never touched; the new case returns early; tests match the fallback by an ASCII prefix |
| 5 | `deriveTenantStatus` read is eventually consistent | ACCEPT as is (an existing read; covered by L1) |

## S4 (properties)

| # | Issue | Ruling |
|---|---|---|
| 1 | "New seat" / "vacant claim" decided in the route from consistent reads | ACCEPT (L1 class) |
| 2 | Plain restore stays unconditioned | ACCEPT |
| 3 | Restore of a live unit does no landlord check, ignores a body | ACCEPT |
| 4 | `restoreWithLandlord` conditions on `contacts[]` and `landlordId`; contacts-only races retried 3x | ACCEPT |
| 5 | Contact-list landlord check reuses the route's contact read | ACCEPT-AMENDED: that read becomes consistent (the draft already does so, Task 4.x `consistentRead: true`) |
| 6 | PATCH `landlordId: ''` -> 404 `landlord_not_found` without a read (500s today) | ACCEPT |
| 7 | Invalid restore body -> 400 | ACCEPT |
| 8 | Restore dialog copy not in the spec | ACCEPT: title "Restore property"; picker label "Landlord"; in-dialog 409 `unit_roster_conflict` -> existing `ROSTER_RETRY_COPY`; other failure "Couldn't restore - please try again." |
| 9 | Restore-with/without answers the enriched roster | ACCEPT |
| 10 | "Remove the primary contact?" dialog crashes on ownerless properties (`ListingDetail.tsx:290/473`), now reachable more often | ACCEPT: keep Task 4.13 in scope (restore-without-a-landlord makes ownerless properties a normal outcome) |
| 11 | Task 4.1 (fixture prep) has no RED | ACCEPT as a stated exception |
| 12 | Three Restore entry points, one `onRestore` | ACCEPT (clarification; the dialog covers all three) |

## S5 (seeds / e2e / docs)

| # | Issue | Ruling |
|---|---|---|
| 1 / F2 | No listed dashboard site reaches a tour I2 refusal | ACCEPT: e2e proves tour refusals at the API, and the on-screen sentence on the placement path (a Lost placement moved back); Task 3.13 unit tests cover the dialogs |
| 2 | Restore dialog name / picker label unbound | ACCEPT: bound by S4-8 ("Restore property", "Landlord") |
| 3 | RED exception for e2e / doc tasks | ACCEPT (only 5.1 has a RED via negative controls) |
| 4 | Seed rule stricter than I2 (every seeded tour/placement names a tenant, open or closed) | ACCEPT (no seed needs otherwise; verified clean today) |
| 5 | e2e depends on S2-S4 render choices | ACCEPT: binding - refusals render inside the edit dialog with the draft kept (S2 Task 2.6), the placement refusal renders in PlacementDetail's existing `role="alert"` bar (S3 Task 3.17), restore buttons named exactly as plan section 1 |
| F1 | Tour dialogs map every 409 to "This tour changed" | ACCEPT: S3 Task 3.13 |

Seeds and e2e fixtures: S5 built every seed world in memory - none violates
I2-I4 today and no seed holds a caseworker. W3 fixture fixes are app-test
only: `toursApi.test.ts`, `toursReopenApi.test.ts`,
`scheduledUpdatedEvent.test.ts` (S3 Task 3.2); `unitsApi.test.ts`,
`unitsApiOrgNames.test.ts`, `unitsApiRoster.test.ts`, `unitsSoftDelete.test.ts`
(S4 Task 4.1). No e2e fixture needs changing.
