# Plan review R1 - reviewer A (adversarial, plan-blind to rationale)

Plan: `docs/superpowers/plans/2026-10-12-caseworker-integrity.md` (v1 @771edb52)
Spec: `docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md` (rev 3)
Rulings: `docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-research/plan-assembly-rulings.md`
Tree read: `W:\tmp\caseworker-integrity` @771edb52 (read-only; no tests run).

## Summary

The plan is unusually well grounded. I checked every old_string / "Before"
anchor I could reach in the slices against the tree (S1 service/repo/fake,
S2 contacts route + conversion, S3 tours/placements/statusTransition +
dashboard copy sites, S4 units route/repo/fake + ListingDetail/UnitCreateForm,
S5 e2e file tails, selectors.md, RUNBOOK, issue files): all exist verbatim and
are unique where the plan says so. Cross-slice names line up (contactKind,
OPEN_TOUR_STATUSES, contactTypeGuards exports, contactTypeErrorMessage,
holdingRefusals exports, restoreUnit opts, RosterWriteConflictError, the
dialog/button/copy strings S5 selects on). The S1 concurrency code (one
`effectiveGuard` at commit condition / re-read / ConditionCheck, the fake
reading it through the same export, classification-first answer, stored
outcome unchanged) is correct against `suggestionResolutionRepo.ts:770-863`
and `suggestionResolutionFake.ts:169-200,322-338`. Every mutation surface for
I2/I3 I could find in `app/src` is covered (tour/placement creators are only
`routes/tours.ts` and `routes/placements.ts`; stage writes only via
`transitionPlacement`, `routes/placements.ts:283` refuses `stage` on PATCH;
`units.create`/`addContact` callers only in `routes/units.ts`; the only
contact `type` writer is the contacts PATCH via `contactsRepo.update`, which
bumps `classification_revision` for any type/role key, `contactsRepo.ts:1467,1501`,
mirrored by the fake at `twilioWebhookHarness.ts:2420-2428`).

No BLOCKING or HIGH findings. One MEDIUM (a spec section 8 e2e item delivered
on a different surface on a premise the plan itself invalidates) and several
LOW items follow.

Claims I checked and found CORRECT (so nobody re-litigates them): Task 1.2's
RED for housingAuthority on a landlord is "200 vs 409", because the FakeWorld
org list fake creates the starting list on first read
(`test/helpers/orgListFake.ts:34-37`); the real integration test's org list is
likewise created on first `get()` (`orgListRepo.ts:166-185`); harness wires
`unitsRepo`/`placementsRepo`/`toursRepo` into the contacts router
(`twilioWebhookHarness.ts:5346-5352`); `useContacts('all')` includes partners
(`dashboard/src/routes/contacts/useContacts.ts:31`), so S5's positive control
works; `gateFor('lost','send_application')` is `'none'`
(`dashboard/src/routes/placements/transitionGate.ts:21-30`), so the S5 hub test
needs no confirm; `UnitCreateFormProps.landlordId` exists
(`UnitCreateForm.tsx:40-45`); ListingDetail.test already mocks
`getAllContacts` (`ListingDetail.test.tsx:22,46`); `unitContacts` and
`isDeleted` are already imported in `routes/units.ts:46-60`; journal-sweep deps
take `Pick<...>` (`jobs/journalSweep.ts:88-94`), so the real-repo sweep test's
partial repo typechecks.

---

## F1 [MEDIUM] Task 5.5 (and ruling S5-1/F2) - spec 8 "a refused tour action shows its sentence" is not delivered, on a premise Task 3.13 removes

What is wrong. Spec section 8 "e2e" asks for "a refused tour action shows its
sentence". S5 CONTRACT ISSUE 1 and ruling S5-1/F2 replace that with (a) API-only
assertions for tour reopen/revive and (b) the on-screen sentence on the
PLACEMENT hub. The stated reason is that "No dashboard path reaches a TOUR I2
refusal at a site the spec lists; the tour dialogs answer every 409 with 'This
tour changed'" (plan S5 CONTRACT ISSUE 1, citing `TourModals.tsx:44-46`). But
the same plan's Task 3.13 changes exactly that: `failureCopy` returns
`contactTypeErrorMessage(err)` before its 409 rule, so after S3 the Reopen
dialog (and the Reschedule dialog that revives a canceled tour) DOES show
"Tours and placements are for tenants, and this contact is a landlord." The
premise is false by the time S5 runs.

Evidence.
- `dashboard/src/routes/tours/TourModals.tsx:41-46` (the rule Task 3.13 replaces).
- Plan Task 3.13 step 3b (new `failureCopy`), plan Task 5.5 step 3 header
  comment: "the tour page reaches these refusals only through the Reopen and
  Reschedule dialogs, whose own copy answers every 409 (TourModals.tsx
  failureCopy)" - false after 3.13, and it would be committed.
