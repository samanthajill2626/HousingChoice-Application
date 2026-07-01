# Landlord & Unit Onboarding — e2e suite + backing build (Plan)

> **For agentic workers:** implement task-by-task with TDD (backend first). Steps use `- [ ]`.

**Goal:** Encode `documentation/landlord-onboarding-sequence.mermaid` as a Playwright scenario
suite, building the minimum backing schema the diagram needs (per the 2026-06-30 human data-model
decisions).

**Architecture:** Extend the contact model with a landlord lead lifecycle + structured deal
terms; add one unit field; surface them in the dashboard; then write the scenario suite reusing
`e2e/scenarios/steps.ts`. Unit creation is API setup (no new UI).

**Tech stack:** Express/DynamoDB (app), React/Vite (dashboard), Vitest, Playwright.

## Global Constraints
- Phase-1 altitude: NO AI extraction, NO automated matching, NO app-placed cold call (model as
  contact creation), email/DocuSign external (assert only the recorded `contract_status`).
- "Team", never the founder's name. Self-clean isolation (fresh timestamped names/numbers; no
  per-test `/__dev/reseed`). Mostly-UI for the Team's in-flow actions; API for the landlord's
  inbound + pure setup. Assert what Team SEES, scoped to a card/section. Accessibility-first
  selectors, audited live.

## Decided data model (human, 2026-06-30)
- **Landlord statuses** (type=landlord): `needs_review | interested | active | parked`.
  `park_reason: string` set on the move to `parked`. Fix the `/tenant-status` type-guard so a
  landlord validates against the landlord allowlist (not the tenant one).
- **Structured landlord fields:** `contract_status: 'unsigned'|'signed'` (default `unsigned`);
  `expected_rent: number`; `registered_landlord: boolean`; `rta_within_48h: boolean`;
  `pass_inspection_first_try: boolean`; `income_includes_voucher: boolean`.
- **Free-form** (existing `notes`/`customFields`): utilities, hold fee/deposit/LIF, tour
  logistics, comms prefs, evictions/utility-debt/credit/references narrative.
- **Unit:** `voucher_size_accepted: number` (distinct from `beds`). Zillow link reuses the
  existing writable `listing_link`.

---

## Task 1 — Backend: landlord status lifecycle + park_reason
**Files:** `app/src/lib/statusModel.ts` (add `LANDLORD_STATUSES`), `app/src/routes/contacts.ts`
(type-scoped allowlist → landlord set), `app/src/routes/statusTransition.ts` (accept landlord
statuses on the contact-status route + persist `park_reason`), tests alongside.
- [ ] RED: test that `PATCH /api/contacts/:id/tenant-status` on a landlord accepts `interested`
  and `parked` (with `reason` persisted as `park_reason`) and REJECTS tenant-only `on_hold`/
  `inactive` and unknown values.
- [ ] GREEN: add `LANDLORD_STATUSES=['needs_review','interested','active','parked']`; a landlord
  status guard; persist `park_reason` when target is `parked`; apply the landlord allowlist on
  both the generic PATCH status branch and the `/tenant-status` route.
- [ ] Verify + commit.

## Task 2 — Backend: structured landlord fields
**Files:** `app/src/routes/contacts.ts` (PATCH validation allowlist + create), `app/src/lib/
contactProfile.ts` (parsers), `app/src/repos/contactsRepo.ts` (ContactItem), `dashboard/src/api/
types.ts` (Contact), tests.
- [ ] RED: `PATCH /api/contacts/:id` accepts `contract_status`, `expected_rent`,
  `registered_landlord`, `rta_within_48h`, `pass_inspection_first_try`, `income_includes_voucher`
  with type validation (enum/number/bool), and GET returns them.
- [ ] GREEN: add validation + persistence + types. Default `contract_status='unsigned'` on a
  landlord create is NOT required (unset is fine); only validate when supplied.
- [ ] Verify + commit.

## Task 3 — Backend: unit `voucher_size_accepted`
**Files:** `app/src/routes/units.ts` (writable allowlist), `app/src/lib/unitFields.ts`,
`app/src/repos/unitsRepo.ts`, `dashboard/src/api/types.ts`, tests.
- [ ] RED: `PATCH /api/units/:id { voucher_size_accepted: 2 }` persists; GET returns it; a
  non-number is rejected.
- [ ] GREEN: add the writable field + validation + type.
- [ ] Verify + commit.

## Task 4 — Dashboard: landlord onboarding card + edit-form inputs
**Files:** `dashboard/src/routes/contact/ContactEditForm.tsx` (landlord-conditional section:
lead status, contract status, the 5 structured terms, park reason), a new
`LandlordOnboardingCard.tsx` rendered in `LandlordFile.tsx`, component tests.
- [ ] RED: component tests — the card renders set values (scoped heading "Landlord onboarding");
  the edit form shows the landlord inputs and PATCHes them.
- [ ] GREEN: build the card + inputs (labels: "Contract status", "Expected rent", "Registered
  landlord", "Submits RTA within 48h", "Passes inspection first try", "Voucher counts as income").
- [ ] Verify (dashboard tests green) + commit.

## Task 5 — Dashboard: unit `voucher_size_accepted` input + display
**Files:** `dashboard/src/routes/listing/ListingEditForm.tsx` (add input "Voucher size accepted"),
property-detail display, component tests.
- [ ] RED → GREEN → verify + commit.

## Task 6 — e2e verbs (steps.ts)
**Files:** `e2e/scenarios/steps.ts`.
- [ ] Add: `teamCreatesLandlord`, `teamMarksLeadInterested`, `expectLeadInterested`,
  `teamRecordsContractSigned`, `teamRecordsLandlordOnboarding`, `teamRecordsApprovalCriteria`,
  `landlordTextsProperty`, `teamCreatesUnitFromIntake` (API setup), `expectUnitAvailableWithListingLink`,
  `expectLeadParked`, `expectHandoffToMatching`, plus reuse of the inbound/unknown-capture/triage
  verbs (triage to LANDLORD). Audit each selector live.

## Task 7 — e2e spec
**Files:** `e2e/tests/scenarios/landlord-onboarding.spec.ts` — one test() per leaf: cold-call→
interested→signed→onboarded→unit-available→handoff; inbound-text→worth-pursuing→…→handoff;
cold-call→declines→parked; inbound-text→not-a-fit→parked; contract→never-signed→parked; +
property-intake missing-field follow-up iteration. Shared setup helper.
- [ ] Inner-loop green via `--grep`; then full `npm run e2e` green 2x.

## Task 8 — Close out
- [ ] Update the playbook with landlord-onboarding lessons + the mermaid `;`-in-Note gotcha.
- [ ] Update the 4 gap issues' status (resolved/partial) to reflect what was built vs deferred.
- [ ] Code review; verification-before-completion (green output); finishing-a-development-branch.
