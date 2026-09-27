---
id: past-tab-timeless-toured-tours
title: A toured tour with no scheduled time ("already toured", date blank) never appears on the Tours Past tab
type: improvement
severity: med
status: open
area: dashboard/tours
created: 2026-09-26
refs: dashboard/src/routes/tours/TourModals.tsx:212, dashboard/src/routes/tours/useTours.ts, app/src/routes/tours.ts:1086
---

**Problem.** The Tours page's Past tab (spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`, section
4.2) lists the last 90 days' tours that still need a decision by ONE range
query on the `byScheduledAt` GSI. A `requested` tour may be marked "already
toured" with the date left blank (`TourModals.tsx:212-218`; the route accepts
`requested -> toured` without a time, `tours.ts:1086-1109`). Such a tour is
`toured`, has no outcome, is not `requested` (so it is not in Active's "Needs
booking"), and has no `scheduledAt`, so it is not in the sparse GSI and no
range query ever returns it. It is exactly the "toured, waiting on an outcome"
state the Past tab exists to surface, and it is on no list at all.

The mission that built the tab defined Past by scheduled time (Cameron's
decision text: "tours whose scheduled time is before the start of today"), so
the planner deferred this rather than widen the definition unattended (spec
section 9, Q10).

**Suggested fix.** Add a second read to `usePastTours`:
`getTours({ status: 'toured' })` (`listByStatus` already paginates), keep only
the rows WITHOUT `scheduledAt` and without an `outcome`, place them by
`updatedAt ?? createdAt` inside the same 90-day window, and render their time
column as "No date". Merge by `tourId` with the range rows. Decide with Sam
whether an undated toured tour sorts to the top (it was most recently touched)
or the bottom.
