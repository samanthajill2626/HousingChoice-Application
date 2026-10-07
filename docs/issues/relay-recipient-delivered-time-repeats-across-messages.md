---
id: relay-recipient-delivered-time-repeats-across-messages
title: One Relay member's per-recipient delivered time repeats (5:29a) across many inbound messages
type: bug
severity: med
status: open
area: dashboard
created: 2026-10-06
refs: dashboard/src/routes/contact/Timeline.tsx:1235
---

**Problem.** Seen live on 2026-10-06 on placement
`placement-bb9a14b2-69fe-4912-8853-ae36fb28bea7` (a three-member Relay group).
The hidden "Delivery by recipient" summaries on its inbound bubbles show one
member (Robert Esther) as "Delivered, SMS, 5:29a" on nine consecutive inbound
messages, while the other member's delivered time on the same messages runs
from 9:35a to 3:33p and appears to span more than one day. A later run of
messages repeats "5:22p" the same way.

Cameron notes three messages to that member failed first and were delivered on
a retry, which can explain a few shared catch-up times, but not this many. The
open question is whether each recipient row reads its own message's delivery
leg, or reuses another message's leg or receipt timestamp (projection, retry
adoption, or receipt-to-slot matching).

**Suggested fix.** Diagnose first, from data. Pull the message rows and their
per-recipient slots for that conversation and compare each slot's delivered
timestamp with its own provider receipt. Decide from that whether the stored
data or the rendering is wrong. Ask Cameron for the evidence rather than
querying prod directly.
