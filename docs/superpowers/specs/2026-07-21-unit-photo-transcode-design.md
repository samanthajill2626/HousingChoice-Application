# Unit photo transcode: 20MB uploads, gentle server-side fit (design)

Date: 2026-07-21. Status: approved direction (Cameron), spec pending review.
Owner scope: app + dashboard. No terraform, no schema, no worker changes.

## Problem

Unit photo uploads are browser-to-S3 presigned POSTs whose policy enforces a
hard 1..5MB size range (app/src/adapters/mediaStore.ts createPresignedPost,
default from OUTBOUND_MMS_MAX_FILE_BYTES). Modern phone/camera photos
routinely run 4-12MB, so staff picking real listing photos intermittently hit
an S3-side 400 (EntityTooLarge) that surfaces only as the generic
"Uploaded N of M - some photos couldn't be uploaded" (the dashboard never
checks size client-side and drops per-file S3 failures anonymously:
dashboard/src/routes/listing/ListingDetail.tsx upload loop). Meanwhile the MMS
attachment path already accepts 20MB sources and auto-fits them at confirm
via the sharp transcode adapter - the display-asset path is stricter than the
SMS path, which is backwards.

Observed live on deployed dev 2026-07-21: 3-photo pick, 2 uploaded, third
400'd at S3.

## Decision summary (Cameron, 2026-07-21)

- Raise the photo presign cap to 20MB and transcode oversize sources at
  confirm, reusing the MMS transcode machinery (option 2 of the triage).
- Gentler target than MMS: long edge 2560px, jpeg quality 85 first, only
  stepping down while the encode is still over a ~3MB soft target.
- Only sources OVER 5MB are transcoded. Anything at or under 5MB passes
  through byte-identical - today's working uploads keep exactly today's
  behavior; the transcode touches only files that are rejected outright
  today.

## Design

### D1. Parameterized transcode profiles (adapter)

app/src/adapters/mediaTranscode.ts currently hard-wires the MMS targets
(TRANSCODE_TARGET_MAX_EDGE 1600, TRANSCODE_TARGET_MAX_BYTES 1.5MB, ladder
[82..42], SHARP_MAX_INPUT_PIXELS 24MP). Generalize: the image pipeline
(EXIF-rotate -> resize fit:'inside' withoutEnlargement -> mozjpeg quality
ladder) takes a profile { maxEdge, qualityLadder, targetMaxBytes,
maxInputPixels }. transcodeForMms keeps its exact current behavior by passing
the MMS profile (byte-identical outputs; existing tests unchanged). A new
transcodeForUnitPhoto(bytes, sourceType) passes the photo profile. PDF
handling stays MMS-only (photos allowlist has no pdf).

### D2. Photo profile constants

New app/src/lib/unitPhotoLimits.ts (beside outboundMediaLimits.ts, same
documentation style):

- UNIT_PHOTO_SOURCE_MAX_BYTES = 20MB   (presign policy cap)
- UNIT_PHOTO_PASSTHROUGH_MAX_BYTES = 5MB  (at/under: stored as uploaded)
- UNIT_PHOTO_TRANSCODE_MAX_EDGE = 2560
- UNIT_PHOTO_TRANSCODE_QUALITY_LADDER = [85, 78, 70]
- UNIT_PHOTO_TRANSCODE_TARGET_BYTES = 3MB  (soft target the ladder aims under;
  the lowest-quality result is kept if none qualifies, then re-checked against
  the 5MB stored-photo invariant - practically unreachable at 2560px)
- UNIT_PHOTO_SHARP_MAX_INPUT_PIXELS = 50_000_000  (48MP-class phone sources
  decode; ~200MB peak RGBA raster per slot, bounded by the shared 2-slot gate
  on the 2GB box; MMS keeps its 24MP cap)

### D3. Presign route

POST /api/units/:unitId/photos/presign passes maxBytes:
UNIT_PHOTO_SOURCE_MAX_BYTES to createPresignedPost (the opts.maxBytes seam
exists). Everything else - type allowlist (jpeg/png/gif/webp), batch max,
cap pre-check, limiter - unchanged.

