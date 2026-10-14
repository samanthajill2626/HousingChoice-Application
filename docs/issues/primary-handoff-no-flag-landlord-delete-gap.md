---
id: primary-handoff-no-flag-landlord-delete-gap
title: Deleting the landlord of record of a property with NO flagged primary hands it to nobody - the contact-delete hand-off matches a flagged row only
type: decision
severity: med
status: resolved
area: app
created: 2026-10-13
resolved: 2026-10-13
refs: app/src/repos/unitsRepo.ts:900, app/src/repos/unitsRepo.ts:876, app/src/services/primaryHandoff.ts:97, app/src/repos/unitsRepo.ts:1784, app/test/helpers/twilioWebhookHarness.ts:3312, app/src/lib/propertyContact.ts:164, app/src/routes/contacts.ts:2293, dashboard/src/routes/contact/ContactDetail.tsx:146
---

**Problem.** The contact-DELETE hand-off (`DELETE /api/contacts/:id`,
primary-contact-integrity spec 4.6 "Delete the contact") moves a property's
primary to its heir only when the deleted contact is the FLAGGED primary:
the consistent units Scan collects a unit as a target only when its
`unitContacts()` flagged row is that contact
(`app/src/services/primaryHandoff.ts:86-89`), and `handOffPrimaryFrom`
re-checks the same thing on its consistent re-read and answers
`not_primary` otherwise (`app/src/repos/unitsRepo.ts:1739-1741`).

On a property with a stored contact list where NO row is flagged and
`landlordId` names contact L, L IS the property's contact: the
property-contact lookup falls back to the landlord of record when nothing is
flagged (`app/src/lib/propertyContact.ts:151-158`), and the restore paths
already treat L as the primary - `landlordWasPrimary`
(`app/src/repos/unitsRepo.ts:865-868`) answers true when no row is flagged.
Deleting L hands off nothing: the unit is never a target, no
`unit_primary_contact_assigned` row is written, and afterwards the lookup
skips the deleted L and answers nobody (`reason: 'deleted'`) even when a
live, eligible contact sits on the list. Nothing re-runs the hand-off later
(only the one-time backfill repairs such a unit, if it runs after the
delete). A landlord-only unit with NO stored list is not affected: its
DERIVED landlord row counts as flagged, so the Scan does target it, but that
row is its only row - `chooseHeir` finds no heir and `handOffPrimaryFrom`
answers `unchanged`, so nothing moves (there is nobody to move it to).

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
property's contact was deleted." (spec 7.4) and offers "Make <Name> primary"
when exactly one live contact typed landlord remains (the `autoEligible` row
flag) or "Choose a primary" when two or more do; with none, it shows "Add a
property manager or owner - they become the primary automatically." and
still offers "Choose a primary" while a live contact that is not a
caseworker remains (spec 7.4, planner fix wave F1). The next roster write
for an eligible contact promotes it (spec 4.4: a deleted landlord of record
counts as absent), and the backfill repairs the unit. The contact Delete
dialog's sentence, that the landlord or another contact takes over
(`dashboard/src/routes/contact/ContactDetail.tsx:140-141`), does not hold
for this shape.

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
- `handOffPrimaryFrom`'s re-check (`unitsRepo.ts:1739-1741`): the same
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

**Resolution (2026-10-13, `feat/primary-contact-integrity` planner fix wave
3 F2, commit `f18ac75f`).** Cameron took the spec amendment before the
merge (planner fix-wave findings F2): the suggested fix above, as written.
ONE shared, exported pure predicate, `contactIsPrimaryToHandOff(unit,
contactId)` (`app/src/repos/unitsRepo.ts:900`, next to `landlordWasPrimary`):
the landlord of record (a non-empty `landlordId`) ->
`landlordWasPrimary(unitContacts(unit), contactId)`; anyone else -> their
row is the flagged primary. It is used in all three places, with no copies:
the Scan's target test (`app/src/services/primaryHandoff.ts:97`),
`handOffPrimaryFrom`'s re-check on its consistent re-read - so a lost
write's retry re-checks it too (`app/src/repos/unitsRepo.ts:1784`) - and the
FakeWorld mirror (`app/test/helpers/twilioWebhookHarness.ts:3312`).
Unchanged: `chooseHeir` with the deleted landlord EXCLUDED and never read
(step 1 skips it, step 2 takes the earliest-added eligible contact),
`applyPrimary` flags the heir and sets the scalar, `landlordId` is not
changed, the audit row is `unit_primary_contact_assigned { reason:
'handoff_on_delete', from: <deleted landlord> }`, no heir changes nothing,
unknown is logged and skipped. A landlord-only unit with no stored list
behaves as before. Pinned: the round-1 repro on the FakeWorld (route and
service), a DynamoDB Local case beside
`app/test/unitsRepoHandOffPrimary.integration.test.ts` (plus a lost write
whose retry re-checks into `not_primary`), three rows in the fake-vs-real
parity table, and the two guards - a no-flag unit whose landlord of record
is someone else is not a target; a flagged row elsewhere wins - each shown
to fail against a deliberately wrong predicate. Spec 4.6's "Delete the
contact" bullet and its last bullet now say restore and delete AGREE. The
Delete dialog's sentence now holds for this shape too, and since fix wave
F5b (commit `b5561c2c`) it says the landlord or another contact takes over
"when someone can". Records:
`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/code-review/fix-wave-3B-report.md`.
