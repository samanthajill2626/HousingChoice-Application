---
id: unit-photo-removal-never-deletes-s3-objects
title: Removing a unit photo never deletes the S3 object (orphaned bytes; permanent URLs under a future CloudFront media path)
type: debt
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/routes/units.ts, app/src/lib/unitMedia.ts
---

**Problem.** Photo removal (and any `unit.media` edit) only rewrites the
`unit.media` key list - no code path anywhere in the app issues an S3
DeleteObject, so removed photos live in the media bucket forever. Today the
blast radius is just orphaned storage: reads are presign-per-read
(`resolveUnitMedia`), so the last presigned URL for a removed photo dies within
its 1h TTL. But the planned CloudFront media path (S3 origin + OAC behavior on
`/unit-media/*`, mapped out 2026-07-21 after the deployed-CSP upload breakage)
serves those keys on stable non-expiring URLs - once that lands, anyone who
saved a photo URL can fetch it indefinitely after staff remove it. Unit photos
are public-flyer content, so the exposure class is unchanged, but "staff
removed it and it stayed reachable" is still a surprise worth closing.

**Suggested fix.** On photo removal, best-effort DeleteObject the removed
`unit-media/<unitId>/...` keys (never legacy absolute-URL entries, never keys
outside the unit's own namespace - reuse the `unitMediaPrefix` guard). Failure
degrades to a WARN, never a 500. Pair with a CloudFront invalidation (or accept
cache-TTL lag) once the media behavior exists. Alternatively/additionally: an
S3 lifecycle sweep that reconciles bucket contents against stored `unit.media`
lists.
