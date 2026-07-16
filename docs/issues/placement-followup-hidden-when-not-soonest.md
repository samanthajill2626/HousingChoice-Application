---
id: placement-followup-hidden-when-not-soonest
title: Deadlines card shows "none set" for a follow-up that exists when another deadline is sooner
type: bug
severity: med
area: app
status: open
created: 2026-07-15
refs: dashboard/src/routes/placements/PlacementDetail.tsx, dashboard/src/routes/placements/DeadlinesNudgesCard.tsx, app/src/routes/placements.ts
---

**Problem.** The placement wire shape exposes only the COMPUTED soonest
deadline (next_deadline_type / next_deadline_at), so the placement detail
hub's Deadlines-and-nudges card can only show the follow-up row when the
follow-up IS the soonest deadline. If a manual follow-up is armed but an RTA
window (or anything sooner) is also pending, the Follow-up row reads "none
set" with a live "Set follow-up" control - staff can be misled into thinking
no follow-up exists and unknowingly overwrite the armed one. Consistent with
the merged soonest-wins deadline model, but an honesty gap on the new hub.

**Suggested fix.** Add a small per-placement deadline LIST read (e.g.
GET /api/placements/:placementId/deadlines returning all pending
placementDeadlines rows - the table + byPlacement access already exist), and
have the card render voucher / RTA window / follow-up rows from it instead
of the single computed-soonest pair. Interim mitigation if wanted sooner:
label the card "(soonest deadline shown)" so the "none set" reading is not
trusted absolutely.
