---
id: tours-tabs-load-every-contact-for-names
title: The Tours page's Active, Past and Closed tabs load every contact and every property just to put names on tour rows
type: improvement
severity: low
status: open
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/ToursPage.tsx:659, dashboard/src/routes/contacts/useContacts.ts:30, dashboard/src/routes/listings/useListings.ts:35, dashboard/src/api/paging.ts:31, app/src/routes/tours.ts:498, e2e/performance/routes.ts
---

**Problem.** The Active, Past and Closed tabs render through `TourListsView`
(`dashboard/src/routes/tours/ToursPage.tsx:659-671`), which loads four
rosters before it shows a row: `useContacts('all')` and
`useContacts('deleted')` - each a full page walk per contact type (tenant,
landlord, partner, unknown; `dashboard/src/routes/contacts/useContacts.ts:30-31`),
so eight walks - and `useListings()` plus `useListings(true)`, every live and
deleted unit (`dashboard/src/routes/listings/useListings.ts:35`). All of it
only to turn each tour's `tenantId` and `unitId` into a name and an address.

The walks grow with the whole business, not with the tours shown. Every visit
to those tabs pays them; the Past list starts its own reads only after they
land (one round trip later); and `fetchAllPages` stops at 50 pages of 100
rows per walk (`dashboard/src/api/paging.ts:31`), past which a row falls back
to its raw id (`tenantName` / `propertyLabel`, `ToursPage.tsx:88-100`). The
perf profiler's Tours contract counts these reads (`TOUR_LIST_ACTIVE_GETS` in
`e2e/performance/routes.ts`). Deferred by the Tours page All tab (spec
`docs/superpowers/specs/2026-10-06-tour-list-design.md` section 10).

**Suggested fix.** Take the All tab's way out: `GET /api/tours/list` returns,
with each page, the names its rows need - `contacts` and `units` maps keyed by
id, read in batches (`getDisplaysByIds`, `app/src/routes/tours.ts:498-499`;
spec 5.6 and P9) - so the All tab never loads the contact or property lists.
Either move the three views onto that read (for Closed, see
[`tours-closed-tab-loads-every-tour`](./tours-closed-tab-loads-every-tour.md))
or give their existing reads the same name maps, then drop the four roster
hooks from `TourListsView` and their GETs from the perf contract.
