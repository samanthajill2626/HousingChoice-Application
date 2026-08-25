---
id: inbound-multi-party-bubbles-have-no-per-recipient-delivery
title: Per-recipient delivery is outbound-only, so a dropped leg of a member's relay message shows nothing
type: improvement
severity: med
status: open
area: dashboard/contact-timeline
created: 2026-08-24
refs: dashboard/src/routes/contact/Timeline.tsx:888 (showRecipients), dashboard/src/routes/contact/Timeline.tsx:874 (deliveredSummary), dashboard/src/routes/contact/Timeline.tsx:840 (optedOutCount), app/src/routes/webhooks/twilio.ts:610, app/src/jobs/relayFanOut.ts:708, dashboard/src/routes/contact/Timeline.test.tsx:737
---

**Problem.** The per-recipient delivery breakdown shipped by
`feat/per-recipient-delivery` (2026-08-24) renders on OUTBOUND bubbles only. Its
gate is one predicate that begins with `outbound`:

```
const showRecipients =
  outbound && recipientEntries.length > 0 && msg.delivery_status !== 'queued_pending';
```

(`showRecipients`, `Timeline.tsx:888-889`; the rollup chip's own gate
`deliveredSummary`, `:864-865`, starts the same way). That `outbound` is inherited
from the rollup, and it is NOT a no-op on this map:

- An INBOUND relay source message carries a real, populated fan-out map.
  `app/src/routes/webhooks/twilio.ts:610` seeds it (`deliveryRecipients: {}` on
  the inbound append, with the comment explaining that DynamoDB forbids seeding a
  map and a child in one expression), and the fan-out fills the slots as it
  relays that member's message on to everyone else
  (`app/src/jobs/relayFanOut.ts:708`, `messages.setRecipientDelivery`).
- `dashboard/src/routes/contact/Timeline.test.tsx:737-752` pins exactly that
  shape on an INBOUND fixture (`...MESSAGE_IN` with a two-slot
  `delivery_recipients` map), and `:718-731` pins the plural case.

So on member-authored relay traffic - most of a relay group's volume - there is
no rollup, no escalation and no list. If a member's message is the one silently
dropped on one leg, the dashboard shows nothing at all. That is the same class of
blindness as the incident that produced this feature
([`mms-silent-drop-dish-textnow`](./mms-silent-drop-dish-textnow.md)), just on
the inbound side of the same map.

**Why it was deferred, and why it is CHEAPER THAN IT LOOKS.** It was cut for
scope and review budget, by explicit human decision, not for a mechanism reason.
The mechanism argument that was made against it in an earlier design draft was
wrong, and this is the part a future reader will not rediscover:

- **Widening the LIST's gate renders no new chip.** An earlier draft said
  dropping `outbound` "would newly render a chip on inbound bubbles". That is
  true of the ROLLUP (`deliveredSummary`, `Timeline.tsx:874`) and false of the
  LIST: after this branch the list's gate is evaluated INDEPENDENTLY of the
  rollup's value (the "THE LIST'S GATE" comment and `showRecipients`,
  `Timeline.tsx:882-889`, the whole point of that fix). Dropping `outbound` from
  the LIST's gate alone would add rows only - and those rows live inside a
  disclosure that is closed by default (the `showRecipients && revealed` guard on
  the recipient `<ul>`, `Timeline.tsx:1010-1011`), so a collapsed
  inbound bubble would look byte-identical to today.
- **Per-recipient information ALREADY ships on inbound multi-party bubbles.** The
  opt-out note is not outbound-gated: `optedOutCount` reads the same map with no
  direction check (`Timeline.tsx:840-842`) and the note renders at `:1047-1067`,
  and it is pinned on INBOUND fixtures (`Timeline.test.tsx:737`, `:754`). A
  revealed row list would not be a new CLASS of statement on an inbound bubble -
  it is the same class of statement, with names.

**Suggested fix.** Drop `outbound` from `showRecipients` (`Timeline.tsx:888`) and
leave the rollup chip's gate (`deliveredSummary`, `:864`) alone, so an inbound
multi-party bubble gains rows behind its existing reveal and gains no new chip.
Decide deliberately
whether the per-leg staleness escalation should apply on the inbound side (the
row presenter is direction-agnostic today), and extend
`Timeline.delivery.test.tsx` with an inbound fixture - the existing inbound
fixtures at `Timeline.test.tsx:737`/`:754` are the shape to copy.