- The path is already driven by e2e: `e2e/tests/dashboard-next/tour-auto-close.spec.ts:287-296`
  ("a not-a-fit tour reopens straight into Record outcome": goto tour,
  `Reopen tour`, dialog, `Yes, reopen`). Task 5.5's new describe already holds
  a CLOSED not_a_fit tour whose tenant was re-typed (`closedTourId`).

What it implies. The real revive/reopen UI wiring (the surface a staff member
actually hits) is covered only by a mocked unit test (3.13); a regression in
TourDetail's confirmReopen/confirmReschedule plumbing would not be caught by
the e2e gate, and the spec's explicit e2e item is unmet. Fix in the plan: in
Task 5.5's tour block, after the re-type poll, `page.goto` the closed tour,
click `Reopen tour` -> `Yes, reopen`, and assert the dialog's `role="alert"`
reads the landlord sentence (keep the API asserts); delete/correct the stale
comment and S5 CONTRACT ISSUE 1 (a)/(b) wording, and the selectors.md row can
then name the tour dialog too.

## F2 [LOW] Section 1 ruling P-1 - the approved `contact_not_tenant` copy is rewritten without a recorded human sign-off

What is wrong. Spec section 4 "Dashboard copy" fixes the sentence as
"Tours and placements are for tenants. This contact is a <kind label>." with
labels "Caseworker, Landlord, Partner, Team member, Unknown". Plan section 1
replaces it (planner ruling P-1) with "Tours and placements are for tenants,
and this contact is <phrase>." and phrase "not classified yet" for unknown,
plus an invented fallback "not a tenant". The spec was approved at Cameron's
gate; the rulings file records no human decision on this copy.

Evidence. Spec section 4 lines 335-337; plan section 1 lines 84 and 91-94;
the reworded sentence is then baked into Task 3.11 tests, Task 5.5 e2e
(`NOT_A_TENANT_LANDLORD`), Task 5.6 selectors row, Task 5.8 issue resolution
text.

What it implies. Shipped staff copy differs from what was approved. Small
consequence, but it is a decision the planner took for the human; confirm with
Cameron before build or revert to the spec's sentence shape.

## F3 [LOW] S1, S3, S4 slice gates run no lint; S3 edits two files that already carry react-hooks errors the plan never names

What is wrong. Only S2 and S5 run `npx eslint` in their slice gates; S1, S3
and S4 do not, so a new lint error in those slices surfaces only at the final
gate 5. Two S3 files are already dirty at base, which the plan does not say:
- `dashboard/src/routes/tours/TourDetail.tsx:341` - `react-hooks/purity`
  (`Date.now()` during render) - touched by Task 3.12;
- `dashboard/src/routes/tours/ScheduleTourForm.tsx:241` -
  `react-hooks/set-state-in-effect` - touched by Task 3.14.
(Measured with `npx eslint` on the base tree; the other files S3/S4 edit -
TourModals, PlacementCreateForm, PlacementsPage, PlacementDetail,
ListingDetail, UnitCreateForm, ContactEditForm, UnknownFile, TenantFile,
ContactDetail, CaseworkerDialog, endpoints/types, and the app routes/repos/
services touched - lint clean at base.)

What it implies. Gate 5 will report these two errors on the branch; per
AGENTS.md they are pre-existing and must be attributed by baseline and named
in the handback. Add an eslint line to the S1/S3/S4 slice gates and a note
naming the two pre-existing errors, so they are not mistaken for S3's (or,
worse, "fixed" in scope).

## F4 [LOW] Section 2 / ruling S2-1 bind `TypeChangeRefusalList` to `holdingRefusals.ts`; S2 builds it elsewhere

What is wrong. Plan section 2 (Dashboard) and ruling S2-1 say
`dashboard/src/lib/holdingRefusals.ts` exports "... `typeChangeRefusalsFrom` and
one shared `TypeChangeRefusalList` component". `holdingRefusals.ts` is a `.ts`
module (no JSX); S2 Task 2.6 creates the component as
`dashboard/src/routes/contact/TypeChangeRefusalList.tsx` and Tasks 2.7/2.8
import it from there.

Evidence. Plan lines 164-170; rulings S2-1; plan Task 2.6 "Create
dashboard/src/routes/contact/TypeChangeRefusalList.tsx".

What it implies. A builder or reviewer coding/checking against the binding
section would look for (or import) an export that does not exist. Amend the
binding text to the real path.

## F5 [LOW] Task 4.11 - a restore conflict re-reads the unit but leaves the Contacts card's roster stale

