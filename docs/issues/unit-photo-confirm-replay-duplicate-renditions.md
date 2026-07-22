---
id: unit-photo-confirm-replay-duplicate-renditions
title: "Replaying a >5MB unit-photo confirm body mints a second rendition (idempotency does not extend to transcoded sources)"
type: decision
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/routes/units.ts
---

**Problem (review, 2026-07-21 - unit-photo-transcode).** `POST
/api/units/:id/photos/confirm` is idempotent for PASSTHROUGH (<=5MB) keys: the
submitted key IS the entry appended to `unit.media`, so guard (b)'s
`existingSet.has(key)` skip makes a replayed confirm (a client retry after a lost
response) a no-op 200. For a >5MB SOURCE key this does NOT hold: the appended
entry is a FRESH `unit-media/<unitId>/<uuid>` rendition key, never the submitted
source key, so the submitted key can never match `existingSet`. A replay of the
identical body therefore re-downloads, re-transcodes, and appends a SECOND
rendition of the same photo; every further replay adds another copy (bounded only
by the 100-photo cap and the transcode gate). Empirically proven in review (a
throwaway harness test: two identical >5MB confirms -> `world.mediaPuts.length ==
2`, `unit.media == [R1, R2]`, `R1 != R2`).

This is **accepted per the design (spec D4)**, which explicitly states "a
replayed >5MB key mints a second rendition (bounded by the photo cap and the
gate; accepted, matches the existing concurrent same-key confirm posture)". It
fires today only via a MANUAL replay: no current client retries confirm
(dashboard `endpoints.ts confirmUnitPhotos` is retry-free, and the dashboard
confirms each >5MB file in its own request exactly once). The DoS-via-free-replay
angle is separately fenced by the per-user confirm limiter added in the same fix
wave (routeKey `unit_photo_confirm`, 60/min; see
unit-photo-confirm-headobject-amplification).

**Suggested fix (only if a confirm-retrying client is ever added).** Derive the
rendition key deterministically from the source key (e.g.
`${ownPrefix}r-${sha256(sourceKey).slice(0,32)}`) instead of a random uuid, and
treat an existing derived rendition key as already-present: check `existingSet`
for the derived key BEFORE transcoding (skip both the transcode and the append on
a hit), and an S3 overwrite of the same rendition key under a concurrent race is
then harmless. Alternatively, skip transcoding when a HeadObject on the derived
key already succeeds. Update guard (b)'s comment if the behavior changes.
