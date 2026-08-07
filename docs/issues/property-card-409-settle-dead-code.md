---
id: property-card-409-settle-dead-code
title: Property Contacts card 409 settle path is dead code for add/make-primary/role-change
type: debt
severity: low
status: open
area: dashboard
created: 2026-08-06
refs: app/src/routes/units.ts:1030, app/src/repos/unitsRepo.ts:568, dashboard/src/routes/listing/ListingDetail.tsx:387, dashboard/src/routes/listing/ListingDetail.tsx:111
---

**Problem.** The property Contacts card ships a 409 conflict handler
(ListingDetail.tsx:387-401) meant to settle the card when a write collides
with the landlord-of-record rules - but for ADD, MAKE-PRIMARY and ROLE-CHANGE
it can never fire: `units.ts:1030 addContact` has no 409 branch because the
landlord-of-record collision is resolved SILENTLY inside
`unitsRepo.ts:568-570`. Only DELETE can produce the 409, so most of the
handler is dead code. Two adjacent nits ride along: the 409 copy is
hardcoded (ListingDetail.tsx:111-112) and never consults `err.code`, and
when the 409 does fire inside the remove confirm, the settled row re-renders
BEHIND the still-open modal. Found by the contact-rosters planner review
(C8), adjudicated FILE.

**Suggested fix.** Decide the contract first: either the repo surfaces the
collision (409 with a code) for all four mutations and the card's handler
becomes real - or the silent-resolve behavior is blessed, the dead branches
are deleted, and only the DELETE path keeps a (code-aware) handler that also
closes the confirm before settling the row.
