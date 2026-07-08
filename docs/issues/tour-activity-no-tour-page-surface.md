---
id: tour-activity-no-tour-page-surface
title: Tour detail page shows none of its own lifecycle history
type: improvement
severity: low
status: resolved
resolved: 2026-07-08
area: dashboard/tours
created: 2026-07-03
refs: app/src/routes/tours.ts, dashboard/src/routes/tours/
---

**Resolution (2026-07-08, tour-detail-page feature).** Fixed via suggested option
(a). Phase 1a added a third best-effort `audit.append(`tours#<tourId>`, ...)` write
in `recordTourEvent` (plus `tour_group_opened` / `tour_converted` milestones) and a
`GET /api/tours/:tourId/activity` endpoint (limit + `before` cursor). Phase 1b's
rebuilt tour page now has its OWN **Activity card** (right column) reading
`tours#<id>` via that endpoint through `useTourActivity` + `getTourActivity`,
mirroring the placement History panel (newest-first, load-more). The navigator no
longer has to leave for the tenant or property surface to see the tour's history.

**Problem.** The activity-coverage feature (2026-07-03) propagates the tour
lifecycle to two surfaces — the tenant's contact timeline (activity milestones:
`tour_scheduled`/`tour_took_place`/`tour_no_show`/`tour_canceled`/`tour_outcome`)
and the property's Activity card (`units#<unitId>` audit rows) — but the **tour
detail page itself still shows no history of its own lifecycle**. A navigator on
the tour page can't see when it was scheduled, rescheduled, marked toured/no-show,
canceled, or what the exit-gate outcome was, without leaving for the tenant or
property surface. (The plan deliberately left the tour detail page unchanged.)

Pairs with [[scheduled-message-visibility]] (the tour reminder-ladder panel) — both
are "the tour page should show more of what's happening on this tour."

**Suggested fix.** A tour History panel that reads the tour's lifecycle. The audit
rows already written under `units#<unitId>` carry `{ tourId }`, but they're keyed by
unit, not tour — so either (a) also write a `tours#<tourId>` audit row in
`recordTourEvent` (cheapest — one more `audit.append`), then read it with
`listByEntity('tours#'+id)`, or (b) derive the history from the tenant activity
events filtered by `refType:'tour', refId:tourId`. Option (a) keeps the tour page
self-contained and mirrors the placement History panel.
