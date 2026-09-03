---
id: relay-inbound-source-has-no-delivery-rollup
title: A member-originated relay message shows nothing about who received it - the rollup chip and its accessible name are gated on outbound
type: bug
severity: med
status: open
area: dashboard
created: 2026-09-02
refs: dashboard/src/routes/contact/Timeline.tsx:837, dashboard/src/routes/contact/Timeline.tsx:934, dashboard/src/routes/contact/Timeline.tsx:948, app/src/routes/webhooks/twilio.ts:641, app/src/routes/webhooks/twilio.ts:744
---

**Problem.** When a relay group member texts the pool number, the message is
persisted as an INBOUND row (`app/src/routes/webhooks/twilio.ts:636-650`) and the
fan-out is enqueued against that row (`:744`). Every per-member delivery outcome -
sent, delivered, undelivered with a carrier code - is written into that inbound
row's `delivery_recipients` map, exactly as for a team send.

The dashboard does not show any of it. The rollup chip is gated on the bubble
being outbound (`dashboard/src/routes/contact/Timeline.tsx:934-940`, with
`outbound` defined at `:837`), and the accessible-name recital is derived from the
rollup, so it is absent too (`:957-968`). Only the per-recipient ROWS survive on
an inbound relay source (`:948-951`), and those are behind a click-to-reveal
(`:1092`) with no keyboard path.

So for the DOMINANT relay case - a member writing to the group - a failed leg is
invisible at a glance. A staff member scanning the thread sees a normal inbound
message and no indication that one of the other members never received it. The
same failure on a team-originated send renders
`delivered 3/4 - 1 failed - Phone unreachable (error 30003)`.

**Why it was found.** `feat/relay-30003-retry-lineage` designed a display contract
for relay retries and discovered mid-review that two of its three render positions
do not exist for inbound sources. Both adversarial reviewers found it
independently. The founder's 2026-09-02 ruling was to ship the retry for both
source directions - so a member's message that fails a leg IS now retried - while
leaving the visible contract where a rollup renders today, and to file this
separately rather than annex a new display design to that mission.

**Three surfaces, not one.** Any fix must cover all three hosts that mount the
shared relay Timeline over `useRelayThread`:

- `dashboard/src/routes/conversation/ConversationDetail.tsx:480`
- `dashboard/src/routes/tours/TourConversation.tsx:467` (note: passes a
  milestone-merged item list, not the raw thread)
- `dashboard/src/routes/placements/PlacementConversation.tsx:320`

**Suggested fix.** The hard part is not the gate, it is the COPY. An outbound
rollup answers "did the message I sent arrive"; an inbound one has to answer
something the product has never phrased - "how many of the other members received
what this person wrote". That needs a deliberate wording decision, and it must
read correctly in the accessible-name recital as well as the chip. Relaxing the
`outbound` gate without settling that would put a sender-shaped label on a
recipient-shaped fact.

Note also that the message-level chip is deliberately excluded from the relay
override (`Timeline.tsx:879-885`), and that an inbound bubble's visual language is
currently "received", so a danger-toned chip on it is a new visual state.

**Related.**
[`relay-30003-retry-lineage`](./relay-30003-retry-lineage.md) (RESOLVED
2026-09-02) - the mission that found this. Correcting what an earlier draft of
this line claimed: its retry runs for inbound sources AND renders on them - just
not as a chip, because there is no chip here to move. The gap this issue
describes is therefore unchanged. But the two positions that DO exist on an
inbound bubble - the per-recipient rows (`:948-951`) and the
`inboundRecipientName` recital - carry the new retry states exactly as they
carry today's: `Retrying - Phone unreachable (error 30003)`,
`Delivered on retry`, and the gate-refusal prose (`Not retried - group closed`,
`Not retried - no longer in this group`, `Not retried - number changed since`,
`Not retried - opted out`). Leaving them out would have shipped a recital that
recites `Undelivered - Phone unreachable (error 30003)` for ever on a leg whose
retry delivered - strictly worse than today.
[`relay-hub-message-delivery-status-never-terminal`](./relay-hub-message-delivery-status-never-terminal.md)
- the adjacent complaint that a relay source's MESSAGE-level status never
advances.
