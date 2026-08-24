---
id: relay-all-opted-out-message-chip-stuck-sending
title: A relay message whose members all opted out shows the queued "Sending" chip for ever
type: bug
severity: low
status: open
area: dashboard/contact-timeline
created: 2026-08-24
refs: dashboard/src/routes/contact/Timeline.tsx:920, dashboard/src/routes/contact/deliveryStatus.ts:294, dashboard/src/routes/contact/deliveryStatus.ts:118, dashboard/src/routes/contact/deliveryStatus.ts:42, app/src/routes/api.ts:1783, app/src/jobs/relayFanOut.ts:456
---

**Problem.** On a relay group where EVERY member has opted out, the message-level
delivery chip claims a send is in progress, permanently, for a message that was
sent to nobody. The chip reads the `queued` label (`Sending` followed by an
ellipsis, `deliveryStatus.ts:42`) and never changes, including across a full
reload.

The mechanism is three facts that only combine in this one case:

1. The relay source message is persisted `deliveryStatus: 'queued'`
   (`app/src/routes/api.ts:1783`) and **the relay fan-out never moves the PARENT
   status**. Per-leg outcomes land in `delivery_recipients` slots and nothing
   writes the parent's own `delivery_status` (there is no `delivery_status` write
   anywhere in `app/src/jobs/relayFanOut.ts`), so it stays `queued` for the life
   of the message.
2. `presentDeliveryStatus` escalates a quiet `sent` and ONLY a quiet `sent`
   (`deliveryStatus.ts:118`), so an aged `queued` never becomes
   "not confirmed" - it stays `Sending`.
3. `presentRelayDelivery` returns `null` when every leg carries
   `contact_opted_out` (`deliveryStatus.ts:294-295`: the opted-out legs are
   filtered out, and `fanned.length === 0` returns null), which is precisely the
   all-opted-out shape the fan-out writes
   (`app/src/jobs/relayFanOut.ts:456-459`). With no rollup, the guard that
   normally suppresses the parent chip (`Timeline.tsx:920`,
   `delivery && deliveredSummary === null`) lets the stale `queued` chip render
   as the bubble's only delivery statement.

**This is exactly the hole left by the fix in
[`relay-source-message-sending-chip`](./relay-source-message-sending-chip.md)**
(resolved 2026-07-09). That issue's shipped guard was "render the per-message
status chip only when `deliveredSummary === null`", which correctly hides the
bookkeeping `queued` whenever a rollup exists. The all-opted-out branch is the
one case where `deliveredSummary` is null for a reason OTHER than "no fan-out
map", so the guard does the opposite of what it was written to do.

Found during the `feat/per-recipient-delivery` design (2026-08-24). Pre-existing;
deliberately not fixed there.

**What that branch DID do about it.** It fixed the ACCESSIBLE half only. On a
branch-0 bubble (a non-empty map, outbound, not a `queued_pending` hold, and a
null rollup - i.e. all legs opted out) the message-level chip now carries
`role="img"` and an accurate `aria-label` naming the recipients
(`Timeline.tsx:873-885` computes it, `:920-932` renders it). An accessible name
SUPERSEDES the visible text for assistive technology, so a screen-reader user
already hears the truth. **The remaining half is the visible chip**, which still
says the message is sending.

**Suggested fix.** Two candidates, and the choice is a product call:

1. Fix it at the source - have the fan-out write a terminal parent
   `delivery_status` when it fans out to nobody, so every reader (chip, inbox
   preview, any future consumer) sees the same truth. Bigger blast radius; needs
   the aggregate-derivation rules checked against
   `app/src/services/groupReceipts.ts` `rollUpAggregate`.
2. Fix it at the bubble - widen the `Timeline.tsx:920` guard so the parent chip
   is suppressed on any bubble with a non-empty `delivery_recipients` map, not
   just one with a non-null rollup, and let the opted-out note
   (`Timeline.tsx:989-1009`) plus the revealed rows carry the statement. Smaller,
   and it matches the branch-0 predicate the accessible name already uses.
