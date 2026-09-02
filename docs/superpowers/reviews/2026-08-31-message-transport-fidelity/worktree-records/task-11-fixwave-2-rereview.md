# Task 11 fix wave 2 rereview

## Reviewed range

`6270d2cb fix: align recipient transport accessibility` against `1190e180`.

## P1: Collapsed delivery summaries omit each recipient's per-leg time

`recipientSummaryName` is the only accessible path to the collapsed recipient
disclosure: the bubble's reveal interaction has no keyboard path.  The helper
recites the recipient identity and delivery/transport state, but it never uses
`RecipientRow.when` (`Timeline.tsx:582-598`).  `when` is calculated from the
leg's `deliveredAt` or `sentAt` at `Timeline.tsx:496-500,526` and is included
in the expanded row's accessible name at `Timeline.tsx:1082-1086`.  Therefore a
collapsed screen-reader user cannot learn the time of a delivered/sent leg even
though it is a rendered per-recipient fact and the component explicitly says the
chip name must supply the same per-recipient facts (`Timeline.tsx:551-564,
1038-1045`).

This remains reachable after the correction: a version-1 or legacy relay/native
group slot with `deliveredAt`/`sentAt` receives a row time, while the matching
rollup `aria-label` contains only the headline, identity, delivery state, and
(when version 1) transport.  The new exact accessibility regressions at
`Timeline.test.tsx:1360-1431` exercise identity/status/transport but use
clockless slots, so they cannot detect the omission.

Required correction: append the already formatted `row.when` to each
`recipientSummaryName` recital when non-empty, using the same accessibility
separator convention, and add a collapsed-chip regression whose slots carry
distinct `deliveredAt` and `sentAt`.  Cover both the ordinary rollup and the
all-opted-out/message-chip branch if a leg time can be retained there.

## Confirmed closures and conforming behavior

- **Legacy recipient summaries:** `Timeline.tsx:588,945,966` now permits
  recipient transport only when the parent has `transport_schema_version === 1`.
  The expanded-row boundary has the identical parent-schema guard at
  `Timeline.tsx:1072-1078`.  Legacy Relay and native Group MMS exact collapsed
  accessibility assertions at `Timeline.test.tsx:1360-1405` contain no
  inferred `Unknown`.
- **Version-1 unresolved recipient facts:** the same guard still calls
  `presentRecipientTransport` for a version-1 parent, whose no-fact result is
  `Unknown` (`dashboard/src/lib/messageTransport.ts:59-76`).  The exact
  collapsed and revealed control at `Timeline.test.tsx:1407-1431` proves it.
- **Inbound Relay disclosure:** `showRecipients` still requires a non-empty
  filtered slot map, no `queued_pending` hold, and either outbound direction or
  `relay_sender_key` (`Timeline.tsx:927-930`).  Relay inbound persistence seeds
  that map and sender key (`app/src/routes/webhooks/twilio.ts:614-631`), while
  inbound native group persistence deliberately has no map (`twilio.ts:1729-1744`).
  The corrected test at `Timeline.delivery.test.tsx:418-439` proves the
  permitted inbound Relay leg disclosure; no main-chip aggregation occurs because
  `deliveredSummary` remains outbound-only (`Timeline.tsx:913-919`).
- **No unrelated modality regression:** only the Timeline recipient-summary
  helper/callers and focused tests changed.  `presentMessageTransport` continues
  to return `CALL`/`EMAIL` before the schema branch
  (`dashboard/src/lib/messageTransport.ts:111-131`), and the message component
  routes email to a separate card before multi-recipient rendering
  (`Timeline.tsx:780-784`).

## Focused verification

`npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.delivery.test.tsx`

Exit 0: 2 files passed, 157 tests passed.  This confirms the current assertions,
but does not exercise the P1 timestamp case above.
