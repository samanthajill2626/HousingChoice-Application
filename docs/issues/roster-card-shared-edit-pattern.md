---
id: roster-card-shared-edit-pattern
title: Property Contacts card and tour/placement People card share an edit pattern - extract on the third caller
type: debt
severity: low
status: open
area: dashboard
created: 2026-08-05
refs: dashboard/src/routes/shared/PeopleCard.tsx,dashboard/src/routes/listings/ListingDetail.tsx
---

**Problem.** The property Contacts card editor (contact-rosters Task 9) and
the tour/placement People card edit mode (Task 11) now share a visible
pattern: per-row remove anchored to the name line, inline "+ Add" pathways, a
committed-pick contact search, every action persisting on click, and
busy-disabled controls. They are two hand-rolled implementations today -
fine at two callers, drift-prone at three. Filed per the contact-rosters
spec (section 12).

**Suggested fix.** When a THIRD roster-like editor appears (e.g. tenant
support contacts, building/parcel rosters), extract the shared shell (row +
remove + suggestion + add-any-contact + busy discipline) into one component
and re-skin the two existing cards over it. Do not extract preemptively -
the two cards' write seams differ (unit writes vs owner-scoped roster
writes) and a premature abstraction would couple them.
