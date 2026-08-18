---
id: relay-preview-memberkey-collision-overcount
title: One contactId on two phones collides on the preview memberKey and over-counts recipients
type: bug
severity: low
status: open
area: app/relay
created: 2026-08-17
refs: app/src/services/rosterEdits.ts:405-419, app/src/services/rosterEdits.ts:517-531, app/src/services/rosterEdits.ts:572-591
---

**Problem.** The shared open-preview core joins body members to reachable
recipients through `memberKey`, which is `contactId` when non-empty and
`phone:<E164>` otherwise (`rosterEdits.ts:518-519`). Two members carrying the
SAME `contactId` on DIFFERENT phone numbers survive the phone de-dupe and then
COLLIDE on that key, so one reachable leg marks both reachable:
`buildOpenPreviewFromParts` builds `reachableKeys` from the recipient rows and
counts body members whose key is in that set (`:409-412`). The adversarial
review of contact-create-relay-group reproduced a preview answering
`recipientCount: 2` over two rows for one contact where the second number was
opted out - truth is 1. That is exactly the overstatement RosterConfirmDialog's
header comment calls "the lie this dialog exists to prevent", and the composed
body reads "connected with <Name> and <Name>" from the same input.

The key shape is shared by BOTH callers of the core - the owner-scoped
`buildOpenPreview` (tour/placement) and the new standalone
`buildStandaloneOpenPreview` - deliberately, as parity. So this is not a defect
the standalone path invented; it inherited it, and fixing it in one path only
would break that parity.

Not reachable from the shipped picker: `CreateRelayGroupModal.pickCandidates`
filters on `takenIds`, so one contactId can be added at most once. It IS
reachable from `POST /api/relay-groups/preview` directly (a first-class
authenticated API) and from any future caller, and multi-number contacts are a
modelled concept (`Contact.phones[]`).

**Suggested fix.** Count distinct PHONES in the SHARED core rather than joining
on `memberKey`. The correct rule already exists in the same file:
`buildAddPreview` counts `reachablePhones.size` (`rosterEdits.ts:575-580,591`),
which is what the field means and what is immune to the collision. Because the
core is shared, that change moves the owner path too - do it deliberately, in
one change, with the tour and placement preview tests updated alongside rather
than incidentally.