What is wrong. The dialog's `onConflict` does `getUnit(...)` then
`setUnit(fresh)` only. Every other roster settle in ListingDetail applies the
re-read through `applyRosterUnit` (which sets both `rosterUnit` and the page
unit), e.g. `runRosterWrite`'s 409 path.

Evidence. `dashboard/src/routes/listing/ListingDetail.tsx:370-373`
(`applyRosterUnit`), `:415` (`applyRosterUnit(await getUnit(unit.unitId))`);
plan Task 4.11 step 3e `onConflict`.

What it implies. After a concurrent change the Contacts card can show the old
landlord row while the header shows the re-read unit. Use `applyRosterUnit`
there, as the success path in the same task already does.

## F6 [LOW] Task 4.10 - the restore conflict sentence is a second literal copy of `ROSTER_RETRY_COPY`

What is wrong. Ruling S4-8 binds "in-dialog 409 unit_roster_conflict -> the
existing ROSTER_RETRY_COPY". Task 4.10 instead declares
`RESTORE_CONFLICT_COPY = 'The property contacts changed - try that change again.'`
in the new component.

Evidence. `ListingDetail.tsx:123` (ROSTER_RETRY_COPY, not exported); plan Task
4.10 step 3.

What it implies. Two literals for one sentence drift independently (the
existing tests pin each separately). Export the existing constant (or move it
to a shared module) and import it.

## F7 [LOW] Unenumerated I4-adjacent writer: `primary_contact` on unit create/PATCH

What is wrong. Spec section 5 lists the contact-list writers as
"`POST /api/units/:id/contacts` only", and the plan inherits that list (W1).
But `primary_contact` - "the property's default contact - relay groups and
masked calls" - is directly writable on `POST /api/units` and
`PATCH /api/units/:id` with any contactId: no existence, type, caseworker or
seat check.

Evidence. `app/src/lib/unitFields.ts:104` (`primary_contact: 'string'`);
`app/src/routes/units.ts:1055-1058` (comment: the scalar is the relay /
masked-call default contact). UNVERIFIED that anything routes on it TODAY:
the only mentions outside units/unitFields/seeds are comments -
`app/src/routes/webhooks/voice.ts:627` says the main-number ->
landlord-by-unit (`primary_contact`) masked path "stays M1.10", and
`app/src/repos/conversationsRepo.ts:207` names it as the landlord-leg target.

What it implies. A caseworker can be written as a property's default contact
without ever taking a contact-list seat, which the I4 rule otherwise prevents.
Impact today appears nil (no live reader found), and it is not a contact-list
seat by the spec's definition - but W1 says a surface the plan does not list
is a STOP-and-record, and the M1.10 path would make it live. Record it
(findings file or a filed issue) rather than leave it implicit.

## F8 [LOW] Spec 8 asks D1 tests "real AND fake"; several of its "Plus" items run on the FakeWorld only

What is wrong. Spec section 8 "D1, real AND fake" then lists "Plus:" items.
The plan runs these on FakeWorld routes only: the phone accept claimed before
the conversion (Task 1.7), the voucherSize accept spanning a generic re-type
(Tasks 1.3/1.7), and the status accept spanning a conversion (Task 1.7). On the
real repo the plan covers the tie and the neutral-address commit at repo level
(Task 1.5) and schedules A/B/legacy for housingAuthority (Task 1.7).

Evidence. Spec section 8 lines 443-461; plan "Surfaces covered" table rows for
spec 8 (lines 3147-3152).

What it implies. If "Plus" is read as inheriting "real AND fake", the
generic-re-type fence (revision bump by the contacts PATCH through the REAL
`contactsRepo.update` UpdateExpression, `contactsRepo.ts:1501-1507`) is never
exercised end to end on DynamoDB Local. Either add one real-repo case (a
voucherSize claim, a real `contacts.update(id, { type: 'landlord' })`, then
`commitContactEffect` -> `superseded_by_reclassification`) or record the
reading of the spec in the plan.

## F9 [LOW] Task 3.2 - the W3 sweep record misses one app test that posts `/api/placements`

What is wrong. Task 3.2 states "No other app test posts `/api/tours`,
`/api/placements`, `/from-tour`, `/reopen` or `/transition`."
`app/test/contactVoucherSync.test.ts:82` posts `/api/placements` (for `tn-3`,
seeded `type: 'tenant'` at :76-79, so it stays green).

Evidence. `app/test/contactVoucherSync.test.ts:76-84`.

What it implies. No breakage, but the slice report's W3 list is incomplete;
add the file to the "checked, already typed tenant" row and to Task 3.6's
GREEN run so the claim is true.
