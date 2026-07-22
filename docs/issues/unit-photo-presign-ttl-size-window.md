---
id: unit-photo-presign-ttl-size-window
title: "Unit-photo presign grant is multi-use within its 300s TTL, so a re-POST can push a confirmed <=5MB photo up to 20MB (stored-photo size invariant breaks)"
type: bug
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/routes/units.ts, app/src/adapters/mediaStore.ts
---

**Problem (review, 2026-07-21 - unit-photo-transcode).** A presigned-POST grant
is a policy that S3/MinIO accepts REPEATEDLY for the length of its TTL
(UNIT_PHOTO_PRESIGN_POST_TTL_SECONDS = 300s) - nothing invalidates it after the
first upload. Before this feature the photo presign policy pinned a 1..5MB range,
so no unit-media object could ever exceed 5MB and the stored-photo size invariant
(`UNIT_PHOTO_PASSTHROUGH_MAX_BYTES`, "the size invariant every STORED photo must
satisfy") was edge-enforced. The transcode feature raised the policy cap to 20MB
and moved the 5MB decision to confirm-time (a single HeadObject). That opens a
window:

1. Presign key K (policy: K, image/png, 1..20MB, 300s).
2. POST a 4MB png to K, then confirm [K]: HeadObject says 4MB -> passthrough ->
   K appended to `unit.media` as a stored photo.
3. Within the remaining TTL, re-POST an 18MB png to the SAME K (policy still
   accepts: same key, same content-type, under 20MB). The object behind an
   ALREADY-CONFIRMED media entry is now 18MB.

Result: the gallery + public flyer serve an 18MB "photo" (bandwidth/UX), and the
documented `<=5MB stored photo` invariant is false. The same window also allows
post-confirm image-content SWAPPING - but note the swap half predates this
change; only the SIZE hole is new (the old 5MB policy made an over-5MB stored
object impossible). Staff-authed-only and racy (needs a second POST inside the
300s TTL of a grant the attacker already used), so severity is low, but it is a
real invariant break introduced by raising the policy cap without moving
enforcement.

**Suggested fix.** Three options, in rough order of cost:
- ACCEPT + document (cheapest): the `UNIT_PHOTO_PASSTHROUGH_MAX_BYTES`
  "every stored photo satisfies this" comment is then aspirational, not
  guaranteed - say so.
- Re-HeadObject each passthrough survivor immediately before `appendMedia` and
  re-classify (a narrow TOCTOU remains between the head and the append, but the
  window shrinks from 300s to microseconds).
- Treat passthrough like transcode: copy the object to a fresh server-owned key
  at confirm and append THAT. This also closes the content-swap window and makes
  originals uniformly orphanable (see
  unit-photo-removal-never-deletes-s3-objects), at the cost of a copy per photo.
