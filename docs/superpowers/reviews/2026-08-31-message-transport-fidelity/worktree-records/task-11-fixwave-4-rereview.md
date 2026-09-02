# Task 11 fix wave 4 rereview

## Reviewed range

`2949b231..2470b871` (`fix: expose inbound Relay recipient accessibility`).

## P2 - The hidden inbound summary and revealed recipient list announce the same legs twice

`inboundRecipientName` is computed independently of `revealed` at
`dashboard/src/routes/contact/Timeline.tsx:976-987`, and its named,
screen-reader-only `role="group"` remains rendered at
`dashboard/src/routes/contact/Timeline.tsx:1051-1053`.  On the same inbound Relay
bubble, a pointer reveal mounts the named recipient `<ul>` and its per-recipient
`<li>` rows at `dashboard/src/routes/contact/Timeline.tsx:1075-1115`.

The group name is generated from the exact same `recipientRows`, delivery state,
transport and recipient-time data as those rows.  Thus, after reveal, the
accessibility tree contains (1) the complete visually-hidden recital and (2) the
complete visible list recital.  A virtual-cursor screen reader user hears each
recipient fact twice.  The new test proves only the collapsed state; it never
clicks the bubble and therefore does not cover this state.

Make the hidden owner conditional on `!revealed` (while retaining it in the
collapsed state); once the `<ul>` exists it already exposes the same rows and
name.  Add a focused assertion that after reveal no named `group` summary
remains while the recipient list is present.

## Conforms / checked boundaries

- The incoming source chip is untouched: transport still comes exclusively from
  `presentMessageTransport` using the inbound message fields
  (`Timeline.tsx:834-851`).  The new group only describes leg rows.  The new
  test confirms `SMS` source output rather than `RCS -> SMS`.
- The summary uses the existing filtered `recipientEntries` / `recipientRows`,
  the parent schema discriminator for leg transport, and `recipientRowTime`;
  removed unattempted legs, queued-pending holds, and empty maps remain gated
  out by `showRecipients` (`Timeline.tsx:885-887, 924, 931-934`).
- Native carrier groups are excluded by `rosterKind === 'relay'`; the group-text
  Timeline caller passes `rosterKind="group_text"` in
  `dashboard/src/routes/conversation/GroupTextView.tsx:448-469`.  Direct rows
  cannot meet the inbound gate without a `relay_sender_key`, which the domain
  type documents as absent on 1:1 messages (`app/src/repos/messagesRepo.ts:969-975`).
- The existing parent-schema rule is retained: version-1 legs disclose normalized
  requested/actual transport, schema-absent legs disclose delivery facts but do
  not invent transport (`Timeline.tsx:985` and `recipientSummaryName:588`).
- No optimistic or outbound path is widened: the owner requires `!outbound`; a
  `queued_pending` source remains excluded by the shared recipient gate.

## Focused probe

`npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`

Exit 0: 1 file, 137 tests passed.  The command first hit a sandbox write denial
for Vite's temporary config and then passed unchanged with isolated-worktree
write access.
