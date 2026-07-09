---
id: relay-source-message-sending-chip
title: Relay source message shows a permanent "Sending..." chip next to "delivered N/M"
type: bug
severity: low
status: resolved
area: dashboard
created: 2026-07-08
resolved: 2026-07-09
refs: dashboard/src/routes/contact/Timeline.tsx:235, dashboard/src/routes/contact/Timeline.tsx:250, dashboard/src/routes/conversation/ConversationDetail.tsx:404, dashboard/src/routes/tours/TourConversation.tsx:220, app/src/routes/webhooks/twilio.ts:803
---

**Problem.** In a relay-group transcript, an outbound team message renders BOTH
the optimistic-looking "Sending..." status chip AND the per-member
"delivered N/M" summary at the same time, and the "Sending..." persists forever
(it survives a full page reload). Observed during tour-detail-page live QA
(phase 2.5) on the tour page's Group tab with a fully delivered fan-out
("Sending..." next to "delivered 2/2"), but it is SHARED relay-Timeline
behavior, not tour-page-specific:

- A relay fan-out sends N provider messages but persists NONE of them as their
  own rows; their delivery outcomes land in the SOURCE message's
  `delivery_recipients` map (app/src/routes/webhooks/twilio.ts relaysid-pointer
  path). Nothing ever advances the source row's OWN `delivery_status`, so it
  stays at its initial `queued` for the life of the message.
- The shared `MessageBubble` (dashboard/src/routes/contact/Timeline.tsx)
  renders the per-message status chip from `delivery_status`
  (`queued` -> "Sending...") AND, independently, the "delivered N/M" summary
  derived from `delivery_recipients`. For a relay source message both render,
  contradicting each other for the reader.
- Both relay consumers pass the identical prop set (status/items/source/
  canSend/onSend/relayRoster/relayClosed/resetScrollKey) and exhibit the same
  rendering: ConversationDetail's RelayGroupView (/conversations/:id) and the
  tour page's Group tab (TourConversation GroupChannel). There is no Timeline
  prop that suppresses the source-status chip, so neither consumer can opt out.

**Suggested fix.** In MessageBubble, suppress the `delivery_status` chip when
the bubble has a `deliveredSummary` (an outbound relay SOURCE message): the
per-recipient summary is the truthful delivery state, and the source row's own
`queued` is a bookkeeping artifact. One-line guard, e.g. render the status chip
only when `deliveredSummary === null`. Fixes both consumers at once; 1:1
bubbles (no `delivery_recipients`) are unaffected.

**Resolution (2026-07-09).** Implemented the suggested guard in MessageBubble
(dashboard/src/routes/contact/Timeline.tsx): the per-message `delivery_status`
chip renders only when `deliveredSummary === null`, so a relay source bubble
shows only the truthful "delivered N/M" rollup. Covered by a regression test in
Timeline.test.tsx ("suppresses the per-message status chip on a relay source
bubble"). 1:1 bubbles are unchanged (they have no `delivery_recipients`).
