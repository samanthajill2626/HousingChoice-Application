---
id: approval-move-in-audit
title: Approval & Move-in — live-stack conformance audit + data-model decision (Task 1 gate)
type: decision
severity: med
status: in-progress
area: app
created: 2026-07-03
refs: app/src/lib/statusModel.ts:48, app/src/services/statusTransition.ts:308, app/src/services/statusTransition.ts:339, app/src/repos/placementsRepo.ts:126, app/src/routes/placements.ts, dashboard/src/routes/placements/transitionGate.ts:17, dashboard/src/routes/placements/MovePromptModal.tsx:15, app/src/repos/contactsRepo.ts:170
---

**Problem.** The method (`documentation/sequence-diagram-to-test.md` §4) mandates a
live-stack conformance audit before building the Approval & Move-in sequence, and —
when the audit surfaces a substantial data-model choice — a **human decision** before
any build. This file records the audit findings (source + a live API stage-walk on the
hermetic lane-1 stack) and the presented data-model decision.

## Audit method

Booted `npm run e2e:session` (lane 1, app `http://127.0.0.1:9101`), dev-logged-in as the
seeded VA, and drove the placement transition API (`POST /api/placements/:id/transition`
with `x-origin-verify` origin secret) across **every** stamped stage of the diagram,
probing what each move can/can't capture. Cross-checked the dashboard surfaces
(`PlacementDetail`, `MovePromptModal`, `transitionGate`) against source.

## Confirmed already wired (no build needed)

Live-confirmed by walking the one seeded placement `placement-0001` from
`awaiting_authority_approval` → `moved_in`:

1. **The full downstream stage ladder drives + persists end-to-end.** Every move —
   `awaiting_authority_approval → schedule_inspection → awaiting_inspection →
   determine_rent → awaiting_rent_acceptance → awaiting_hap_contract →
   complete_paperwork → awaiting_move_in → moved_in` — returned HTTP 200 and persisted
   (`PLACEMENT_STAGES`, `statusModel.ts:48`).
2. **`inspection_outcome` capture works** — `inspectionOutcome:'pass'` on the
   `awaiting_inspection → determine_rent` move persisted `inspection_outcome=pass`
   (`statusTransition.ts:308`).
3. **`final_rent` write works** — `finalRent:1875` on the `awaiting_rent_acceptance →
   awaiting_hap_contract` move wrote `final_rent=1875` onto **unit-0001**
   (`statusTransition.ts:339`).
4. **Terminal derivations fire** — at `moved_in`, unit-0001 read `status=occupied` and
   contact-tenant-0001 read `status=placed`. (Derivation writes `status` directly with a
   `status_source`; there is no separate `derivedStatus` field.)
5. **`PlacementDetail` already drives every stage** — a full "Move to…" picker over
   `PLACEMENT_STAGES` routes through `gateFor` → `runTransition` → the transition route
   (`PlacementDetail.tsx:231`). No new move control is needed; the terminal "Mark moved
   in" is just the picker → `moved_in` (proven live to fire the derivations).
6. **`MovePromptModal` already gates `finalRent` + `inspectionOutcome`**
   (`MovePromptModal.tsx:15`); `gateFor` returns them on the right moves
   (`transitionGate.ts:17`). The new gates mirror this exact precedent.
7. **`lifEligible?: boolean` is a real, optional Contact field** (`contactsRepo.ts:170`,
   dashboard types + `EligibilityIntakeCard`). `PlacementDetail` already loads the tenant
   via `getContact` (`PlacementDetail.tsx:99`), so the LIF checklist item can gate on
   `tenant.lifEligible === true`.

## Gaps confirmed (to build)

Live-probed, definitively missing today:

1. **Inspection date** — sending `inspectionDate:'2026-07-20'` on the
   `schedule_inspection → awaiting_inspection` move was **silently ignored** (200, but
   `inspection_date` stayed undefined). No capture exists. → [[inspection-date-capture]]
2. **Determined rent** — sending `rentDetermined:1850` on the `determine_rent →
   awaiting_rent_acceptance` move was **silently ignored**. Distinct from `final_rent`
   (the accepted amount). → [[determined-rent-capture]]
3. **Paperwork checklist** — `PATCH /api/placements/:id { lease_signed: true, … }`
   **hard-rejected 400 `unknown or immutable field: lease_signed`**. The allowlist must
   be extended. → [[paperwork-checklist-capture]]
4. **Dashboard controls** — no date input, determined-rent input, checklist card, or
   "Ready for move-in?" confirmation gate on `PlacementDetail`.

Two behavioral nuances the walk revealed (shape the build):
- The transition route **silently ignores** unknown inputs (inspectionDate/rentDetermined
  dropped with a 200, no error) — so Tasks 3/4 add both the write AND the validation.
- The PATCH allowlist **hard-rejects** unknown fields (400) — so Task 5's checklist must
  be explicitly allowlisted (confirmed necessary, not merely cosmetic).
- The lean seed's tenant persona has **no `lifEligible` set** — the e2e's LIF-eligible
  branch (Task 10) must set it (PATCH the contact or seed a persona); the field exists,
  it's just unset by default.

## Data-model decision (presented for human ratification)

The one genuine choice: **first-class typed placement fields vs. the existing untyped
`rta?: Record<string, unknown>` bag** (`placementsRepo.ts:126`, whose comment even
anticipates "inspection, rent_determined + tenant_portion, LIF, denial").

**Recommendation — first-class typed fields**, mirroring the `inspection_outcome`
precedent (pass/fail is already first-class; its sibling date should be too):

- `inspection_date?: string` (ISO date) — captured via the transition input + gate modal
  on the `schedule_inspection → awaiting_inspection` move.
- `rent_determined?: number` (finite > 0) — captured via the transition input + gate
  modal on the `determine_rent → awaiting_rent_acceptance` move. Distinct from
  `final_rent` (the accepted amount written to the unit on rent acceptance).
- `lease_signed? / lif? / move_in_details?: boolean` — toggled via the general
  `PATCH /api/placements/:id` allowlist; the `complete_paperwork → awaiting_move_in`
  move is gated by a new no-payload **"Ready for move-in?" confirmation** that flags
  unconfirmed LIF for a LIF-eligible tenant.

**Why first-class over the `rta` bag:** validation at the service + route (the bag is
untyped `Record<string, unknown>`), clean capture into the same `patch` the gate-modal
already writes, typed rendering on `PlacementDetail`, and consistency with the
established `inspection_outcome`/`final_rent` shape. The bag's only edge — no interface
change — is outweighed by the loss of type safety and validation.

**Status:** RATIFIED by Cameron (2026-07-03) — first-class typed fields. Build proceeds
per the plan (Tasks 2–10). On merge, set this to `resolved`.
