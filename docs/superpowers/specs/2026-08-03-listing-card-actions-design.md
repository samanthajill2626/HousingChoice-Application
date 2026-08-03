# Listing-card actions: + Tour / + Placement, and bare-count asides removed

Date: 2026-08-03. Approved by Cameron (quick lane: typecheck + unit + live QA;
no bulk e2e). Branch: feat/listing-card-actions.

## What

On the property (listing) detail page, the "Tours on this property" and
"Placements on this property" cards get a header action that launches the
respective creation flow, following the existing "Sent to tenants" / "+ Send"
CardAction pattern. Separately, ALL bare-count card asides across the dashboard
are removed (Cameron: the counts add nothing; the button replaces the count on
the two cards that get one).

## Card actions (ListingDetail.tsx)

- "Tours on this property": aside becomes `+ Tour` (CardAction, aria-label
  "Schedule a tour on this property"), hidden when the property is deleted.
  Opens `ScheduleTourForm` with `initialUnitId={unit.unitId}` (unit side
  pre-committed; tenant side free typeahead; tour type auto-derives from the
  property). `onCreated` navigates to `/tours/:tourId` (matches ToursPage and
  ContactDetail). New local state `schedulingTour`.
- "Placements on this property": aside becomes `+ Placement` (CardAction,
  aria-label "Start a placement on this property"), hidden when deleted.
  Triggers the EXISTING `setStartingPlacement(true)` dialog (unit pre-filled +
  locked, navigates to the new placement). No new plumbing.

## Bare-count asides removed (no replacement)

- TourDetail.tsx "Activity"
- PlacementDetail.tsx "History"
- GroupTextsCard.tsx "Group texts"
- LandlordFile.tsx "Tours on their properties" and "Placements on their units"
- UnknownFile.tsx "Placements"

Text asides that are words, not counts ("same landlord", "recipients"), stay.

## Testing

Extend ListingDetail.test.tsx following the "+ Send" specs: each button opens
the right form pre-filled to this property; both hidden when deleted; count
asides gone. Sweep other unit tests and e2e specs for assertions on the removed
counts and update them. Gates: `npm run typecheck` + `npm test`; live QA of both
flows via the e2e session stack.
