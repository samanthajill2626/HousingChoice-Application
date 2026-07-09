---
id: outbound-mms-send-path
title: No product path to SEND MMS (outbound media) — backend seam exists, no UI/route
type: improvement
severity: med
status: resolved
area: app
created: 2026-07-01
resolved: 2026-07-08
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

**Resolution (2026-07-08).** Built by the outbound-mms feature on branch feat/outbound-mms
(spec: docs/superpowers/specs/2026-07-08-outbound-mms-design.md). Shipped end to end:

- New authed streaming upload endpoint POST /api/media/uploads (busboy -> MediaStore.put to
  uploads/<uuid>, inline-type allowlist, 5MB/file via stream abort, own 30/min rate limiter).
- MediaStore.presign(key, ttl) + head(key) added (s3-request-presigner confined to that one
  adapter module; MinIO path-style presign verified in the hermetic stack in Phase 0).
- Send route gains attachmentKeys[] (regex ^uploads/[0-9a-f-]+$, max 10, HeadObject each,
  <=5MB total, types re-checked); server presigns fresh per attempt and PERSISTS
  media_attachments [{s3Key, contentType}], so sent media renders through the existing authed
  serve endpoint + timeline pipeline with zero render-side changes.
- The PRESIGN-PER-ATTEMPT rule (Cameron): presigned URLs are never persisted-as-truth or
  replayed. The retry route re-presigns from media_attachments s3Keys (pinned by a unit test
  proving retried URLs differ from originals and derive from the keys). Relay fan-out presigns
  PER LEG at leg-send time. Presigned URLs are never logged (s3Key + count only).
- Composer: the shared Timeline composer gains an attach control + upload-on-select chip row
  (progress/remove/error), client caps mirroring the server, widened onSend(body,
  attachmentKeys?); all five consumers updated; chips ride the same keyed-remount isolation as
  the text draft.
- Relay media both directions: team MMS legs and member-inbound photos now forward media;
  media-only relays use the new message-catalog entry relay.media_only.

**Accepted leftover (known, v1):** uploads/ objects that are never attached to a send are
orphans. They are private, small (<=5MB), and capped; v1 accepts them. A future bucket
lifecycle rule (expire unattached uploads/ after N days) is the clean cleanup -- deliberately
NOT filed as a separate issue, noted here as an accepted leftover.

**Deferred scope:** broadcast MMS is out of scope for this feature (filed as
[[broadcast-mms]], partly to avoid colliding with in-flight broadcasts work). Two source
follow-ups filed: [[mms-forward-received-media]] and [[mms-attach-unit-photos]] (the latter
documents the external-URL hotlink caveat for unit.media).
