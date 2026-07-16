---
id: mms-attach-unit-photos
title: Attach unit photos to an outbound MMS (unit.media are external URLs -- hotlink caveat)
type: improvement
severity: low
status: open
area: app+dashboard
created: 2026-07-08
refs: docs/superpowers/specs/2026-07-08-outbound-mms-design.md, app/src/routes/mediaUploads.ts
---

**Problem.** A common need is to text a tenant the photos of a unit we are showing. The
outbound-mms feature (v1) sources media only from a device upload; it does not let staff
pick a unit's existing photos to attach.

**The caveat that makes this non-trivial.** `unit.media` are free-form EXTERNAL URLs
(operator-pasted listing links / photo hosts), NOT objects in our private media bucket.
They carry no size guarantee, no content-type guarantee, and are hotlink-fragile (the host
can 404, rate-limit, or serve something unexpected at fetch time). Twilio fetches the
MediaUrl we hand it; pointing Twilio directly at an arbitrary external URL is exactly the
posture the outbound-mms security model avoids (the send contract deliberately confines
Twilio to presigned uploads/ keys we minted). So we cannot simply forward a unit.media URL.

**Suggested fix.** Add a mirror-to-our-bucket step: when staff pick a unit photo, fetch it
server-side (with the same SSRF/host-allowlist + size cap posture as the inbound mirror),
store it under uploads/<uuid> (or a units/ namespace), then send via the existing
presign-per-attempt attachmentKeys path. Alternatively, accept the flakiness and hotlink
directly -- NOT recommended (breaks the private-bucket + no-arbitrary-fetch guarantees and
delivers unreliably). Document whichever is chosen; the mirror step is the clean answer.

**Update 2026-07-15 (unit-photos prerequisite now exists).** The property-photos feature
(docs/superpowers/specs/2026-07-15-unit-photos-design.md) landed the missing piece: staff
now UPLOAD unit photos into our OWN private media bucket under the dedicated
`unit-media/<unitId>/<uuid>` prefix, so a unit's photos are durable S3 keys -- not external
URLs. The external-URL / hotlink caveat above is now OBSOLETE for uploaded photos: attaching
one to an outbound MMS no longer needs a mirror step, just a presign-per-attempt of the
existing key (the same path device uploads already use). Legacy absolute-URL `unit.media`
entries (the vestigial mockup-era case) still carry the caveat, but new photos do not.
This issue stays open for the pick-and-attach UI + send wiring; the storage blocker is gone.
