# Approval & Move-in Sequence — Design

**Date:** 2026-07-03
**Status:** Design approved (brainstorming); ready for implementation planning.
**Source of truth:** `documentation/approval-and-move-in-sequence.mermaid` +
`documentation/approval-and-move-in-sequence-writeup.md`.
**Method:** `documentation/sequence-diagram-to-test.md` (the 6th sequence to follow it).

## Goal

Model and verify the **final placements sequence** — from the housing authority
receiving the RTA (placement at `awaiting_authority_approval`) through the ~4-week
authority window to the tenant moving in (`moved_in`). Deliver the sequence diagram
+ writeup as source of truth, build the gaps the conformance audit surfaces, and
ship an e2e scenario suite that walks every stamped placement stage without skipping.

## Context / what already exists

This sequence is unusual: **the entire downstream stage ladder already exists** in
`app/src/lib/statusModel.ts`, and the backend transition service
(`app/src/services/statusTransition.ts`) already records two of the domain data
points. So this is more *wiring + data capture + UI + tests* than new spine.

Already wired:
- Stage ladder `awaiting_authority_approval → schedule_inspection → awaiting_inspection
  → determine_rent → awaiting_rent_acceptance → awaiting_hap_contract →
  complete_paperwork → awaiting_move_in → moved_in` (`PLACEMENT_STAGES`), with phases,
  labels, derivation, and tuned `STAGE_STUCK_THRESHOLDS` for every stage.
- `inspection_outcome` (pass/fail) written by the transition service on the move OUT
  of `awaiting_inspection`.
- `final_rent` written onto the **unit** when `awaiting_rent_acceptance` clears (the
  landlord accepts).
- Derivations: `awaiting_move_in` ⇒ property `Finalizing`; `moved_in` ⇒ tenant
  `Placed` + property `Occupied`; `lost` ⇒ bounce-back (tenant `Searching`, property
  `Available`) when no other active placement exists.
- Placement already carries `lease_date`, `move_in_date`, a loose `rta` bag
  ("inspection, rent_determined + tenant_portion, LIF, denial"), and `inspection_outcome`.
- The tenant contact already carries `lifEligible: boolean`.
- The generic stuck-nudge is armed on every stage move (Post-Tour build); no bespoke
  rungs needed here.

## Decisions (from brainstorming, 2026-07-03)

1. **Endpoint:** ends at `moved_in`. There is a **single** inspection (the HQS
   inspection during the window) — no separate move-in "final inspection".
2. **Invoicing (Track 7) deferred** to its own later sequence; the diagram notes the
   handoff at move-in. Do not build the invoices repo/route now.
3. **Channel:** the masked relay group carries over and remains the channel. The real
   unmasked Tenant+Landlord group text (Track 6 Phase 1) stays deferred.
4. **Housing Authority** is a diagram actor but **off the relay** — out-of-band with
   Team/landlord; Team records its milestones.
5. **Inspection is scheduled by the LANDLORD**, not the Team. Team records the date.
6. **`complete_paperwork` = a tracked 3-item checklist:** `lease_signed` (required),
   `move_in_details` (required), `lif` (conditional + optional). LIF surfaces only
   when the tenant's `lifEligible` is true, and never blocks. Advance to
   `awaiting_move_in` is a **deliberate Team confirmation** surfaced by the app once
   the required items are recorded (a "Ready for move-in?" prompt that flags
   unconfirmed LIF for a LIF-eligible tenant) — **NOT** an all-checked auto-advance.
7. **Automation:** reuse the generic per-stage stuck-nudge only; no new rungs.
8. **Marked deviations** (each = one exit-asserting e2e test): inspection **fails**;
   landlord **rejects** the determined rent; global **backout** (Lost from any stage).
   Voucher-expiry is **not** marked this round.

## Architecture

The spine is the placement stage ladder; every transition is a `[MANUAL]` stage move
(Team recording a real-world event) except where the diagram tags `[AUTO]`. The masked
relay carries tenant/landlord coordination; the authority is recorded out-of-band.
Modeled as a clean linear ladder (the model is explicitly not a strict state machine);
real-world overlap is prose, not diagram branches.

