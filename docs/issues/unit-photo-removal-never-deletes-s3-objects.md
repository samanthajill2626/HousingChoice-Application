---
id: unit-photo-removal-never-deletes-s3-objects
title: Removing a unit photo never deletes the S3 object (orphaned bytes; permanent URLs under a future CloudFront media path)
type: debt
severity: low
status: open
area: app
created: 2026-07-21
updated: 2026-07-21
refs: app/src/routes/units.ts, app/src/lib/unitMedia.ts
---

**Scoped down (2026-07-21).** The removed-photo orphan class this issue was
opened for is **FIXED** on the unit-media-cloudfront branch (design
docs/superpowers/specs/2026-07-21-unit-media-cloudfront-design.md, D1): a
`unit.media` edit that removes stored keys now best-effort `DeleteObject`s each
removed own-namespace key (via `deleteRemovedUnitMedia` in
`app/src/lib/unitMedia.ts`, called from the DELETE `/photos` and the raw PATCH
`/:unitId` media seams). Legacy absolute-URL entries and foreign keys are never
deleted; a delete failure degrades to a WARN, never a 500. A removed photo may
still serve from CloudFront edge caches up to the 7-day TTL - that lag is
ACCEPTED, and a manual CloudFront invalidation is the operator escape hatch. So
the original "staff removed it and it stayed reachable" surprise is closed for
the removed-photo class. This issue stays **open** to track ONLY the remaining
orphan class below.

**Remaining problem (oversize originals).** The unit-photo-transcode design (spec
2026-07-21-unit-photo-transcode-design.md) leaves a SECOND orphan class untouched
by D1: a >5MB source uploaded under the new 20MB presign cap is transcoded at
confirm and its jpeg rendition appended - the oversize ORIGINAL object is
deliberately left in the bucket unreferenced (kept for idempotent-replay
simplicity). These originals are never in any `unit.media` list, so the
removal-delete path never sees them. This class is owned by the
unit-photo-transcode follow-up. Under the CloudFront media path such stray keys
are also fetchable-by-key (unguessable server-minted uuids; accepted per the
design's D5 public-read posture), so cleaning them up is storage hygiene, not an
exposure fix.

**Update (2026-07-21, review - unit-photo-transcode).** The transcode confirm
path also creates a SECOND, server-CREATED orphan class on top of the oversize
originals noted above. The full set a future sweep must reconcile is now:
(a) >5MB oversize ORIGINALS - left in place after their jpeg rendition is
appended (the class noted above); and (b) mid-loop RENDITIONS - when a confirm
body carries multiple >5MB keys and the shared transcode gate times out on a
later key, the whole request 503s (all-or-nothing, nothing appended), yet the
jpeg renditions PUT for the EARLIER keys are already in the bucket, referenced by
no unit.media list. Both are unreferenced `unit-media/<unitId>/...` objects;
class (b) is rarer (it needs gate contention AND a multi-big-key body, which the
dashboard never sends - it confirms each >5MB file alone).

**Suggested fix (remaining classes).** An S3 lifecycle sweep or a reconcile job
that compares `unit-media/*` bucket contents against the stored `unit.media`
lists and reclaims objects present in neither (never-appended oversize
originals, orphaned mid-loop renditions, and any other strays). The
removed-photo half no longer needs handling here - D1 covers it.
