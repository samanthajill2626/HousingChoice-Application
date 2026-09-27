---
id: tour-conversion-pending-placeholder-view-link
title: A tour left with a `pending:` conversion placeholder renders "View placement" linking to /placements/pending:...
type: bug
severity: low
status: open
area: dashboard/tours
created: 2026-09-26
refs: app/src/routes/placements.ts:754, dashboard/src/routes/tours/TourDetail.tsx:292, dashboard/src/routes/tours/TourDetail.tsx:528
---

**Problem.** `POST /api/placements/from-tour` claims the tour by writing a
`pending:<...>` sentinel into `convertedPlacementId`, creates the placement,
then finalizes the tour (real placementId + `closed`). If the finalize fails
the route tries to release the claim; if THAT also fails the tour is left
carrying the sentinel (`app/src/routes/placements.ts:754-760`, the "accepted
residue" comment covers the retry creating a second placement, not the
sentinel's rendering).

The tour page reads `isConverted = typeof tour.convertedPlacementId ===
'string'` (`TourDetail.tsx:292`) and, when true, renders the primary CTA "View
placement" with `href={/placements/${tour.convertedPlacementId}}`
(`TourDetail.tsx:528-533`). With the sentinel that is
`/placements/pending:...`, a placement that does not exist. The real placement
(findable by `fromTourId`) is unreachable from the tour page.

Found by spec review round 3 of
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md` (4.2
step 3): the Past tab excludes such a tour as "decided", so the tab does not
add a wrong path, but it also cannot help.

**Suggested fix.** Treat a `pending:`-prefixed `convertedPlacementId` as NOT
converted in `TourDetail` (every server reader already gates on the prefix,
per the `TourItem` doc comment) and render a small "Conversion did not finish"
note with a "Find placement" action that queries placements by `fromTourId`;
or have the server's claim-release retry harder. Decide with the
conversion-residue owner.
