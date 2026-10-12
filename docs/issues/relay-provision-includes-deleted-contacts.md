---
id: relay-provision-includes-deleted-contacts
title: A soft-deleted contact on a tour or placement people list is still put on the relay group and texted
type: bug
severity: med
status: open
area: app
created: 2026-10-12
refs: app/src/lib/rosterResolution.ts:174-200, app/src/lib/rosterResolution.ts:541-555, app/src/services/rosterProvision.ts:106-121, app/src/services/relayAnnouncements.ts:64-73
---

**Problem.** Deleting a contact (soft delete, `DELETE /api/contacts/:id`) does
not take them off any tour or placement people list, and nothing downstream
treats a soft-deleted member as unreachable:

- `memberFromContact` (`rosterResolution.ts:181-200`) reads the contact with
  `getById`, which returns soft-deleted records, and keeps its phone and name.
  Its docblock (`:174-180`) says such a row "is excluded from every send" -
  true for a dangling id or a read failure (no phone survives), FALSE for a
  soft-deleted contact that still has a phone.
- `describeRoster` labels the member `removed_contact` (`:541`) but computes
  reachability from phone and opt-out only (`:550-555`), so the member counts
  toward `canOpenGroup` and the confirm dialog's recipient count.
- `provisionMembersOf` (`rosterProvision.ts:106-121`) puts every phone-bearing
  member on the thread.
- The fan-out suppression (`isMemberSuppressed`,
  `relayAnnouncements.ts:64-73`) checks `sms_opt_out` only.

So a contact deleted AFTER being added to a tour's people list by hand is
provisioned onto the group and receives the intro and every later message.

Found by the surface sweep for `feat/primary-contact-integrity` (spec
`docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`
section 9.3). That branch closes the PROPERTY-CONTACT route into this (its
shared lookup skips a deleted primary or landlord of record, so the default
people list no longer contains one). A member added by hand stays exposed.

**Suggested fix.** Decide the product rule first (drop the member from the
plan, keep the row but exclude it from provision and counts, or refuse the
open with a named reason), then apply it in ONE place the provision, the
preview count and `canOpenGroup` all read, and correct the docblock. An
already-open group with a member deleted later is a separate question (the
member is a thread participant; the fan-out would need a deletion check).
