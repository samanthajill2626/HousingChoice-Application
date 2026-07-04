---
id: inspection-date-capture
title: Capture the landlord-scheduled HQS inspection date at schedule_inspection
type: improvement
severity: med
status: open
area: app
created: 2026-07-03
refs: app/src/repos/placementsRepo.ts:126, app/src/services/statusTransition.ts:308, dashboard/src/routes/placements/MovePromptModal.tsx:15
---

**Problem.** The Approval & Move-in diagram stamps `Schedule inspection → Awaiting
inspection` on the landlord recording an inspection date. Live audit confirmed there is
**no capture today**: sending `inspectionDate` on that transition is silently ignored
(HTTP 200, `inspection_date` stays undefined). Only the pass/fail `inspection_outcome`
exists; the scheduled DATE has no home.

**Suggested fix.** First-class `inspection_date?: string` (ISO date) on `PlacementItem`,
captured via the transition input + `MovePromptModal` gate on the `schedule_inspection`
exit — mirroring the `inspection_outcome` precedent. Built by Approval & Move-in Tasks
2/3/4/7/8. See [[approval-move-in-audit]].