### D4. Confirm route: per-key plan (mirrors MMS confirm)

POST /api/units/:unitId/photos/confirm already HeadObjects every key. Add the
plan step per key:

- size <= 5MB: today's path, unchanged. The uploaded key is appended as-is.
- size > 5MB (and <= 20MB; over rejects as today's size re-check does):
  acquire the SAME process-wide transcode gate MMS uses (one shared 2-slot
  memory bound + its wait-timeout -> 503 transcode_busy), getBytes,
  transcodeForUnitPhoto, put the jpeg rendition at a FRESH
  unit-media/<unitId>/<uuid> key, and append the RENDITION key. The original
  oversize object is left in place as an accepted orphan (same posture as
  photo removal; tracked in issue unit-photo-removal-never-deletes-s3-objects,
  which gains a note about this second orphan class).
- Corrupt/undecodable input: 400 transcode_failed for that request (matches
  MMS confirm semantics); the client's partial-upload handling already copes.

Renditions are indistinguishable from direct uploads (same prefix, uuid key,
image/jpeg): display resolution, the namespace guard, the public flyer, and
the future CloudFront read path need NO changes. Transparency (png) and
animation (gif) flatten to a jpeg still - only ever for >5MB sources,
acceptable for listing photos. Idempotent replay: passthrough keys replay as
today; a replayed >5MB key mints a second rendition (bounded by the photo cap
and the gate; accepted, matches the existing concurrent same-key confirm
posture).

### D5. Confirm chunking (CloudFront 30s origin timeout guard)

A confirm carrying many >5MB keys serializes transcodes behind the 2-slot
gate and could brush CloudFront's 30s origin_read_timeout. The dashboard
knows every file.size, so it chunks confirm calls: keys for files at/under
5MB are confirmed in one batch per wave (today's behavior); each file over
5MB is confirmed in its OWN confirm request (~one transcode per request).
Server-side the gate wait-timeout remains the backstop.

### D6. Dashboard pre-check + messaging

Before presigning a wave, files over 20MB are dropped from the selection with
a specific, named inline error ("kitchen.jpg is 27MB - the limit is 20MB";
multiple offenders listed). Remaining files proceed normally. The generic
"Uploaded N of M" alert stays as the catch-all for real S3/network failures.
Copy uses "photo(s)" (staff surface; glossary-neutral).

## Out of scope

- Backfill of existing photos (none over 5MB can exist - the old cap was
  policy-enforced from launch).
- Deleting oversize originals after rendition put (kept as orphans;
  unit-photo-removal-never-deletes-s3-objects covers cleanup thinking).
- MMS profile changes (its outputs stay byte-identical).
- CloudFront media reads (separate feature, handed off; composes - renditions
  are normal unit-media keys).
- The MMS composer attach path (already 20MB + auto-fit).

## Testing

- Adapter: profile plumbing (photo profile produces 2560-edge q85 output;
  never-enlarge below 2560; ladder stops at first result under target; MMS
  profile outputs unchanged), 50MP pixel-cap rejection.
- Confirm route: passthrough branch unchanged (<=5MB); transcode branch
  appends a fresh-uuid rendition key with image/jpeg (original key NOT
  appended); >20MB head rejected; gate-busy 503; corrupt input 400; replayed
  passthrough key idempotent.
- Presign route: policy carries the 20MB content-length-range (decode the
  base64 policy as mediaStore.test does today).
- Dashboard: >20MB pre-check message (named file, wave proceeds without it);
  size-based confirm chunking (one request per big file, one batch for the
  rest); existing partial-failure "Uploaded N of M" untouched.
- e2e: extend the unit-photos spec with an over-5MB (but valid) image through
  the real MinIO policy edge -> gallery shows the rendition.

## Gates

npm run typecheck + npm test + npm run e2e, bare, green on a base synced
once with main before handback.
