# Approval & Move-in Sequence — Overview (Phase 1)

Companion notes for `approval-and-move-in-sequence.mermaid`. This is the **second
half** of a placement's open lifetime and the **final placements sequence**: from
the landlord submitting the RTA to the housing authority, through the ~4-week
authority window, to the tenant moving in. It picks up exactly where the
**Post-Tour & Application** sequence handed off.

**Where the split came from (founder-approved 2026-07-02):** RTA submission is the
moment the deal leaves our actors' hands and enters housing-authority land. The
cast changes (the authority walks on stage), the cadence changes (a 48-hour
paperwork sprint becomes a ~4-week shepherding marathon), and the built placement
ladder breaks naturally there (`Awaiting landlord submission` →
`Awaiting authority approval`). Post-Tour & Application owns everything up to and
including RTA submission; this sequence owns everything after.

**Scoping rule used here (founder, 2026-07-03):** the happy path is required, and
deviations that pull off it are *marked* — shown with their exit, not elaborated.
Two deviations are marked here (the inspection fails, the landlord rejects the
determined rent) plus the global "either party backs out entirely." Everything
else is deferred (see "Out of scope" below).

## How to read the diagram

Same participants and rules as the other sequences: Tenant / Housing Choice App /
Team / Landlord-PM; the app owns the phone number and every message relays through
it; `[AUTO]` is app automation, `[MANUAL]` is the team acting by hand.

Two rules specific to this sequence:

- **The masked relay group carries over and remains the channel throughout.** No
  new group text is formed and nothing is unmasked. (The source docs' Track 6
  Phase 1 "create a real Tenant+Landlord group text once the RTA is submitted" —
  the *visible-numbers* group — stays **deferred**; the masked relay continues,
  per founder 2026-07-02, exactly as Post-Tour decided.)
- **The Housing Authority is a new actor, but it is OFF the relay.** It deals with
  Team and the landlord out-of-band (approval notice, inspection result, rent
  determination, HAP contract). Team **records** each authority milestone as it
  lands; the app relays only the tenant/landlord coordination.

## Where this sits

- **Upstream:** the **Post-Tour & Application** sequence ends at
  `Awaiting authority approval` — the landlord has submitted the RTA. That is this
  sequence's entry.
- **The spine:** the placement and its stage ladder (`statusModel.ts`,
  `documentation/STATUS-MODEL.md`). Stages name the *next outstanding action*.
  This sequence walks the **Inspection**, **Rent Determination**, **Contract**,
  **Administrative**, and **Closure** phases:
  `Awaiting authority approval` → `Schedule inspection` → `Awaiting inspection` →
  `Determine rent` → `Awaiting rent acceptance` → `Awaiting HAP contract` →
  `Complete paperwork` → `Awaiting move-in` → **`Moved in`** ✓.
- **Every stage transition is stamped in the diagram, in ladder order.** This is a
  test requirement (founder, 2026-07-03): the e2e suite must move the placement
  into and out of **each** stage, skipping none.
- **Downstream:** none — `Moved in` is the finishline of the whole placement
  lifecycle. The only handoff is **Invoicing** (Track 7), noted and deferred.

## The flow, stage by stage

The whole span is one clean linear ladder in the diagram. In reality the window's
activities overlap and loop (inspection scheduling, rent determination, and the
paperwork legwork run somewhat in parallel); the model is deliberately **not** a
strict state machine, so we model the uniform happy-path shape and describe the
messiness in prose (same call every prior sequence made).

### 1. Authority approval — the window opens

The authority approves the submitted RTA. Team records it →
`Awaiting authority approval → Schedule inspection`. The roughly 4-week authority
window is now open.

### 2. Inspection — the landlord schedules it, Team records date + outcome

The HQS inspection is the **landlord's** responsibility — the commitment they made
at onboarding ("pass the inspection on the first try"). The **landlord** schedules
it; Team records the **inspection date** → `Schedule inspection → Awaiting
inspection`. When the inspection passes, Team records the outcome `pass` →
`Awaiting inspection → Determine rent`.

**Marked deviation — inspection fails:** the outcome `fail` is recorded; the
landlord re-inspects (back to `Schedule inspection`) or the placement is **LOST**
with reason `landlord_lost_inspection`. Full re-inspection handling is a future
sequence if needed.

### 3. Rent determination — the authority sets it, the landlord accepts it

The authority determines the contract rent (and the tenant portion). Team receives
the notice and records the **determined amount** → `Determine rent → Awaiting rent
acceptance` (source docs Track 6 Phase 6). The **landlord accepts** the determined
rent; Team records the acceptance, and the accepted amount is written onto the
property as **`final_rent`** → `Awaiting rent acceptance → Awaiting HAP contract`.

