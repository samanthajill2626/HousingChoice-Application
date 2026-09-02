# Task 11 fix wave 3 rereview

Reviewed `e8d747f8 fix: include recipient times in accessibility` against
`baf6f6a7`.

## P1: Collapsed inbound Relay bubbles still hide all recipient disclosure from screen readers

The correction completes the outbound rollup and all-opted-out branches, but an
inbound Relay source has a reachable recipient list with no always-rendered
accessible equivalent. `showRecipients` admits an inbound message when it has a
`relay_sender_key` (Timeline.tsx:931-934), but the list is rendered only after
the mouse-only `revealed` state becomes true (Timeline.tsx:982-986 and
1057-1107). The bubble is a plain `div` with `onClick`, no keyboard semantics.

No chip is eligible to receive the existing summary on this path:

- `delivery` is outbound-only (Timeline.tsx:867-869), and so is
  `deliveredSummary` (Timeline.tsx:917-923).
- The rollup name requires a non-null `deliveredSummary` (Timeline.tsx:940-951).
- The message-chip name requires a non-null `delivery` (Timeline.tsx:961-972).

This is not hypothetical or an unsupported wire shape. The existing version-1
inbound Relay regression creates `relay_sender_key` plus recipient slots
(Timeline.test.tsx:1486-1525) and proves the rows only after it clicks the
bubble (Timeline.test.tsx:1527-1543). Consequently, an initial collapsed
inbound Relay bubble exposes neither recipient identity, status, transport, nor
the newly corrected `sentAt`/`deliveredAt` time to a screen-reader user. That
breaks the specification's inbound-Relay recipient-disclosure contract while
leaving the main chip's inbound actual-only transport rule unfulfilled at the
accessibility boundary.

Fix without making recipient legs replace the inbound source chip. Add an
always-rendered accessible disclosure for this inbound path, built from the
same filtered rows and formatted `row.when` as the revealed list. Cover a
version-1 inbound Relay source with one recorded leg time and one absent time:
before interaction, it must expose every visible-leg identity/status/transport,
include the recorded time exactly once, omit the absent time, and retain the
inbound main transport as actual-only. That test fails at `e8d747f8` because no
matching accessible owner is rendered until the click.

## Confirmed parts of the correction

- Outbound rollup and all-opted-out summaries append the existing formatted
  `RecipientRow.when` only when non-empty (Timeline.tsx:589-600), while the
  revealed row renders that same value only when non-empty (Timeline.tsx:1086-1103).
  It therefore does not fabricate a message-level time or duplicate the leg
  time within one accessible name.
- The value remains the leg's `deliveredAt`, otherwise its `sentAt`, and invalid
  values format to an empty string (Timeline.tsx:482-500).
- Recipient transport remains gated by parent schema version in both collapsed
  and revealed paths (Timeline.tsx:588 and 1076-1082), preserving legacy
  recipient transport behavior. Direct messages without a recipient map still
  receive no delivery-summary role (Timeline.delivery.test.tsx:548-566).

## Verification note

I attempted the focused `Timeline.delivery.test.tsx` Vitest file only. The
environment denied Vite's temporary config write with `EPERM` under
`dashboard/node_modules/.vite-temp`; no test result is attributable to the
change. No e2e or broad suite was run.
