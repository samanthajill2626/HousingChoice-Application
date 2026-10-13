---
id: auto-routing-changes-not-named
title: Automatic primary-contact changes (the restore's sole-landlord promotion, auto-primary on add) are not named before the write
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-13
refs: dashboard/src/routes/listing/RestoreLandlordDialog.tsx:122, dashboard/src/routes/listing/ListingDetail.tsx:544, dashboard/src/routes/listing/ListingDetail.tsx:559, dashboard/src/routes/listing/ListingDetail.tsx:1457, app/src/routes/units.ts:1840, app/src/repos/unitsRepo.ts:1344
---

**Problem.** Two rules `fix/caseworker-integrity` added (Cameron's rulings,
spec revisions 4-6, section 4) re-point a property's primary contact - who
calls and new relay groups for the property reach - without naming the
change before the write:

- "Restore without a landlord" makes the one remaining contact eligible for
  automatic routing the primary contact when the cleared landlord was the
  primary (decided at `app/src/routes/units.ts:1840`, written in
  `app/src/repos/unitsRepo.ts:1344-1347`), but the restore dialog's sentence
  and buttons say nothing about it
  (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:122`, `:102-118`).
- "+ Add contact" always posts `primaryContact: false`
  (`dashboard/src/routes/listing/ListingDetail.tsx:559`), yet a contact
  eligible for automatic routing added to an ownerless, primary-less property
  becomes its primary contact with no notice.

The page's own rule for removing the primary contact is to NAME the
promotion before writing - "silently moving calls is not acceptable"
(`ListingDetail.tsx:1457-1458`; `promotionNotice`, `:544`). The Contacts card
does show the new primary afterwards, but only if someone looks. Found by
the caseworker-integrity final review (A8,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`
finding 8); deferred by the planner as UX polish on rules Cameron asked for.

**Suggested fix.** When the cleared landlord is the primary, have the
restore dialog name who will become the primary contact (or that no one
will); after an add that came back primary although the request said false,
show a one-line notice. Both are new copy for Cameron to rule on.