Stage walk (see the writeup §"The flow, stage by stage" for detail):
`awaiting_authority_approval` →(authority approves)→ `schedule_inspection`
→(landlord schedules, Team records date)→ `awaiting_inspection`
→(pass recorded)→ `determine_rent` →(authority sets amount, Team records)→
`awaiting_rent_acceptance` →(landlord accepts → `final_rent`)→ `awaiting_hap_contract`
→(HAP executed; property `Finalizing`)→ `complete_paperwork`
→(required items + Team confirmation)→ `awaiting_move_in`
→(tenant moves in; tenant `Placed`, property `Occupied`)→ `moved_in` ✓.

## Gaps to build (the conformance audit refines these)

1. **Inspection date capture** at `schedule_inspection`. Decide first-class field
   (`inspection_date`) vs the existing `rta` bag; wire the transition/route + a
   PlacementDetail control.
2. **Determined-rent amount capture** at `determine_rent`, distinct from `final_rent`
   (which is the accepted amount on the unit). The landlord needs a recorded amount to
   accept. Decide where it lives (a placement field, e.g. `rent_determined`/the `rta`
   bag) and surface it.
3. **Paperwork checklist** — `lease_signed` / `lif` / `move_in_details` completion
   flags on the placement (distinct from the existing `lease_date`/`move_in_date`
   *date* fields), LIF gated on tenant `lifEligible`, plus the **Ready-for-move-in
   confirmation** gate for `complete_paperwork → awaiting_move_in`.
4. **Dashboard walk** — PlacementDetail must let Team move through every downstream
   stage and record the above; the audit confirms how much of the existing stage
   control already covers these stages, and what UI (date input, rent input, checklist,
   confirmation prompt, "Mark moved in") must be added.
5. **"Mark moved in" terminal affordance** firing the derivations.

Follow the method's rule: when the audit shows a substantial data-model choice
(fields 1–3), **stop after the audit and get a human decision** before building —
file each gap in `docs/issues/` and confirm the shape.

## Testing (e2e conformance)

Per `documentation/sequence-diagram-to-test.md`: one `test()` per diagram leaf; Team
drives the real dashboard (seeded VA dev-login, role "Team" never a founder name);
tenant/landlord inbound via the fake-twilio seam; assert what Team **sees** (rendered)
on top of API read-backs, scoped to the card/section; accessibility-first selectors;
self-clean isolation (fresh timestamped entities, no per-test `/__dev/reseed`).

Required tests:
- **Happy path:** convert-in at `awaiting_authority_approval` (reuse the Post-Tour
  conversion helper to reach it), then walk **every** stage in order to `moved_in`,
  asserting each stamped transition, the recorded data (inspection date, `pass`,
  determined rent, `final_rent`, checklist), the `Finalizing`→`Occupied` derivations,
  and the LIF-conditional + confirmation behavior. Use `test.slow()`.
- **Marked deviation — inspection fails:** record `fail`; assert the exit (re-inspect
  path back to `schedule_inspection`, or Lost with `landlord_lost_inspection`).
- **Marked deviation — landlord rejects rent:** at `awaiting_rent_acceptance` → Lost
  with `landlord_lost_rent`; assert `final_rent` is NOT written.
- **Marked deviation — backout:** Lost from a mid-window stage → tenant `Searching`,
  property `Available`, relay closed.
- **LIF branches:** a LIF-eligible tenant surfaces the LIF flag and the confirmation
  notes it; a non-eligible tenant advances with LIF not applicable.

## Out of scope (documented)

Invoicing (Track 7, own later sequence); real unmasked group text (Track 6 Phase 1,
deferred); voucher-expiry deviation; weekly/accountability recurring nudges; LIF
eligibility legwork orchestration (denial letters). See the writeup's "Out of scope"
section.

## Files

- `documentation/approval-and-move-in-sequence.mermaid` (new — source of truth)
- `documentation/approval-and-move-in-sequence-writeup.md` (new — companion)
- `e2e/tests/scenarios/approval-and-move-in.spec.ts` (new — the suite)
- `e2e/scenarios/steps.ts` (extend — new verbs)
- `app/src/…` — the gap builds (fields, transition wiring, routes) per the audit
- `dashboard/src/…` — PlacementDetail controls (date, rent, checklist, confirmation,
  "Mark moved in")
- `docs/issues/…` — one file per data-model gap surfaced by the audit
