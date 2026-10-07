---
id: tours-all-live-updates
title: The Tours All tab does not update live on tour events - it reloads only on arrival, a filter change or a return restore
type: improvement
severity: low
status: open
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/useAllTours.ts, dashboard/src/api/EventStreamProvider.tsx:42, dashboard/src/routes/today/useToday.ts:152, app/src/routes/tours.ts:1595, app/src/jobs/tourAutoClose.ts:138
---

**Problem.** The Tours page's All tab (`/tours/all`) loads its list on
arrival, on a filter or sort change, and on a return restore - nothing else
(spec `docs/superpowers/specs/2026-10-06-tour-list-design.md` section 10:
live updates on tour events are not in that change). A tour that another
staff member books, marks, cancels or reopens - or that the worker
auto-closes - while the tab is open keeps its old date, status and outcome on
screen, and a row that no longer matches the filters stays listed, until the
user changes a filter, leaves and comes back, or reloads. The Active, Past and
Closed tabs behave the same way today (their hooks subscribe to no stream
event either); Today and the tour page do refresh live.

**Suggested fix.** Subscribe the All view to the existing `tour.updated`
stream event (`onTourUpdated`, `dashboard/src/api/EventStreamProvider.tsx:42`;
Today does, `dashboard/src/routes/today/useToday.ts:152`). The server emits it
on a PATCH, a reopen, a conversion and the auto-close
(`app/src/routes/tours.ts:1595`, `:1648`, `app/src/routes/placements.ts:900`,
`app/src/jobs/tourAutoClose.ts:138`). A CREATE emits no `tour.updated` (the
POST route's one emit is `scheduled.updated`, and only for a dated create that
arms reminders, `tours.ts:381`), so new tours need a signal too. The design question is how to
refresh a paged, possibly restored list without moving the user's place:
re-read only the loaded rows that changed (the event carries `tourId` and
`status` only), or show a "the list changed" notice with a refresh, rather
than restarting at page 1.
