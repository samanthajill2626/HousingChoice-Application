---
id: today-next-tour-reminder-from-ladder
title: Repoint Today's "next tour reminder" at the tour ladder; retire the orphan placement tour_reminder deadline type
type: debt
severity: low
status: open
area: app+dashboard
created: 2026-07-03
refs: app/src/services/statusTransition.ts, app/src/repos/placementsRepo.ts, app/src/routes/today.ts, docs/issues/case-single-next-deadline-slot.md, docs/issues/scheduled-message-visibility.md
---

**Problem.** Now that tours own their own reminder ladder (`tourReminders` table, armed by
`armTourReminders`), the placement `next_deadline` slot's **`tour_reminder`** deadline type is
an **orphan**: research for [scheduled-message-visibility](./scheduled-message-visibility.md)
confirmed **no automated code path writes** `setNextDeadline({ type: 'tour_reminder', … })`
anymore (only `stuck_placement` and `rta_window` are written; `voucher_expiration` is likewise
unwritten). The type still exists in `PLACEMENT_DEADLINE_TYPES`
(`app/src/repos/placementsRepo.ts:56`), in the never-clobber `HARD_CLOCK_DEADLINE_TYPES` set,
and in Today's label map (`app/src/routes/today.ts`), and can still be set by the manual
`PATCH /placements/:id/deadline` route — but nothing automated feeds it, so "next tour
reminder" on the Today board is effectively dead data.

**Suggested fix.** Repoint any "next tour reminder" concept on the Today board to read from the
**tour reminder ladder** (`tourRemindersRepo` `next` upcoming rung) instead of the placement
`next_deadline` slot. Then retire the orphan `tour_reminder` deadline type (and decide
`voucher_expiration`'s fate) from `PLACEMENT_DEADLINE_TYPES` + the Today label map, guarding the
manual deadline PATCH route accordingly. Coordinate with
[case-single-next-deadline-slot](./case-single-next-deadline-slot.md) (the single-slot model)
so the change is coherent with how the one deadline slot is chosen. Low urgency — the orphan is
inert, not harmful; this is cleanup + a small correctness win for the Today "next reminder" cue.
