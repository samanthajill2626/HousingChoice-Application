# Plan review R1 - planner adjudications

Plan: `docs/superpowers/plans/2026-10-12-caseworker-integrity.md` v1
(771edb52). Reviewers: A (`R1-reviewer-a.md`, 9 findings) and B
(`R1-reviewer-b.md`, 6 findings), both opus, plan + spec + repo only.
Neither found anything BLOCKING or HIGH; both verified every reachable edit
anchor verbatim in the tree and the cross-slice names.

Totals: 15 findings, 11 distinct. ACCEPT 10, DEFER 1 (filed), REJECT 0.

Terminal round: no accepted finding changes what gets built at the decision
level - they restore a spec-required e2e proof, revert copy to the approved
spec wording, tighten gates and tests, and fix binding text. Cameron asked
for one plan round; none follows.

| # | Finding (reviewer) | Ruling | Change in plan v2 |
|---|---|---|---|
| 1 | Task 5.5 / ruling S5-1: spec 8's "a refused tour action shows its sentence" is not proven in e2e; its stated reason is false once Task 3.13 lands; the Reopen dialog is reachable (`tour-auto-close.spec.ts:286-312` drives it) (A1, B1 MED) | ACCEPT | Task 5.5 adds an e2e case: a closed tour whose tenant was re-typed through the API while the tour was closed -> Reopen dialog -> the `contact_not_tenant` sentence is shown and the tour stays closed; the wrong comment is removed; ruling S5-1 amended in the assembly rulings record. |
| 2 | Ruling P-1 rewords the approved `contact_not_tenant` sentence without sign-off (A2 LOW, B2 MED) | ACCEPT | Revert to the spec's two-sentence form: "Tours and placements are for tenants. This contact is <phrase>." with the phrase table (a tenant / a landlord / a partner / a caseworker / a team member / not classified yet; fallback "not a tenant"). Only the article/casing handling remains, so `unknown` reads naturally. Every pinned occurrence updated. |
| 3 | S1, S3, S4 slice gates run no eslint; S3 edits `TourDetail.tsx` and `ScheduleTourForm.tsx`, which carry pre-existing `react-hooks/*` errors (`TourDetail.tsx:341`, `ScheduleTourForm.tsx:241`) (A3 LOW) | ACCEPT | Every slice gate adds `npx eslint <the slice's touched .ts/.tsx files>` with a merge-base baseline comparison; those two pre-existing errors are named as baseline (not fixed). |
| 4 | Binding says `TypeChangeRefusalList` is exported from `holdingRefusals.ts`; S2 builds it in `routes/contact/TypeChangeRefusalList.tsx` (a .ts module cannot hold JSX) (A4, B5 LOW) | ACCEPT | Binding text and ruling S2-1 corrected. |
| 5 | Task 4.11: a restore conflict calls only `setUnit`, leaving the Contacts card stale (pattern at `ListingDetail.tsx:415`) (A5 LOW) | ACCEPT | `onConflict` follows the `applyRosterUnit` pattern. |
| 6 | Task 4.10 duplicates the `ROSTER_RETRY_COPY` literal (A6 LOW) | ACCEPT | Import/use the existing constant. |
| 7 | `primary_contact` is writable on unit create/PATCH (`unitFields.ts:104`) with any contactId and no check; nothing routes on it today (A7 LOW) | DEFER | Filed in S5 as `unit-primary-contact-unchecked` (low). Not a spec surface (I4 is about contact-list seats); no reader routes on it yet. |
| 8 | Spec 8 asks for D1 tests on real and fake; the phone, generic re-type and status-across-conversion cases run on the fake only (A8 LOW) | ACCEPT | The real-repo (DynamoDB Local) suite adds the generic tenant -> landlord re-type spanning a `voucherSize` accept and the status accept spanning a conversion; the phone case stays fake-only (phone is neutral and uses `commitPhoneEffect`, untouched). |
| 9 | Task 3.2's sweep claims no other app test posts the placement routes; `contactVoucherSync.test.ts:82` does (typed tenant, passes) (A9, B3 LOW) | ACCEPT | Record corrected. |
| 10 | Task 5.2's e2e sweep scope omits S1's new accept refusal (all e2e accepts target tenants - verified) (B4 LOW) | ACCEPT | Scope statement corrected. |
| 11 | Dashboard `UnitItem.landlordId` stays a required `string` (`types.ts:2435`) while ownerless properties become routine; a one-site `?? ''` fix leaves the next read unguarded (B6 LOW) | ACCEPT | Task 4.13 makes `landlordId` optional in the dashboard type and fixes every compile error typecheck then reports; if more than five sites break, the builder stops and records them. |
