---
id: unit-photo-confirm-headobject-amplification
title: "Unit-photo confirm route has no rate limiter; up to 100 HeadObjects per authed call"
type: improvement
severity: low
status: resolved
area: app
created: 2026-07-15
resolved: 2026-07-21
refs: app/src/routes/units.ts
---

**Problem (review NOTE, 2026-07-15).** `POST /api/units/:id/photos/confirm`
carries no per-user rate limiter (by design, matching the unit PATCH posture),
but unlike PATCH it performs up to `UNIT_MEDIA_MAX` (100) `HeadObject` calls
per request - one per own-prefix key that isn't already on the unit. An authed
VA could send 100 own-prefix keys that all miss and drive ~100 S3 HeadObjects
per call. It is bounded (`rawKeys.length > UNIT_MEDIA_MAX -> 400` up front,
before any Head), authed-staff-only, and HeadObject is cheap - so this is a
mild authenticated amplification, not an availability risk today.

The PRESIGN route already has a 30/min limiter (`unit_photo_presign`); confirm
does not. Under the normal flow a confirm follows a presign 1:1, so the presign
limiter indirectly paces confirms - but a direct confirm caller bypasses that.

**Suggested fix.** Add a matching `createUserRateLimit` (routeKey
`unit_photo_confirm`, ~30/min) to the confirm route, mirroring presign. Cheap,
symmetric, closes the direct-caller gap. Not merge-blocking.

**Update (2026-07-21, unit-photo-transcode).** The "HeadObject is cheap ... not
an availability risk today" premise no longer holds: the transcode feature makes
confirm the app's MOST expensive endpoint - a >5MB source is downloaded and
sharp-transcoded behind the SHARED 2-slot gate (now shared with MMS confirm), so
an unfenced caller can pin both slots + both cores and 503 everyone else. The
limiter went from "not merge-blocking" to load-bearing.

**Resolution (2026-07-21).** Added `createUserRateLimit` (routeKey
`unit_photo_confirm`) to `POST /api/units/:id/photos/confirm` in
app/src/routes/units.ts, mounted before the handler like the presign limiter.
Sized at 30/min per user (presign's mint pace): unlike the MMS confirm
(1-2 attachments per message, 20/min), photo confirms are BULK BY DESIGN -
D5 chunking sends each >5MB file in its own request, and a transcode-bearing
confirm takes >=~2s end to end, so a real serial client tops out around
30/min. The fence kills scripted tight loops without tripping the
dashboard's own pace. Covered by the `MF-2a` limiter test in
app/test/unitsApiPhotos.test.ts.
