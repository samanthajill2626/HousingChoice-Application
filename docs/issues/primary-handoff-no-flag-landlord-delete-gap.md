---
id: primary-handoff-no-flag-landlord-delete-gap
title: Deleting the landlord of record of a property with NO flagged primary hands it to nobody - the contact-delete hand-off matches a flagged row only
type: decision
severity: med
status: open
area: app
created: 2026-10-13
refs: app/src/services/primaryHandoff.ts:86-89, app/src/repos/unitsRepo.ts:1738-1740, app/src/repos/unitsRepo.ts:865-868, app/src/lib/propertyContact.ts:149-156, app/src/routes/contacts.ts:2275-2279, dashboard/src/routes/contact/ContactDetail.tsx:140-141
---

**Problem.** The contact-DELETE hand-off (`DELETE /api/contacts/:id`,
primary-contact-integrity spec 4.6 "Delete the contact") moves a property's
primary to its heir only when the deleted contact is the FLAGGED primary:
the consistent units Scan collects a unit as a target only when its
`unitContacts()` flagged row is that contact
(`app/src/services/primaryHandoff.ts:86-89`), and `handOffPrimaryFrom`
re-checks the same thing on its consistent re-read and answers
`not_primary` otherwise (`app/src/repos/unitsRepo.ts:1738-1740`).

On a property with a stored contact list where NO row is flagged and
`landlordId` names contact L, L IS the property's contact: the
property-contact lookup falls back to the landlord of record when nothing is
flagged (`app/src/lib/propertyContact.ts:149-156`), and the restore paths
already treat L as the primary - `landlordWasPrimary`
(`app/src/repos/unitsRepo.ts:865-868`) answers true when no row is flagged.
Deleting L hands off nothing: the unit is never a target, no
`unit_primary_contact_assigned` row is written, and afterwards the lookup
skips the deleted L and answers nobody (`reason: 'deleted'`) even when a
live, eligible contact sits on the list. Nothing re-runs the hand-off later
(only the one-time backfill repairs such a unit, if it runs after the
delete). A landlord-only unit with NO stored list is not affected: its
DERIVED landlord row counts as flagged, so it is handed off.

**By design, for now.** Spec 4.6's last bullet ("Restore vs. contact delete
on a roster with NO flagged row") makes the difference deliberate: a restore
removes the landlord's row and hands off; the delete fan-out matches only a
flagged primary, and "Neither side is a bug to 'fix' toward the other"
(approved, spec rev 6). Code review round 1 confirmed the gap (adversarial
finding F1, MEDIUM) and adjudicated it BY DESIGN; it is filed here and
recommended to Cameron as a spec amendment he may take before or after the
merge. Severity: low-medium - the frontmatter says `med` because the schema
has no in-between value.

**Data shapes that reach it** (a non-empty stored list, no row flagged, a
landlord of record that is then deleted):

1. Legacy no-flag landlord claims: a Landlord-role claim written before
   caseworker-integrity's auto-primary existed kept the request's flag
   (false from the dashboard), and a restore WITH a landlord on such a list
   seated the new landlord unflagged - shape 1 of
   [`restore-without-landlord-can-leave-nobody-reachable`](./restore-without-landlord-can-leave-nobody-reachable.md).
2. The window between this branch's deploy and the one-time backfill
   (`app/scripts/assign-primary-contacts.ts`; RUNBOOK "Primary contacts
   backfill"): run BEFORE the delete, the backfill flags L, and the delete
   then hands off normally; run AFTER, it repairs the unit.
3. An API demotion: `primaryContact: false` on the flagged landlord's own
   row demotes it and leaves no row flagged (plan ruling R10).
4. A remove of the primary with no heir (every flag cleared, spec 4.6)
   followed by a re-import that attaches a landlord: the importer's
   `upsertUnit` sets `landlordId` with `if_not_exists` on a human-touched
   unit and adds no roster row (spec 9.1) - an off-roster landlord of record
   on a no-flag list.

**What staff see meanwhile.** The property page's box leads "This
property's contact was deleted." (spec 7.4) and, when an eligible row
exists, offers its one-click fix ("Make <Name> primary" or "Choose a
primary"). The next roster write for an eligible contact promotes it (spec
4.4: a deleted landlord of record counts as absent), and the backfill repairs
the unit. The contact Delete dialog's sentence, that the landlord or another
contact takes over (`dashboard/src/routes/contact/ContactDetail.tsx:140-141`),
does not hold for this shape.

**Suggested fix (the reviewer's recipe).** Reuse `landlordWasPrimary` in
both places, restricted to the deleted contact being the landlord of record
when nothing is flagged:

- The Scan's target predicate (`primaryHandoff.ts:86-89`): a unit is a
  target when its flagged row is the contact, OR when no row is flagged and
  `unit.landlordId` is the contact - that is,
  `contactId === unit.landlordId ? landlordWasPrimary(unitContacts(unit), contactId) : flagged?.contactId === contactId`.
  `landlordWasPrimary` alone is true for EVERY no-flag unit whoever its
  landlord is; the landlord-of-record test is what keeps one delete from
  targeting all of them.
- `handOffPrimaryFrom`'s re-check (`unitsRepo.ts:1738-1740`): the same
  predicate on the consistent re-read, so a retry still re-checks.
  `chooseHeir` already excludes the deleted landlord (step 1 skips it, step
  2 takes the earliest-added eligible contact) and `applyPrimary` flags the
  heir and sets the scalar; the audit row stays `handoff_on_delete` with
  `from` = the deleted landlord.
- Pin it with the round-1 repro case on the FakeWorld (`landlordId: c-ll`,
  list `[c-ll landlord unflagged, c-pm pm unflagged]`, delete c-ll, expect
  c-pm flagged and one audit row) plus one DynamoDB Local case beside
  `app/test/unitsRepoHandOffPrimary.integration.test.ts`, and amend spec 4.6's
  last bullet.

Same code path, separate and accepted (adversarial finding F5): every
contact DELETE runs this full, strongly consistent units Scan and reads
whole unit items (media arrays, addresses, notes). A `ProjectionExpression`
of `unitId`, `contacts` and `landlordId` on that Scan would cut its read
cost; a cheap future optimization (spec 4.6 accepts the Scan at today's
size).
