---
id: outbound-mms-send-path
title: No product path to SEND MMS (outbound media) — backend seam exists, no UI/route
type: improvement
severity: med
status: open
area: app
created: 2026-07-01
refs: app/src/adapters/messaging.ts:42, app/src/services/sendMessage.ts:115, dashboard/src/routes/contact/Timeline.tsx
---

**Problem.** The system can RECEIVE MMS (inbound media is fetched with auth, SSRF-guarded,
size-capped at 25 MB, mirrored to S3, and shown in the timeline / "Media from comms" gallery),
but there is **no product path to SEND an MMS**. The Team can only send text today.

**What exists (backend seam is ~90% there).**
- Adapter: `SendMessageParams.mediaUrls: string[]`, and the Twilio driver passes `mediaUrl` to
  Programmable Messaging (`app/src/adapters/messaging.ts`). The console driver logs `mediaCount`.
- Send service: `services/sendMessage.ts` accepts `mediaUrls`, persists them, and stamps the
  message `type: 'mms'` when present (`sendMessage.ts:115` / `:259`).

**What's missing.**
1. **No attach-media affordance** in the dashboard reply composer — a Team member cannot add a
   photo/document to an outbound reply.
2. **Confirm the reply HTTP route plumbs `mediaUrls`** from the request body into the send
   service (the service supports it; the route may not expose it).
3. An upload path (file → S3 → a `mediaUrls` value the send accepts) and rendering of sent media
   in the timeline (the inbound gallery already renders media, so this is likely reusable).

**Why it matters.** Landlord/tenant comms sometimes need outbound media (sending a flyer image,
a form, a photo). It's a genuine capability gap despite the backend being mostly ready.

**Suggested fix.** Plumb `mediaUrls` end-to-end on the send route, add an attach-media control to
the reply composer with an upload → S3 step, and mirror the inbound 25 MB / host-safety limits.

Discovered during the landlord-onboarding sequence work (property intake has the landlord texting
photos; the reverse — us sending media — has no path). Related: [[inbound-media-attach-to-unit]],
[[unit-create-and-mms-media-ui]].
