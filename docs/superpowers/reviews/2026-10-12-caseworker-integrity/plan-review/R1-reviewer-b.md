# Plan review R1 - reviewer B (adversarial, plan-blind to rationale)

Plan: `docs/superpowers/plans/2026-10-12-caseworker-integrity.md` (v1 @771edb52,
sections 0-3 binding, slices S1-S5, CK) with the assembly rulings
`plan-research/plan-assembly-rulings.md`. Spec:
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md` (rev 3).
Tree read: `W:\tmp\caseworker-integrity` @771edb52. Nothing was run except
reads, greps and git reads; no tests, servers, e2e or DynamoDB.

## Summary

No BLOCKING or HIGH defect found. The plan is unusually well anchored: every
`old_string` / "Before" block I checked against the tree matches verbatim and
uniquely (list at the end), every cross-slice import names something an
earlier slice actually defines, and the TDD RED claims I traced hold. The
findings below are two MEDIUM spec-delivery gaps (one e2e item silently
downgraded on a premise the plan itself invalidates; one approved copy string
rewritten by a planner ruling) and four LOW accuracy items.

---

## F1 - MEDIUM - Task 5.5 (+ ruling S5-1 / F2): spec 8's "a refused tour action shows its sentence" is not delivered, and the stated reason is false once Task 3.13 lands

What is wrong. Spec section 8 "e2e" requires extending existing specs for
"a refused tour action shows its sentence". Ruling S5-1 / F2 replaced that
with (a) tour refusals asserted at the API only and (b) the on-screen sentence
proved on the PLACEMENT path. The ruling's premise (S5 CONTRACT ISSUE 1, plan
~12325-12345): "No listed dashboard site reaches a tour I2 refusal ... the tour
dialogs answer every 409 with 'This tour changed'". Task 3.13 (plan ~8100-8300)
then makes exactly those dialogs (`ReopenTourModal`, `RescheduleTourModal`
via `failureCopy`) show the contact-type sentence. After S3, the tour page DOES
reach a tour I2 refusal with its sentence, through a UI the e2e suite already
drives.

Evidence.
- `e2e/tests/dashboard-next/tour-auto-close.spec.ts:286-312` already creates a
  tour, closes it not_a_fit, clicks `Reopen tour`, and `Yes, reopen` in the
  `Reopen tour` dialog - the exact path a refusal would surface on.
- `dashboard/src/routes/tours/TourDetail.tsx:613-618` `confirmReopen` lets the
  `reopenTour` rejection propagate to the dialog, so `failureCopy`
  (`TourModals.tsx:44-46`, changed by Task 3.13) renders it inline.
- Task 5.5 Step 3's new comment (plan ~13310-13318) commits the sentence
  "the tour page reaches these refusals only through the Reopen and Reschedule
  dialogs, whose own copy answers every 409 (TourModals.tsx failureCopy)" -
  false after Task 3.13, so the branch ships a comment contradicting the code.

What it implies. The one end-to-end wiring of a tour refusal to its sentence
(TourDetail confirmReopen -> modal failureCopy -> contactTypeErrorMessage) is
proven only by mocked unit tests (Task 3.13 renders the modal with a rejecting
`onConfirm`; nothing proves TourDetail passes the rejection through). A
regression where TourDetail catches the error itself would pass every gate.
The fix is cheap and local: in Task 5.5, drive the Reopen dialog in the UI for
the closed tour (after the re-type) and assert the dialog's `role="alert"`
reads "Tours and placements are for tenants, and this contact is a landlord.",
keeping the API asserts; and correct the comment. Either do that or put the
downgrade in front of Cameron with a CURRENT reason.

## F2 - MEDIUM - Plan section 1 ruling P-1 (pinned in Tasks 3.11-3.17, 5.5, 5.6, 5.8): the `contact_not_tenant` sentence is not the approved spec's sentence

What is wrong. Spec section 4 "Dashboard copy for section 4" fixes the copy:
`contact_not_tenant`: "Tours and placements are for tenants. This contact is a
<kind label>." with kind labels "Caseworker, Landlord, Partner, Team member,
Unknown". Plan section 1 (lines 84, 91-94) replaces it with "Tours and
placements are for tenants, and this contact is <phrase>." (phrases "a
landlord", "not classified yet", fallback "not a tenant"). The spec header says
every product decision was ruled by Cameron; staff copy is a product decision.
The plan records the change as a planner ruling ("meaning unchanged"), not as
an open question for Cameron.

Evidence. Spec lines 335-337 vs plan section 1 lines 84 and 91-94; the new
string is then pinned verbatim in `contactTypeErrors.test.ts` (Task 3.11, plan
~7796-7811), every copy-site test (3.12-3.17, 4.9, 4.12), the e2e
(Task 5.5 `NOT_A_TENANT_LANDLORD`), `e2e/support/selectors.md` (Task 5.6) and
the resolved issue text (Task 5.8, plan ~13664-13666).

What it implies. A literal build ships copy the spec gate did not approve, and
reverting it later touches about ten files. The deviation may well be better
English ("This contact is a Unknown" is awkward), but it belongs in the
handback as a question, or the spec wording (with a sensible label for
`unknown`) should be used.

## F3 - LOW - Task 3.2: the W3 sweep's completeness claim is false

What is wrong. Task 3.2 (plan ~5868-5869) states "No other app test posts
`/api/tours`, `/api/placements`, `/from-tour`, `/reopen` or `/transition`."
`app/test/contactVoucherSync.test.ts:82` posts `/api/placements` and is not in
the swept or checked lists.

Evidence. `contactVoucherSync.test.ts:73-82` (tenant `tn-3` is created
`type: 'tenant'`, so it is clean today).

What it implies. Harmless now, but the sweep is presented as an exhaustive
grep and is not; a builder relying on it to scope a re-run would miss this
file. Add it to the "Checked, already typed tenant" list.

## F4 - LOW - Task 5.2: the e2e W3 sweep does not cover S1's new refusal (tenant-only accept on a non-tenant)

What is wrong. Task 5.2's goal is "Confirm no existing e2e spec or fixture now
trips an S2-S4 refusal"; its surface table (plan ~12712-12721) omits S1's 409
`suggestion_contact_not_tenant`, which can also break an existing e2e accept.

Evidence. e2e accepts: `tests/dashboard-next/ai-run-log.spec.ts:439` (pets, on
`createTenant`), `tests/dashboard-next/org-lists.spec.ts:957,989` (on
`createTenant`), `tests/flows/conversation-fact-extraction.spec.ts:152,217,281`
(voucher size / address / status chips; extraction proposes tenant facts only
for tenants, `app/src/services/extraction/apply.ts:137-142,535`). All are on
tenants - clean.

What it implies. No failure today; the sweep's stated scope is incomplete.
Add one row ("suggestion accept: all on tenants, clean").

## F5 - LOW - Plan section 2 binding vs S2 Task 2.6: `TypeChangeRefusalList` location

What is wrong. Plan section 2 (lines 164-170, ruling S2-1) says
`dashboard/src/lib/holdingRefusals.ts` exports "one shared
`TypeChangeRefusalList` component". S2 creates it as
`dashboard/src/routes/contact/TypeChangeRefusalList.tsx` (CONTRACT ISSUE 1,
plan ~3180-3182; Task 2.6 files, ~4698-4700), and a `.ts` module cannot hold
JSX anyway.

What it implies. No consumer outside S2, so nothing breaks; the binding
section is simply wrong and a later reader coding against section 2 would
import a name that does not exist. Fix the binding text.

## F6 - LOW - Task 4.13 / S4 CONTRACT ISSUE 10: the dashboard type still says every property has a landlord

What is wrong. The branch makes a live ownerless property a routine outcome
(Restore without a landlord), but `dashboard/src/api/types.ts:2435` keeps
`UnitItem.landlordId: string` (required). Task 4.13 patches the one crashing
read with `?? ''` on a non-nullable value.

Evidence. Every other current read is already guarded (checked:
`PlacementDetail.tsx:187,227`, `TourDetail.tsx:201`, `useTour.ts:96`,
`useListing.ts:122`, `buildListingFile.ts:64-65,97-98`), so nothing else
crashes today.

What it implies. TypeScript cannot flag the next unguarded
`unit.landlordId.<method>` - the exact shape of the bug Task 4.13 fixes. Out
of scope to fix broadly; worth one line in the slice report or a filed issue.

---

## What was checked and held (so the next reviewer need not redo it)

- Anchors (old_string / Before) verified verbatim and unique in the tree:
  `suggestionResolution.ts` (contact read :778-779, guard lines, the 7
  `return { stateChanged, refusedByHumanEdit };`, :841 throw);
  `suggestionResolutionRepo.ts` (:798, :827, :831 - the only `plan.guard`
  sites; union :159-164); `suggestionResolutionFake.ts` (:173, :189-190, :334);
  `suggestions.ts` emit block; `contacts.ts` caseworker 409 block
  (:1632-1636) and `newType` (:1544); `caseworkerConversion.ts` imports
  :17/:39, set :119-120, `collectRefusals` :217-266, deps :177-187;
  `tours.ts` :140, :348, :1382-1383, :1663; `placements.ts` :67, :576-579,
  :666-669; `routes/statusTransition.ts` :44, :330; `services/statusTransition.ts`
  :47, :397-398, :337-339; `units.ts` :79, :483-489, :1433-1439, :1088,
  :1097-1102, :1517-1532; harness fake `makeCover` end, imports :115-125;
  `ListingDetail.tsx` :47, :55, :69, :180-182, :204, :290, :346-355, :367,
  :402, :1345-1351; `UnitCreateForm.tsx` :25, :251-256; `TourModals.tsx`
  :41-46; `TourDetail.tsx` :58, :382, :514, :589; `ContactEditForm.tsx`
  :517-522, KindPicker block; `UnknownFile.tsx` :26-27, :57, :78-79, :143;
  `ContactDetail.tsx` :61, :73, :670-676, :720-725, :1172; RUNBOOK :473 paragraph;
  the three issue files' status/refs/last lines; `selectors.md` :133/:135.
- Cross-slice names: `contactKind` (S2) used by S3; `OPEN_TOUR_STATUSES`
  exported by S2 and imported by Task 3.4; `requireLandlordContact` /
  `sendContactTypeError` (3.1) used by S4; `contactTypeErrorMessage` (3.11)
  used by 4.9-4.12; e2e copy strings match S2/S3/S4 constants; restore dialog
  name "Restore property" consistent across 4.10/4.11 and the S5 selectors.
- Mutation surfaces swept independently: tour/placement writers
  (`tours.create`, `reopenIf`, `tours.patch`, `placements.create`,
  `transitionPlacement` - single caller `routes/statusTransition.ts:199`;
  placement PATCH refuses `stage`, `placements.ts:283`); landlordId writers
  (unit create/PATCH/roster claim/restore; `unitFields.ts` rejects
  `landlordId: null`); type writers (contacts PATCH, conversion, importer;
  public/unmatched-email/webhooks only create or stamp consent); seat writers
  (`addContact` only; `contacts` not writable on units). Dev seams create
  none of these.
- FakeWorld semantics the tests rely on: fake `toursRepo.create` honors
  `status`; fake `contactsRepo.update` bumps `classification_revision`;
  `listByLandlord` / `list` cursor contracts match the Task 2.2 cursor
  assertions; harness passes the world repos to the contacts, units, tours and
  placements routers.
- UNVERIFIED: the planner's in-memory seed dry run (zero violations in every
  world) - not executed here; and that all 113 `toursApi.test.ts` cases pass
  against a phone-less fixture tenant (sampled tests seed before they post;
  Task 3.2 Step 4 has a STOP rule for the rest).
