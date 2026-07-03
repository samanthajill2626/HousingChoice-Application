---
id: move-in-ready-required-items-advisory
title: Move-in-ready confirm advises on unconfirmed LIF but not on unrecorded required items
type: improvement
severity: low
status: open
area: dashboard
created: 2026-07-03
refs: dashboard/src/routes/placements/PlacementDetail.tsx:293, dashboard/src/routes/placements/MovePromptModal.tsx, documentation/approval-and-move-in-sequence-writeup.md:104
---

**Problem.** The `complete_paperwork → awaiting_move_in` "Ready for move-in?" confirm
(`moveInReady` gate) surfaces a "LIF is not marked" advisory when the tenant is
LIF-eligible and `lif` is unconfirmed, but it does NOT note when the two REQUIRED
checklist items (`lease_signed`, `move_in_details`) are unrecorded. In the current build
the required items behave like optional record-keeping — a Team member can advance with
both unchecked and nothing in the confirm flags it.

This matches the writeup/diagram's EXPLICIT wording (the confirm "notes unconfirmed LIF
for a LIF-eligible tenant") and the deliberate "advance never blocks" design, and it
matches exactly what the ratified plan's Task 8 wired (`lifPending` only) — so it is NOT
a build defect against the plan. But the writeup §5 also says the confirm surfaces "once
the two required items are recorded," so there is a spec-intent nuance worth tracking:
the required items get no surfacing at all, while the optional LIF does.

**Suggested fix (non-blocking, if desired).** Have the `moveInReady` modal also note any
unrecorded REQUIRED items (advisory only — still never blocks), symmetric with the LIF
advisory, so advancing with lease/move-in-details unrecorded is a conscious choice.
Surfaced by the Approval & Move-in whole-branch review (2026-07-03). See
[[approval-move-in-audit]].
