---
id: interested-tour-missing-from-tours-card-until-reload
title: A one-click Interested creates a tour that the same page's Tours card does not show until reload
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-13
refs: dashboard/src/routes/listing/ListingDetail.tsx:420, dashboard/src/routes/listing/useListing.ts:75, docs/issues/tour-create-no-dedupe.md
---

**Problem.** On the property page (and the tenant page's Properties sent
card), the Interested button calls the outcome route, which creates a
`requested` tour and answers `{ row }`; the page applies that row in place
(`ListingDetail.tsx:420-423`, `setRecipientRow`) and refreshes nothing else.
The same page's Tours card keeps its loaded list, so the new tour is missing
from it until a reload. The row itself shows the "Tour requested" chip,
linked to the tour, so the state is not wrong - only the card is stale.

**Why it matters.** Staff who then use the Tours card's "+ Tour" instead of
the row's chip create a SECOND open tour for the pair, because `POST
/api/tours` does not dedupe (`tour-create-no-dedupe`). Found by the planner's
adversarial re-review of `feat/last-heard-from` (2026-10-13).

**Suggested fix.** After an outcome action whose returned row carries a new
`tour` (or changes `outcome` to `interested`), reload the page's tours slice
(`useListing` has none today - add a `reloadTours()`; the tenant page's
`useContactFile` has a whole-file `refetch`). Closing `tour-create-no-dedupe`
removes the duplicate risk independently.
