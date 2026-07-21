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

**Suggested fix (remaining class).** An S3 lifecycle sweep or a reconcile job that
compares `unit-media/*` bucket contents against the stored `unit.media` lists and
reclaims objects present in neither (never-appended oversize originals and any
other strays). The removed-photo half no longer needs handling here - D1 covers
it.
