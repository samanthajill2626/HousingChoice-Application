---
id: auto-routing-changes-not-named
title: Automatic primary-contact changes (the restore's hand-off, auto-primary on add or edit) are not named before the write
type: improvement
severity: low
status: open
area: dashboard
created: 2026-10-13
updated: 2026-10-13
refs: dashboard/src/routes/listing/RestoreLandlordDialog.tsx:134, dashboard/src/routes/listing/ListingDetail.tsx:564, dashboard/src/routes/listing/ListingDetail.tsx:579, dashboard/src/routes/listing/ListingDetail.tsx:1502, app/src/routes/units.ts:2629, app/src/repos/unitsRepo.ts:1347, app/src/repos/unitsRepo.ts:938, app/src/lib/rosterResolution.ts:294, app/src/lib/tourContacts.ts:129
---

**Problem.** Two rules `fix/caseworker-integrity` added (Cameron's rulings,
spec revisions 4-6, section 4) re-point a property's primary contact - who
calls and new relay groups for the property reach - without naming the
change before the write:

- "Restore without a landlord" makes the one remaining contact eligible for
  automatic routing the primary contact when the cleared landlord was the
  primary (decided at `app/src/routes/units.ts:2629`, written in
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

**Update (2026-10-13, `feat/primary-contact-integrity`): the premise
changed; the gap itself - nothing names an AUTOMATIC change before the
write - stays open.** Spec
`docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
(rev 6, Cameron's rulings) widened both rules:

- "Restore without a landlord" no longer promotes "the one remaining"
  contact: when the cleared landlord was the primary, or no row is flagged
  (`landlordWasPrimary`, `app/src/repos/unitsRepo.ts`), the heir function
  (`chooseHeir`, `app/src/lib/propertyContact.ts`) picks the EARLIEST-added
  remaining contact eligible for automatic routing (spec 4.6; commits
  11b05393, d7991940). The restore dialog still names no one before the
  click.
- Auto-primary now also fires on an edit of the contact's OWN row (a role
  change), and a soft-deleted or missing flagged primary or landlord of
  record counts as absent (spec 4.4; 57bc3a74, 21741f91). Still no notice
  before or right after the write.
- New since this issue was filed: every automatic primary change appends a
  `unit_primary_contact_assigned` audit event with its reason (`auto_on_add`,
  `handoff_on_remove`, `handoff_on_delete`, `handoff_on_restore`,
  `backfill`), and the property's Activity card shows it as "Primary contact
  set automatically" with "<Name> - <why>" (9cde6088, ba944a79) - an
  after-the-fact record, not the before-the-write naming asked for here. The
  remove-the-primary confirm now reads who takes over from the server
  (26a8dba6), and the contact Delete dialog warns that a property's primary
  contact is handed over, without naming who (2d5daa99).

The "Related" paragraph is resolved: the one shared property-contact lookup
(`app/src/lib/propertyContact.ts`; 857355d6, e7710793, 03b058e9, d95feb1e)
skips a soft-deleted or missing primary or landlord of record, so relay
groups, tour copy and the default people list no longer route to a deleted
landlord of record - the resolvers are where "a deleted contact never
receives routing" is now enforced. The vacant-slot claim itself is still
type-only (an API caller can still make a soft-deleted landlord-typed contact
the landlord of record); it now routes nowhere. The refs above are the
pre-change locations.

**Update (2026-10-13, `feat/primary-contact-integrity` code review round 1,
pre-existing finding PRE-1 - `R1-adversarial.md` section 4, its `R1-PRE-1`
repro): the vacant-slot claim of a soft-deleted contact is NOT API-only - the
dashboard reaches it too.** On a property with no landlord of record (no
`landlordId` attribute), the Contacts card's edit mode keeps the role select
on a "(deleted)" row - spec 7.4 drops only its "Make primary"
(`dashboard/src/routes/listing/ListingDetail.tsx:1106-1131`) - and choosing
Landlord there re-posts the row (`onSetContactRole`, `ListingDetail.tsx:569-577`:
`POST /api/units/:id/contacts` with role `landlord` and the row's own flag).
Both claim checks ask only the contact's TYPE
(`app/src/routes/units.ts:1875-1881`; `app/src/repos/unitsRepo.ts:1173`,
`:1192`), so re-roling a "(deleted)" row whose contact is typed landlord
claims the slot: the deleted contact becomes the landlord of record
(`unitsRepo.ts:1281`), joins non-primary (it is not eligible for automatic
routing), and its row can then no longer be removed (409
`cannot_remove_landlord_of_record`, `unitsRepo.ts:1343-1344`). With no live
flagged primary elsewhere, the shared lookup skips that landlord and the
property has no property contact (the property box leads "This property's
contact was deleted."). The same review lists the other type-only checks
through which a soft-deleted contact becomes or stays a landlord of record:
unit create, PATCH `landlordId`, the restore choice
(`requireLandlordContact`, `app/src/services/contactTypeGuards.ts:83-90`)
and the plain restore (`app/src/routes/units.ts:2545-2551`, which keeps a
stored landlord of record typed landlord, deleted or not). Behavior is
unchanged on `feat/primary-contact-integrity` (caseworker-integrity's domain;
spec 7.4 keeps the role select on deleted rows).
