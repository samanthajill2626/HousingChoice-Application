# Task 11 fix-wave 1 re-review

Reviewed `043f1197 fix: preserve legacy recipient transport copy` against
`78d2dc13`.

## P1: Legacy recipient transport is still falsely announced on the collapsed delivery chip

`MessageBubble` gates `presentRecipientTransport` by the parent
`msg.transport_schema_version` only while rendering revealed list rows
(`dashboard/src/routes/contact/Timeline.tsx:1069-1075`).  The always-rendered
delivery-chip accessible name is independently assembled by
`recipientSummaryName`, which still calls `presentRecipientTransport(row.slot)`
without that parent discriminator (`dashboard/src/routes/contact/Timeline.tsx:570-598`).
Both `rollupName` and the all-opted-out `messageChipName` call that helper
(`dashboard/src/routes/contact/Timeline.tsx:935-965`).

Consequently, schema-absent Relay and native group rows retain an unsupported
`Unknown` transport claim for screen-reader users even though their revealed
row text is now correct.  This violates the accepted adjudication that legacy
delivery text and accessible names remain exact, and means the parent schema is
not the sole legacy discriminator at every recipient presentation surface.

Empirical proof: `npm run test -w @housingchoice/dashboard --
src/routes/contact/Timeline.delivery.test.tsx` exited 1 (18 passed, 4 failed).
Three failures are this omission: the attachment-recipient accessible summary,
the normal Relay rollup accessible summary, and the all-opted-out native-group
message-chip accessible summary.  In each received name, every legacy
recipient gains `, Unknown`.

Required correction: pass the parent schema version (or a parent-derived
`includeRecipientTransport` boolean) into `recipientSummaryName` and apply the
same `=== 1` gate before calling `presentRecipientTransport`.  Keep the present
version-1 behavior intact: absent recipient facts must still announce `Unknown`.
Add exact accessible-name controls for schema-absent Relay and native group,
beside the existing version-1 unresolved control.

## P1: The focused per-recipient suite remains red on an inbound Relay assertion that contradicts the feature contract

The same focused run also fails
`Timeline.delivery.test.tsx:418-435`: it expects an inbound Relay source with
recipient slots to reveal no list.  The shipped list gate deliberately permits
it when `relay_sender_key` is present (`Timeline.tsx:926-929`), and the approved
presentation contract explicitly allows progressively populated inbound Relay
recipient disclosure (spec section 9.4).  `Timeline.test.tsx:1474-1531` already
asserts that the list is revealed for exactly that kind of inbound source.

This contradictory older assertion is unchanged by `043f1197` (it was already
present at `78d2dc13`), so it is not introduced by the correction.  It is still
a branch blocker and must be rewritten to assert the contractual inbound
disclosure rather than no list.

## Closure and non-regression evidence

- The corrected revealed-row gate is sound: it is parent-schema based, not
  field-presence based, so version-1 slots with no transport facts still render
  `Unknown`; its added control passes.
- `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`
  exited 0: 135 passed.  This includes the three fix-wave controls, version-1
  inbound/outbound presentation, Relay recipient disclosure, excluded/suppressed
  behavior, and native group attribution.
- The gate is local to recipient transport rendering.  It does not alter
  `presentMessageTransport`, which handles legacy message rows and returns
  `EMAIL`/`CALL` before reading schema (`dashboard/src/lib/messageTransport.ts:70-72`);
  direct message meta, call cards, and email cards are not masked by it.

Verdict: NOT CONFORMS.  Fix both P1 findings, then rerun the two focused Timeline
test files.
