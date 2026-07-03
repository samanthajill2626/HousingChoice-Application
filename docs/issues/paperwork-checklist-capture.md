---
id: paperwork-checklist-capture
title: Complete-paperwork checklist (lease_signed / lif / move_in_details) + move-in-ready gate
type: improvement
severity: med
status: open
area: app
created: 2026-07-03
refs: app/src/routes/placements.ts, app/src/repos/contactsRepo.ts:170, dashboard/src/routes/placements/PlacementDetail.tsx
---

**Problem.** The diagram's `Complete paperwork` stage holds an unordered checklist —
`lease_signed` (required), `move_in_details` (required), `lif` (conditional on the
tenant's `lifEligible`, optional even then) — and advances via a **deliberate
"Ready for move-in?" confirmation**, NOT an all-checked auto-advance. Live audit
confirmed **no capture today**: `PATCH /api/placements/:id { lease_signed: true }`
hard-rejects with 400 `unknown or immutable field: lease_signed`. The existing
`lease_date`/`move_in_date` are DATE fields, not the completion flags.

**Suggested fix.** First-class `lease_signed? / lif? / move_in_details?: boolean` on
`PlacementItem`, allowlisted in `validatePlacementUpdate` (PATCH), surfaced as a checklist
card on `PlacementDetail` (LIF row gated on `tenant.lifEligible === true`,
`contactsRepo.ts:170`), with a no-payload `moveInReady` gate modal on the
`complete_paperwork → awaiting_move_in` move that flags unconfirmed LIF for a LIF-eligible
tenant. Built by Approval & Move-in Tasks 2/5/6/7/8. See [[approval-move-in-audit]].
