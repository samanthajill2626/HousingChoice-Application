---
id: relay-hub-message-delivery-status-never-terminal
title: A team-send relay hub message sits at delivery_status 'queued' forever - there is no relay rollup that ever advances it
type: bug
severity: med
status: open
area: app
created: 2026-09-01
refs: app/src/routes/api.ts:1794, app/src/repos/messagesRepo.ts:121, app/src/routes/webhooks/twilio.ts:2353, dashboard/src/routes/contact/Timeline.tsx:862
---

**Problem.** A team send into a relay group appends ONE hub (source) message row
with `deliveryStatus: 'queued'` (`app/src/routes/api.ts:1794`) and then fans out
one leg per member. Every carrier receipt for those legs lands in the hub row's
`delivery_recipients` SLOTS - `handleRelayRecipientStatus`
(`routes/webhooks/twilio.ts:2353`) calls `updateRecipientDeliveryStatus`, which
writes child fields only. **No relay code path ever advances the hub row's own
`delivery_status`.** It sits at `queued` forever, including after every single
leg has failed.

This is VERIFIED, not suspected. It was checked during M5
(`feat/retry-counter-durable`, slice 3) precisely because the guess "the rollup
probably masks it" is the plausible wrong answer:

- there is no relay rollup at all in the app - `deriveGroupDeliveryStatus`
  (`services/groupDelivery.ts`) is called only from `groupReceipts.ts` and
  `groupSend.ts`, i.e. NATIVE GROUP TEXT;
- an INBOUND relay source is appended `delivery_status: 'delivered'` and never
  revisited, so only the team-send direction carries this;
- `closeRelay` - M5's new cap/enqueue-failure close - deliberately does not
  touch it either.

Today the DASHBOARD hides the symptom rather than the data being right: a
relay bubble that carries a `delivery_recipients` map renders the per-recipient
rollup chip INSTEAD of the message-level chip, and the message-level chip's own
comment says the source row's status "stays 'queued' forever" and is therefore
suppressed. So the wrong value is stored, and one consumer happens not to read
it. Anything else that reads a relay hub row's `delivery_status` - a query, an
export, a future surface, an operator on the item - is told the send is still
queued.

**The forward transition is already legal.** `ALLOWED_PRIOR.failed =
['queued','sent']` (`app/src/repos/messagesRepo.ts:121-130`), so
`updateDeliveryStatus(conversationId, tsMsgId, 'failed', code)` from `closeRelay`
would be accepted by the forward-only status machine. Nothing structural is in
the way.

**WARNING - taking this reaches a FIFTH render position, and that is why M5
filed it instead of shipping it.** M5's dashboard slices cover four positions
for a leg-scoped delivery reason: the relay rollup chip, the accessible-name
recital, the per-recipient row, and the broadcast results badge. Writing a
status AND an error code onto the hub row makes the MESSAGE-LEVEL chip
(`dashboard/src/routes/contact/Timeline.tsx:862`) live for relay for the first
time. That site is deliberately excluded from M5's relay override - it reads the
MESSAGE's `error_code`, and the only code that reaches it today is the
native-group-text aggregate, whose 30003 retry is real, so passing the relay
flag there would drop the promise from a group text that genuinely retries.

Concretely, a fix must decide BOTH of these before it writes anything:

1. **Which code goes on the hub row.** M5's two app-invented close codes
   (`transient_cap`, `enqueue_failed`) render as operator prose via
   `INTERNAL_CODE_REASONS`, which early-returns ahead of every other map - so
   they are safe at `:862` by construction. A CARRIER code (30003 and friends)
   is not: at `:862` it would print the base copy, retry promise included, on a
   relay message.
2. **Whether `:862` gets the relay flag**, and if so what that does to a native
   group text whose aggregate legitimately reaches the same site. That is the
   `T-DELIVERY-CHIPS` conversation, not a one-line change.

**Suggested fix.** Probably: have the relay path drive the hub row to a terminal
status when every leg is terminal (and from `closeRelay` when it closes the
remaining legs), carrying only an app-invented code that the internal-code map
already renders as prose. Pair it with a `:862` decision in the same change -
D21's rule that every render position for one fact must change together applies
here exactly as it did to the leg-scoped reason.
