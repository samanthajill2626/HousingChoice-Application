---
id: placements-board-new-gate-deadends
title: PlacementsBoard doesn't render/forward the Approval & Move-in move gates (inspectionDate, rentDetermined, moveInReady)
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-03
refs: dashboard/src/routes/placements/PlacementsBoard.tsx:112, dashboard/src/routes/placements/PlacementsBoard.tsx:183, dashboard/src/routes/placements/PlacementsBoard.tsx:237, dashboard/src/routes/placements/transitionGate.ts
---

**Problem.** `gateFor` (shared by both move surfaces) now returns three new gates —
`inspectionDate`, `rentDetermined`, `moveInReady` (Approval & Move-in). `PlacementDetail`
handles all of them, but `PlacementsBoard` handles only the pre-existing `finalRent` /
`inspectionOutcome` subset:

- `PlacementsBoard.tsx:183` — `pendingModal` gates on `finalRent || inspectionOutcome`
  only, so a board move into `awaiting_inspection` / `awaiting_rent_acceptance` /
  `awaiting_move_in` sets `pending` but renders **no modal** (silent dead-end).
- `PlacementsBoard.tsx:237` — `mode={pending.gate === 'finalRent' ? 'finalRent' :
  'inspectionOutcome'}` is a binary ternary that can't express the new modes.
- `PlacementsBoard.tsx:112` — `runTransition` cherry-picks `finalRent` /
  `inspectionOutcome` and would drop `inspectionDate` / `rentDetermined` even if the
  modal opened.

No data corruption — the move just fails to complete from the board. The Approval &
Move-in flow is fully driven from `PlacementDetail` (where the fix landed and the e2e
walks every stage), so this is a consistency/UX gap, not a correctness blocker.

**Suggested fix.** Mirror the PlacementDetail wiring onto the board: extend the
`pendingModal` condition + `mode` selection to the three new gates, and forward
`inspectionDate` / `rentDetermined` in the board's `runTransition`. Decide `moveInReady`'s
`lifPending` sourcing for the board (the board may not load the tenant's `lifEligible`
per card as PlacementDetail does via `getContact`) — omitting `lifPending` yields a plain
confirm, which is acceptable for the quick-move surface. Mind the board's optimistic-move
+ rollback path. Surfaced by the Approval & Move-in build (Task 8). See
[[approval-move-in-audit]].
