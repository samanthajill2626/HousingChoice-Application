---
id: relay-member-key-collapses-two-phones-one-contact
title: Relay keys delivery legs on contactId, so one contact on two numbers collapses into a single slot - and a changed number silently redirects the send
type: bug
severity: med
status: open
area: app/messaging-relay
created: 2026-09-02
refs: app/src/repos/messagesRepo.ts:189, app/src/services/groupMembers.ts:31, app/src/services/rosterEdits.ts:558, app/src/jobs/relayFanOut.ts:1169, app/src/repos/messagesRepo.ts:155
---

**Problem.** `relayMemberKey` (`app/src/repos/messagesRepo.ts:189-193`) prefers
the `contactId` and falls back to `phone#<E164>` only when there is none. That
key is the `delivery_recipients` map key AND the key stored on the relaysid
pointer, so it decides which recipient slot a delivery callback updates.

Two members of one relay group carrying the SAME `contactId` on DIFFERENT phone
numbers therefore collapse into ONE slot: two real sends, two real handsets, one
delivery outcome. Whichever callback lands last wins, and the dashboard reports
a single leg where two exist. Nothing prevents the arrangement - roster de-dupe
is by phone, first-wins (`app/src/services/rosterEdits.ts:558-563`, `:650-658`),
and no layer enforces contactId uniqueness within a group. `Contact.phones[]` is
a modelled concept, so this is a supported shape of the data, not a corruption.

**The native group-text path already decided this the other way, and wrote down
why.** `groupMemberKey` (`app/src/services/groupMembers.ts:31-44`) is ALWAYS
`phone#<E164>`, "NEVER `relayMemberKey`", and its docblock names this exact
hazard: one contact owning two member numbers "would collapse into a single slot
- one delivery outcome for two handsets, and one sender chip for two people's
messages." Relay is the outlier, not group text.

**The second half is the destination.** Nothing durably records which phone
number a leg was actually sent to. `RelayRecipientDelivery`
(`app/src/repos/messagesRepo.ts:155-165`) has no `to` field, `MessageItem` has
none either, and `participant_phone` is synthetic on a relay group. The fan-out
reads `member.phone` off the LIVE roster at send time
(`app/src/jobs/relayFanOut.ts:1169`). So when a member's number changes between
one send and the next, the later send silently goes to the new number under the
same slot, with no record that the destination moved. For an ordinary forward
that is arguably correct; for anything that re-sends an OLD message it is a
silent redirect of a message the new number was never an intended recipient of.

**Suggested fix.** Key relay delivery legs on `phone#<E164>` unconditionally, as
`groupMemberKey` does, keeping `contactId` as roster DISPLAY metadata on the
participant. This is a change to the identity of an existing persisted map key,
so it needs its own mission: existing rows carry contactId-keyed slots, the
relaysid pointers written before the change carry the old key, and the roster,
preview, presenter and accessible-name paths all read member keys. A migration
or a read-time dual-key tolerance is required; a bare edit to `relayMemberKey`
would orphan every in-flight delivery callback.

**Related.**
[`relay-preview-memberkey-collision-overcount`](./relay-preview-memberkey-collision-overcount.md)
is the same collision one layer up, in the open-preview join
(`phone:<E164>` there, not `phone#<E164>`); it over-counts recipients rather
than merging delivery outcomes. Fixing the delivery key does not fix the preview
key, and vice versa.

[`relay-30003-retry-lineage`](./relay-30003-retry-lineage.md) (RESOLVED
2026-09-02) is constrained by both halves and works AROUND them rather than
fixing them, on the founder's 2026-09-02 ruling that the keying change is
separate work. Two guards, and both are scoped to the retry path only:

- **The ladder's IDENTITY is the destination handset, not the member key** (its
  spec D5). A retry's atomic claim is the create of a `sid#` pointer under the
  synthetic provider SID `relayretry-<digest>-<attempt>` (D3), where `<digest>`
  is `relayRetryDigest` (`app/src/lib/relayRetryClaim.ts`): the first 16 hex
  chars of SHA-256 of `<root tsMsgId>|<destination E164>`. Two handsets sharing
  one collapsed slot therefore run two SEPARATE, non-colliding ladders, and a
  retry is never ambiguous about which leg it is retrying. It is hashed rather
  than raw because the value ends up inside a sort key, where a phone number
  must never appear. The DISPLAY join still keys on the member key the retry row
  records, so the collapse is unchanged on screen.
- **Nothing is recorded on the LEG.** `RelayRecipientDelivery` is deliberately
  not changed (its spec D17), which is what keeps the promise that a failed slot
  is never rewritten. The digest above is stored on the retry ROW as
  `relay_retry_dest_digest`, and before sending, the retry job
  (`app/src/jobs/relayRetryLeg.ts`) recomputes it from the member's CURRENT
  roster number and refuses on any mismatch, closing the leg
  `retry_number_changed`. So an old message is never silently redirected to a
  number that changed during the backoff - but the second half of this issue, no
  durable record of where an ORDINARY leg was sent, is untouched.

Every other relay send still carries both defects.
