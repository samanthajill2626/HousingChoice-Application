---
id: past-tab-no-show-rows-need-an-exit
title: No-show rows on the Tours Past tab have no way off the list until they age out at 90 days
type: decision
severity: med
status: open
area: dashboard/tours
created: 2026-09-26
refs: dashboard/src/routes/tours/ToursPage.tsx, dashboard/src/routes/tours/TourDetail.tsx:261, app/src/lib/toursModel.ts:110
---

**Problem.** The Tours page's Past tab (spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`, section
4.4) lists `no_show` tours from the last 90 days as "No show" with no row
action, because the mission named only "Mark toured" and "Record outcome" and
ruled that no tour's status changes except through those actions. The tour
page offers a no-show only "Reschedule" (`canReschedule`, `toursModel.ts:110`)
and "Send no-show check-in"; the exit gate needs a `toured` tour and Cancel is
gated to requested/scheduled in the UI (`TourDetail.tsx:261-267`). So a
no-show that Sam has followed up on and given up on stays on the Past list for
90 days. The tab cannot be worked down to zero.

Sam's ask (items 18/20) was visibility for follow-up, so the rows are useful;
the missing piece is a way to say "done with this one".

**Suggested fix (product call).** Options, cheapest first:

1. A "Cancel tour" action on a no-show row (the server already allows
   `no_show -> canceled`; only the UI gate is narrower). Moves it to Closed
   as canceled - the honest end state for "never happened, not rescheduling".
2. A "Mark toured" on a no-show (server allows `no_show -> toured`) for the
   case where the tenant did eventually show; then the outcome gate closes it.
3. A dedicated "followed up" flag that hides the row without changing status.

Option 1 fits the existing status model with no new state. Ask Sam.

**Asked Sam 2026-09-27 (Cameron's ruling: "we need to ask Sam").** Added under
item 18 ("Tours: past and upcoming") in the HousingChoice Improvements Tracker,
"Questions and decisions": "No-shows on the new Past tab stay on the list for
90 days, because there is no way to mark one as done. Should a no-show get a
way off the list, such as Cancel tour (moves it to Closed)?" Open until Sam
answers; option 1 above is the recommendation.
