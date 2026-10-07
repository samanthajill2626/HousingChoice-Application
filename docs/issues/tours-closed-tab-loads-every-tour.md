---
id: tours-closed-tab-loads-every-tour
title: The Tours page's Closed tab reads every closed and canceled tour ever recorded - a list that only grows
type: improvement
severity: low
status: open
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/useTours.ts:121, dashboard/src/routes/tours/ToursPage.tsx:671, app/src/routes/tours.ts:425, app/src/routes/tours.ts:440
---

**Problem.** Every visit to the Closed tab (`/tours/closed`) runs
`useClosedTours` (`dashboard/src/routes/tours/useTours.ts:121-153`, mounted
at `ToursPage.tsx:671`): two reads, `GET /api/tours?status=closed` and
`GET /api/tours?status=canceled`, each served by `listByStatus` paged to
exhaustion (`app/src/routes/tours.ts:425`), then a sort in the browser by
last change (`updatedAt`, else `createdAt`). So the tab loads EVERY closed
and canceled tour the business has ever recorded, on every visit, and renders
them all in one list. That list only grows: every decided, converted or
canceled tour joins it, and since the two-week auto-close (merged
2026-10-05) the worker adds to it on its own.

Deferred by the Tours page All tab (spec
`docs/superpowers/specs/2026-10-06-tour-list-design.md` section 10: the Closed
tab still loads every closed and canceled tour; the new read can serve it
later). The cost is small at today's volume (a tour item is well under 2 KB);
it is filed so the tab moves to a paged read before its history makes it
slow. The tab also loads every contact and property to put names on its rows
- a separate issue,
[`tours-tabs-load-every-contact-for-names`](./tours-tabs-load-every-contact-for-names.md).

**Suggested fix.** Serve it from the All tab's paged read,
`GET /api/tours/list` (`app/src/routes/tours.ts:440`) with
`status=closed,canceled`: 50-row pages with a cursor and Load more, and the
names each page needs. The All tab with its Canceled and Closed chips already
shows this list. One decision first: the list read orders by tour date
(latest or earliest first, undated tours after the dated ones), while the
Closed tab orders by last change - either accept the date order or add a
last-change sort to the read.
