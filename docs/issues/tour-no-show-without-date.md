---
id: tour-no-show-without-date
title: PATCH /api/tours accepts no_show on a tour that never had a date
type: improvement
severity: low
status: open
area: app/tours
created: 2026-10-06
refs: app/src/routes/tours.ts:1051, app/src/routes/tours.ts:1084, dashboard/src/routes/tours/TourDetail.tsx:319
---

**Problem.** The status guard refuses only the direct edge requested -> no_show
(`app/src/routes/tours.ts:1084-1087`). A requested tour can be canceled, or
recorded as toured with the date left blank, and then PATCHed to `no_show`:
nothing in `tours.ts:1051-1106` requires a date for `no_show` (only `scheduled`
does). The result is a "no-show" for a visit that was never booked - a state the
domain does not mean (the guard's own comment: "a tour nobody booked and nobody
attended is a cancellation, not a no-show").

The dashboard cannot produce it - Mark no-show is offered only on a scheduled
tour (`dashboard/src/routes/tours/TourDetail.tsx:319`) - so only a direct API
caller can. Found by the tour-list (All tab) design review, 2026-10-06
(`docs/superpowers/reviews/2026-10-06-tour-list/design-review/`); the All tab
was made robust to such a row (its undated phase reads `no_show` too) rather
than changing the writer in that branch.

**Suggested fix.** In the PATCH status guard, refuse `no_show` when neither the
patch nor the stored tour carries a `scheduledAt` (409
`illegal_status_transition`, mirroring the scheduled-requires-a-time rule at
`tours.ts:1096-1105`), with a route test for both indirect paths.
