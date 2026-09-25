---
id: relay-retry-bubble-row-reads-plain-delivered
title: A delivered relay retry bubble's recipient row reads "Delivered" while its chip reads "delivered 1/1 on retry"
type: improvement
severity: low
status: open
area: dashboard/messaging
created: 2026-09-24
refs: dashboard/src/routes/contact/Timeline.tsx:1077, dashboard/src/routes/contact/deliveryStatus.ts:585, dashboard/src/routes/contact/deliveryStatus.ts:668, dashboard/src/routes/contact/deliveryStatus.ts:741, docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/handback.md
---

**Problem.** When a relay 30003 retry delivers, the retry renders as its own
bubble in the thread (spec D22). On that bubble the two positions disagree:

- the summary chip reads `delivered 1/1 on retry` - the chip presenter is told
  it is a retry row (`retryRow: msg.relay_retry_of !== undefined`,
  `Timeline.tsx:1077`, honored at `deliveryStatus.ts:585`);
- its own per-recipient row reads plain `Delivered` - `presentLegDelivery`
  (`deliveryStatus.ts:668`) returns `Delivered on retry` only when the slot's
  `retryState` is `delivered-on-retry` (`:741`), and the join buckets rungs
  under the ROOT id, so the retry bubble's own leg carries no `retryState`.

The ORIGINAL bubble is already consistent: its row for that member reads
`Delivered on retry`. Raised as open question Q5 in the relay-30003 handback
(code review R1, finding C6); cosmetic.

**Suggested fix.** Cameron's ruling (2026-09-24): update the text so the retry
bubble's row reads `Delivered on retry`, matching its own chip and the original
bubble's row. Give the row presenter the same retry-row signal the chip already
gets, and pin the string at both positions on the retry bubble in
`Timeline.delivery.test.tsx`. Leave the native group-text rows unchanged: the
shared `Delivered` label also serves that product.
