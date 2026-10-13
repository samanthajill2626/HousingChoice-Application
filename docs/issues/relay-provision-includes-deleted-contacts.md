---
id: relay-provision-includes-deleted-contacts
title: A soft-deleted contact on a tour or placement people list is still put on the relay group and texted
type: bug
severity: med
status: open
area: app
created: 2026-10-12
updated: 2026-10-13
refs: app/src/lib/rosterResolution.ts:200-232, app/src/lib/rosterResolution.ts:587-601, app/src/lib/rosterResolution.ts:660, app/src/services/rosterProvision.ts:107-121, app/src/services/relayAnnouncements.ts:64-101
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

**Update (2026-10-13, `feat/primary-contact-integrity` code review round 1,
finding L1): the docblock is corrected; the issue's real subject stays
open.**

- The `memberFromContact` docblock was rewritten by 03b058e9
  (`app/src/lib/rosterResolution.ts:200-220`). It now says a soft-deleted
  contact keeps its phone and name, that `describeRoster` labels it
  `removed_contact` but still counts it reachable, and that provisioning puts
  it on the relay thread - it is NOT excluded from sends - and it names this
  issue. The first Problem bullet's "FALSE" docblock claim is history, and
  "correct the docblock" in the Suggested fix is done.
- The PROPERTY-CONTACT route into this bug is closed: the shared lookup
  (`app/src/lib/propertyContact.ts`, 857355d6; the default people list moved
  onto it in 03b058e9) skips a soft-deleted or missing primary or landlord of
  record, so neither is put on a default people list.
- Still open, unchanged: a member added BY HAND (or left over in a plan) and
  soft-deleted later. Neither provisioning nor the fan-out suppression checks
  `deleted_at`. `describeRoster` computes reachability from phone and opt-out
  only (`app/src/lib/rosterResolution.ts:587-601`), so the member still counts
  toward `canOpenGroup` (`:619`, `:660`); `provisionMembersOf` keeps every
  phone-bearing member (`app/src/services/rosterProvision.ts:107-121`); and
  `isMemberSuppressed` checks `sms_opt_out` only
  (`app/src/services/relayAnnouncements.ts:64-101`, the contact test at
  `:73`). The Suggested fix above stands.

The Problem's line refs are the 2026-10-12 locations; `refs:` above now
points at the current ones.
