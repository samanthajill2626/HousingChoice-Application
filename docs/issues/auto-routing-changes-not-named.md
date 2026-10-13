---
id: auto-routing-changes-not-named
title: Automatic primary-contact changes (the restore's sole-landlord promotion, auto-primary on add) are not named before the write
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-13
refs: dashboard/src/routes/listing/RestoreLandlordDialog.tsx:134, dashboard/src/routes/listing/ListingDetail.tsx:564, dashboard/src/routes/listing/ListingDetail.tsx:579, dashboard/src/routes/listing/ListingDetail.tsx:1502, app/src/routes/units.ts:1845, app/src/repos/unitsRepo.ts:1347, app/src/repos/unitsRepo.ts:938, app/src/lib/rosterResolution.ts:294, app/src/lib/tourContacts.ts:129
---

**Problem.** Two rules `fix/caseworker-integrity` added (Cameron's rulings,
spec revisions 4-6, section 4) re-point a property's primary contact - who
calls and new relay groups for the property reach - without naming the
change before the write:

- "Restore without a landlord" makes the one remaining contact eligible for
  automatic routing the primary contact when the cleared landlord was the
  primary (decided at `app/src/routes/units.ts:1845`, written in
  `app/src/repos/unitsRepo.ts:1347-1350`), but the restore dialog's sentence
  and buttons say nothing about it
  (`dashboard/src/routes/listing/RestoreLandlordDialog.tsx:134`, `:114-130`).
- "+ Add contact" always posts `primaryContact: false`
  (`dashboard/src/routes/listing/ListingDetail.tsx:579`), yet a contact
  eligible for automatic routing added to an ownerless, primary-less property
  becomes its primary contact with no notice.

The page's own rule for removing the primary contact is to NAME the
promotion before writing - "silently moving calls is not acceptable"
(`ListingDetail.tsx:1502-1503`; `promotionNotice`, `:564`). The Contacts card
does show the new primary afterwards, but only if someone looks. Found by
the caseworker-integrity final review (A8,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`
finding 8); deferred by the planner as UX polish on rules Cameron asked for.

**Suggested fix.** When the cleared landlord is the primary, have the
restore dialog name who will become the primary contact (or that no one
will); after an add that came back primary although the request said false,
show a one-line notice. Both are new copy for Cameron to rule on.

**Related: the resolvers do not filter soft-deleted contacts; the I3 claim
is type-only (2026-10-13; final review round 2 R2-3 / R2-F7, FWF re-review
F5; ruled DEFER).** The claim of a vacant landlord slot asks only whether
the contact is typed landlord (spec revision 6;
`app/src/repos/unitsRepo.ts:938`), so an API caller can add a SOFT-DELETED
landlord-typed contact with role Landlord to an ownerless property and make
it the landlord of record; it joins non-primary (pinned by
`app/test/unitsApiRosterAutoPrimary.test.ts:155-172`). With no primary row
the resolvers fall back to the landlord of record
(`app/src/lib/rosterResolution.ts:292-301`,
`app/src/lib/tourContacts.ts:124-129`) and never filter a soft-deleted
contact (`memberFromContact`, `rosterResolution.ts:181-200`), so relay groups
and tour copy route to the deleted contact anyway: the auto-primary
exclusion (fix wave FWF-3) changes the primary flag, not where messages go.
Pre-existing resolver behavior (any soft-deleted landlord of record routes
today) and API-only (the Add contact picker lists live contacts). Direction:
decide where "a deleted contact never receives routing" is enforced - the
resolvers skipping a soft-deleted primary or landlord-of-record contact is
the honest place - or document that the rule covers only the primary flag.
