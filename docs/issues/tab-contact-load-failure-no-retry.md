---
id: tab-contact-load-failure-no-retry
title: A failed contact join blanks a tour/placement 1:1 tab with no way to retry
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-04
refs: dashboard/src/routes/tours/TourConversation.tsx:166, dashboard/src/routes/placements/PlacementConversation.tsx:131, dashboard/src/routes/contact/ContactCommsTab.tsx:22, dashboard/src/routes/tours/useTour.ts:33, dashboard/src/routes/placements/PlacementDetail.tsx:140
---

**Problem.** Both hubs load the tenant and landlord contacts as BEST-EFFORT
joins - `getContact(...).catch(() => null)` (useTour.ts:89-98,
PlacementDetail.tsx:153-159). Since contact-comms-pane the 1:1 tabs render the
shared person pane, which structurally requires a LOADED `Contact`
(ContactCommsTab.tsx:22-24), so a null join no longer degrades: the tab body
becomes one static sentence - "We could not load <name>'s contact record."
(TourConversation.tsx:169, PlacementConversation.tsx:134) - with no transcript,
no composer, and no affordance to try again. The operator's only recovery is a
full page reload or navigating to /contacts/:id.

A transient 5xx or a dropped connection is the common case. The permanent case
is a `unit.landlordId` pointing at a contact the API 404s: that Landlord tab is
then dead for good.

Before the rewire the tab needed only `oneToOneContactId`, so a null Contact
still rendered a working transcript and composer (the old ContactThread keyed on
conversationId, NewContactThread on contactId).

Adjudicated OUT of the contact-comms-pane fix wave on its stated condition:
neither page EXPOSES a cheap refetch handle for its contacts. `useTour` returns
`{status, tour, setTour, unit, tenant, landlord}` and keeps `load` private
(useTour.ts:33-42, :78-106); `PlacementDetail`'s `load` is a component-local
useCallback that is never passed into `PlacementConversation`
(PlacementDetail.tsx:140-166). Wiring a Try-again button therefore means WIDENING
the hook contract plus a new prop on both conversation components - new plumbing,
which the wave was told not to build.

Note the sibling fix that DID land in that wave: the mark-read fan-out is now
gated on a loaded contact, so a blanked tab no longer silently clears the
person's whole inbox row. What remains is purely the missing recovery path.

**Suggested fix.** Add a `refetch` (or `reloadContacts`) to `TourState` and pass
the placement page's existing `load` down, then render a "Try again" button in
the load-failure empty state of both conversation components. Second option, if
the pane is ever relaxed: let it accept `{contactId}` plus an OPTIONAL `Contact`
and degrade to a numbers-unknown composer instead of an empty state. Keep the
distinct "landlord not resolved yet" copy - that one is not a failure and must
not offer a retry.
