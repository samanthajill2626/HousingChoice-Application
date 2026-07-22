---
id: unit-photo-bulk-transcode-async-ux
title: Bulk big-photo uploads hold the user on the page through serial confirm-time transcodes (async worker-job transcode is the proper fix)
type: improvement
severity: med
status: open
area: app
created: 2026-07-21
refs: app/src/routes/units.ts, dashboard/src/routes/listing/ListingDetail.tsx
---

**Problem (Cameron, 2026-07-21 review).** unit-photo-transcode fits >5MB
sources synchronously inside each confirm request, and the dashboard confirms
each big file in its own sequential request (D5). For a bulk drop of ~50 all-
big photos that means: the browser upload phase (bandwidth-bound, any design
pays it) PLUS roughly 2-4 minutes of serialized transcodes (~2-5s per file) -
during which the user MUST keep the tab open. The gallery does fill in
progressively (unit state applies after every confirm) and the Photos section
shows "Uploading...", but navigating away mid-flow silently abandons the
remaining unconfirmed files (their uploaded S3 bytes orphan; confirmed photos
persist - no corruption, no resumption). Not "tens of minutes" in practice,
but a real tab-hostage + silent-abandonment gap for the extreme bulk case.

**Proper fix: async transcode via the worker.** Confirm accepts an oversize
key immediately (validates head/type/size, records a PENDING entry) and
returns; a worker job downloads + transcodes behind the same shared gate and
swaps the rendition key in. Needs: pending-state modeling on unit.media
entries (or a sibling pending list), gallery "processing" placeholder that
swaps on SSE (event bridge exists), public-flyer handling of pending entries
(skip, as url-absent entries degrade today), per-photo failure surfacing
(job retry/DLQ posture), and idempotency for job replays. A proper follow-up
feature - it changes the confirm contract, so spec it; do not bolt on.

**Cheap interim (optional, decide before building the async version):** run
the dashboard's big-file confirms 2-at-a-time (matching the server gate's 2
slots) instead of strictly sequential - roughly halves the wall time at the
cost of holding both shared slots (starves concurrent MMS confirms harder;
see shared-transcode-gate-couples-mms-and-photo-availability).
