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

**Suggested fix.** Make REACHABILITY phone-keyed on BOTH sides of the join, not
just the count.

Counting distinct phones is NOT sufficient on its own, and the obvious model for
it does not work: `buildAddPreview` already counts `reachablePhones.size`
(`rosterEdits.ts:575-580,591`) and still reproduces the over-count, because the
membership test that fills that set is itself key-based -

```ts
const reachableKeys = new Set(view.members.filter(reachable).map((m) => m.memberKey));
for (const member of resolved.members) {
  if (reachableKeys.has(resolvedMemberKey(member))) reachablePhones.add(member.phone);
}
```

Feed it the same input (one contactId, two phones, one leg opted out) and the
contactId is in `reachableKeys`, so BOTH phones enter `reachablePhones` and the
answer is 2 again. Switching the count to phones only removes the double-count of
the SAME phone, which the open path's phone de-dupe already handles upstream.

The shape that IS correct already exists in `describeRoster`, which decides
reachability per resolved member and adds the PHONE to its set at the point of
that decision (`rosterResolution.ts:504,555`), then answers `canOpenGroup` off
`reachablePhones.size` (`:596`). Build the reachable-PHONE set from the recipient
rows the same way here - the phone a leg belongs to, never the key it collides on
- and the collision cannot inflate anything. Because the core is shared, the
change moves the owner path too: do it deliberately, in one change, with the tour
and placement preview tests updated alongside rather than incidentally.