**Marked deviation — landlord rejects the rent:** the landlord will not accept the
determined rent, so the deal cannot proceed. Placement **LOST** with reason
`landlord_lost_rent`. Full renegotiation handling is a future sequence if needed.

### 4. Contract — the HAP contract

The **HAP contract** is executed between the **authority and the landlord** (its
own single stage, no substeps). Team records it → `Awaiting HAP contract →
Complete paperwork`. **The property flips to `Finalizing` here.**

### 5. Complete paperwork — an unordered, partly-conditional checklist

One stage holding an **unordered checklist**:

- **Lease signed** — required.
- **Move-in details shared** — required.
- **LIF** — relevant **only when the tenant is LIF-eligible** (the tenant contact's
  `lifEligible` flag). When eligible, the app surfaces a flag for Team to confirm
  whether LIF is included; **it is optional even then** and never blocks moving
  forward. When the tenant is not LIF-eligible, LIF is not applicable.

Because LIF is conditional and optional, "all boxes checked" is **not** the advance
rule. Instead, once the two required items are recorded, the app surfaces a
**Ready-for-move-in confirmation** (noting unconfirmed LIF for a LIF-eligible
tenant so proceeding is a conscious choice). Advancing is a **deliberate Team
confirmation** → `Complete paperwork → Awaiting move-in`.

### 6. Move-in — the finishline

The tenant takes up residence. Team records move-in → `Awaiting move-in →
**Moved in**` ✓. The tenant reads **`Placed`** and the property reads **`Occupied`**
(derivation). The masked relay goes quiet; the placement is terminal.

### Marked deviation — a party backs out (any stage)

`Lost` is reachable from any stage. Tenant returns to `Searching` (re-match),
property returns to `Available`, the relay thread closes. Shown once, globally,
rather than per-stage.

## `[AUTO]` automation in this span

Only one automation runs here: the **generic "stuck too long" nudge** already armed
on every stage move. Each stage carries a tuned threshold (`STAGE_STUCK_THRESHOLDS`
— e.g. `Awaiting inspection` 10 days, `Awaiting HAP contract` 14 days); a stage that
sits past its threshold surfaces on the Today board for Team to chase. No bespoke
window rungs (weekly landlord-accountability chases, tenant LIF/denial-letter
reminders) are built — the window is largely a wait on the external authority,
which no nudge can speed up (founder, 2026-07-03).

## Known gaps this diagram intentionally surfaces

For the e2e conformance audit (per `documentation/sequence-diagram-to-test.md`).
Note that the **backend transition service already records the inspection pass/fail
outcome and writes `final_rent` on rent acceptance**, and the whole downstream
stage ladder already exists in the model — so this sequence is more *wiring +
data-capture + UI* than new spine.

1. **Inspection date capture** at `Schedule inspection` — only the pass/fail
   `inspection_outcome` exists today; the scheduled date needs a home (a first-class
   field or the existing loose `rta` bag — the audit decides).
2. **Determined-rent amount capture** at `Determine rent` — distinct from the
   accepted `final_rent` written on acceptance. The landlord needs a recorded amount
   to accept; where it lives is a data-model decision for the audit.
3. **The paperwork checklist** — `lease_signed` / `lif` / `move_in_details`
   completion flags, with LIF gated on the tenant's `lifEligible`, plus the
   **Ready-for-move-in confirmation** gate (NOT an all-checked auto-advance).
4. **Dashboard walk** — PlacementDetail must let Team move through every downstream
   stage and record this data; the audit confirms how much of the stage control
   already covers these stages.
5. **A "Mark moved in" terminal affordance** firing the derivations (tenant
   `Placed`, property `Occupied`).

## Out of scope, but documented

- **Invoicing** (Track 7) — the landlord invoice for the determined rent, generated
  at move-in. Its own small sequence later; the diagram notes the handoff.
- **Real unmasked group text** (source docs Track 6 Phase 1) — deferred; the masked
  relay continues as the channel.
- **Voucher-expiry deviation** — a voucher lapsing mid-window is a real risk but is
  **not** marked here (founder, 2026-07-03); it is not modeled this round.
- **Weekly recurring check-ins / landlord-accountability nudges** (source docs
  Track 6 phases 3–5) — not built; the generic stuck-nudge is the only automation.
- **LIF eligibility legwork** (tenant emails to confirm eligibility, obtaining
  denial letters — source docs Track 6 Phase 3) — modeled as background during the
  window, surfaced only as the conditional LIF checklist item at `Complete
  paperwork`; the app does not orchestrate the denial-letter retrieval.
