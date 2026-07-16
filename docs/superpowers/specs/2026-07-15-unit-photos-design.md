<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-07-15).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent. NOTE: the upload
> mechanism here (server busboy multipart) was SUPERSEDED before merge by the direct
> browser-to-S3 presigned-POST design in `2026-07-15-unit-photos-direct-upload-revision.md`.

# Property photos: upload, gallery, cover, and flyer display

Date: 2026-07-15
Status: APPROVED (Cameron, 2026-07-15) - ready for implementation
Branch: feat/unit-photos (worktree w:/tmp/unit-photos, cut from main 224f32c)

## 1. Context and decisions

The property page has a stubbed Photos section: a dead "+ Add" button, a
gallery that renders only absolute-URL entries of `unit.media` (with an
"arrives later" placeholder tile for stored keys), and a flyer projection that
already carries `media` - but NOTHING populates the field today (no UI, no
seeds; the URL branch is vestigial mockup-era code). The MMS work already
built the storage machinery: a private bucket, MediaStore.put/head/presign,
a busboy streaming upload pattern, and per-user rate limiting.

Cameron's decisions (2026-07-15):
- D1: Photos DO appear on the public flyer (the tenant-facing marketing
  surface). The bucket stays private - the flyer resolves stored photos to
  short-lived presigned URLs at render time.
- D2: v1 management = Remove + Make cover. No captions (rejected: changes the
  media shape to objects). No URL-input UI (the external-URL path is a
  vestige; existing URL entries merely keep rendering).
- D3: Photo cap = 100 per unit, documented as an ABUSE/RUNAWAY BACKSTOP, not
  a product limit (no hard technical constraint: keys are ~60B against a
  400KB item; presigning is local SigV4 signing, no S3 round trip). Raise it
  the day someone legitimately hits it.
- D4: The upload endpoint keeps the SAME per-user rate-limiter class as the
  MMS upload endpoint (30 requests/min/user), documented as a cost/abuse
  backstop on S3 PUTs. Twilio is uninvolved (uploads only touch S3; A2P
  pacing applies to sends). One request carries MANY files, so staff never
  feel it.
- D5: Presign-per-read: presigned URLs are NEVER persisted - always minted at
  serve time from the durable key (the MMS presign-per-attempt rule, applied
  to reads).

## 2. Goals

- G1: "+ Add" uploads one-or-many image files to the unit; thumbnails + the
  hero render real bytes on the property page.
- G2: The public flyer renders the unit's photos via render-time presigned
  URLs, inheriting the existing shareable-status gate (non-available units
  404 the whole flyer, photos included).
- G3: Remove and Make cover per thumbnail (staff page only). First array
  entry = cover = hero + flyer lead photo.
- G4: All media responses resolve stored keys to display URLs; the
  placeholder tile + its apology note are deleted.
- G5: Gates green; no deps, no schema/GSI, no infra.

## 3. Non-goals

- NO captions, NO URL-input UI, NO reorder beyond Make cover (move-to-front).
- NO S3 object deletion in v1: Remove drops the array entry; the object
  decays as an accepted orphan (same posture as MMS uploads; the existing
  lifecycle-sweep suggestion in docs/issues/mms-upload-endpoint-hardening.md
  covers the class).
- NO image processing (resize/thumbnail generation) - originals serve
  directly; 5MB/file keeps that sane.
- NO MMS attachment of unit photos here - this feature is the PREREQUISITE
  for the open mms-attach-unit-photos issue; add a dated note to that issue
  pointing at this spec (its external-URL caveat is now obsolete: photos
  become stored keys), do not build it.
- NO change to the MMS uploads endpoint/namespace.

## 4. Design

### S1. Storage + model (app)

- Keys: `unit-media/<unitId>/<uuid>` - a DEDICATED long-lived prefix,
  distinct from the MMS `uploads/` namespace, so upload-orphan sweeps and
  lifecycle policies can never touch property assets. Extension-less UUIDs,
  content type recorded on the S3 object at put (the MMS pattern).
- `unit.media: string[]` stays the storage field: stored keys (the primary
  case) or legacy absolute URLs (tolerated, render-only). First entry =
  cover.
- unitsRepo gains ATOMIC array ops (no read-modify-write lost updates):
  - appendMedia(unitId, keys[]): one DynamoDB list_append (+ if_not_exists
    seed for a missing attribute), rejecting when the result would exceed
    the 100 cap (condition on current size, checked server-side pre-call is
    fine given the single-writer reality - but the append itself must be a
    single update).
  - removeMedia(unitId, entry) and makeCover(unitId, entry): read-modify-
    write on the array is acceptable for these (single-operator actions),
    conditioned on the entry being present; absent entry -> clean 404.

### S2. Upload endpoint (app)

- POST /api/units/:unitId/photos - multipart, busboy STREAMING (mirror
  mediaUploads.ts: stream-abort past the size cap, explicit upload abort on
  body-stream error). Guards:
  - images only: jpeg/png/gif/webp (NO pdf - narrower than the MMS
    allowlist; reuse/refactor the shared media-type helpers rather than
    duplicating);
  - 5MB/file (reuse OUTBOUND_MMS_MAX_FILE_BYTES or a same-valued photos
    constant - implementer's call, but ONE source of truth);
  - multiple files per request; unit must exist and not be deleted (404);
  - the 100-photo cap: reject the whole request with a clear 400 when
    existing + incoming would exceed it (comment: abuse backstop, not a
    product limit - raise freely).
- On success: MediaStore.put per file -> ONE appendMedia with all new keys ->
  audit `unit_photos_added` on the units#<id> trail (COUNT only, never
  filenames) -> return the updated unit (with resolved display media, S3
  below).
- Rate limit: createUserRateLimit, routeKey 'unit_photo_upload', max 30/min
  (D4 comment: cost/abuse backstop on S3 PUTs; Twilio uninvolved; one
  request = many files so staff never feel it).
- 503 when the media store is unconfigured (mirror mediaUploads.ts).

### S3. Display resolution - presign-per-read (app)

- A pure-ish helper (suggested: lib or the units route module)
  resolveUnitMedia(mediaStore, unit): for each media entry, a stored key
  (non-URL) presigns (TTL 1h, the existing MMS TTL constant class); an
  absolute URL passes through; failures degrade to omitting that entry's URL
  (log warn, never 500 - the roster-hydration posture).
- Wire shape: unit responses gain `mediaDisplay: { entry: string;
  url?: string }[]` ALONGSIDE the raw `media` (the raw array remains the
  management handle for Remove/Make cover; url absent = unresolvable). The
  flyer projection replaces its raw `media: string[]` pass-through with the
  RESOLVED urls only (public shape stays string[] - url list - so
  FlyerFunnel changes minimally; entries that fail to resolve are omitted).
- Apply at: GET /api/units/:unitId (the detail read the property page uses),
  the photos-mutating routes' responses, and the public flyer route. The
  units LIST does not need it (no gallery there) - skip for cost.
- PIN: no response ever contains a PERSISTED presigned URL; presigning
  happens per request (D5). Unit tests assert two sequential reads mint
  DIFFERENT URLs (signature params differ).

### S4. Manage endpoints (app)

- DELETE /api/units/:unitId/photos  body { entry } -> removeMedia; audits
  `unit_photo_removed` (count/entry-hash only, no URLs in logs); 404 on
  unknown entry; returns the updated unit.
- PUT /api/units/:unitId/photos/cover  body { entry } -> makeCover (move to
  front); audits `unit_photo_cover_set`; 404 on unknown entry; no-op success
  when already the cover; returns the updated unit.
- Both behind the same per-user limiter class as other unit mutations follow
  (if unit PATCH has none today, these need none either - match the route's
  existing posture; the upload limiter is the one D4 mandates).

### S5. Dashboard

- api/types.ts mirrors mediaDisplay (+ sync comments); endpoints.ts gains
  uploadUnitPhotos (multipart), removeUnitPhoto, setUnitPhotoCover.
- ListingDetail Photos section:
  - "+ Add" opens a hidden multi-select file input (accept the image
    allowlist); upload progress state on the button ("Uploading..."),
    inline error on failure (per-file errors surfaced honestly);
  - gallery renders mediaDisplay urls; entries with no url render a small
    honest "unavailable" tile (replaces the old apology note/placeholder
    branch - DELETE that dead copy);
  - per-thumbnail hover/focus actions: "Make cover" (hidden on the first
    entry) and "Remove" (with a confirm - one photo is cheap to lose but
    misclicks happen; a lightweight confirm matches the delete-draft
    pattern);
  - the hero image uses the COVER (first mediaDisplay url) when present,
    today's fallback otherwise;
  - cap state: at 100 photos the Add button disables with a short note.
- FlyerFunnel: unchanged rendering (it already maps flyer.media string[] to
  imgs) - it just starts receiving presigned urls. Verify alt text/layout
  hold with many photos.

### S6. Seeds

- NONE. Seeds cannot ship real S3 objects, and fake URLs would render broken
  tiles. Dev exercise comes from uploading via the UI against MinIO (the
  e2e does exactly this). Lean AND full seed byte-unchanged for media.

## 5. Edge notes

- E1: The public flyer must NEVER serve photos for a non-shareable/deleted
  unit - inherited from the existing whole-flyer 404 gate; add one explicit
  test (available -> photos present; flip to on_hold -> flyer 404s).
- E2: A unit with legacy absolute-URL entries renders them as today (pass-
  through in mediaDisplay + the flyer); Remove/Make cover work on URL
  entries identically (they are just array entries).
- E3: Multi-file upload partial failure: if any file fails validation the
  request 400s BEFORE any put (validate-then-store); if a PUT fails mid-
  batch, already-stored objects are NOT appended (append happens once at the
  end) - they decay as orphans; the response is a 5xx with a clear error.
  No partial appends.
- E4: presign failure on read degrades that entry (url absent -> unavailable
  tile), never 500s the unit GET or the flyer.
- E5: Do NOT add media/mediaDisplay to the PATCH-writable surface changes -
  `media` stays writable via the existing 'string[]' FieldKind (unchanged,
  the raw-API seam), and the new endpoints are the only UI path. No
  regression to the tour_type FieldKind work.
- E6: ASCII only in every touched line (button copy, notes, comments).

## 6. Testing and gates

- Unit (app): upload happy path (single + multi-file) + type/size/cap/
  missing-unit/deleted-unit rejections + validate-then-store (E3) + atomic
  appendMedia; remove/cover semantics incl. 404s and cover no-op;
  presign-per-read pin (two reads differ; nothing persisted); flyer resolve
  + E1 gate test; audit events; rate-limit wiring (429 past 30 in a minute).
- Unit (dashboard): gallery renders urls + unavailable tile; add flow
  (mocked endpoint) incl. error + cap states; Remove confirm + Make cover
  wiring; hero uses cover.
- E2E (extend or add a listing spec): setInputFiles a real image ->
  thumbnail AND hero render real bytes (the MMS spec's loaded-bytes
  assertion pattern); Make cover on a second photo flips the hero; Remove
  drops it; the PUBLIC flyer page for that (available) unit shows the photo.
  MinIO is already in the harness - no new infra.
- Gates (bare, real exit codes, from the worktree): npm run typecheck +
  npm test + `timeout 1500 npm run e2e`, green on a base freshly merged with
  main ONCE (the one-main-sync rule; note later drift, do not chase).
- Self-QA (live stack + Playwright MCP, full seed): upload 2 photos to a
  seeded available unit; make the second the cover; verify hero + flyer;
  remove one; verify an on_hold unit's flyer 404s.

## 7. Post-merge

Nothing required (no deps, no schema/GSI, no terraform - the bucket + IAM
PutObject/GetObject already exist from MMS). Dev-stack restart picks it up.
Follow-up note added to docs/issues/mms-attach-unit-photos.md (prerequisite
now exists; its external-URL caveat is obsolete).

## 8. Review hardening ADDENDUM (2026-07-15, independent review)

Three hardenings added during the merge review; the spec text above predates
them:

- F1 MEMORY FENCES: SUPERSEDED by the DIRECT-UPLOAD REVISION
  (2026-07-15-unit-photos-direct-upload-revision.md). The revision moves the
  bytes OFF EC2 entirely (the browser uploads each file DIRECTLY to S3 via a
  presigned POST), so the buffering these fences bounded no longer exists - the
  whole busboy upload route, UNIT_PHOTO_MAX_REQUEST_BYTES,
  UNIT_PHOTO_MAX_CONCURRENT_UPLOADS, and the dashboard's 10-file batching were
  REMOVED, not kept. See the revision for the presign/confirm route pair that
  replaces this route. The original F1 text is retained below for history only.
  ORIGINAL F1: the E3 validate-then-store buffering this spec mandated
  bounded ONE request at 5MB x 100 files (~500MB), and the D4 limiter counts
  per MINUTE, not concurrency - ~30 in-flight requests could hold ~15GB on a
  2GB box. Added: UNIT_PHOTO_MAX_REQUEST_BYTES (60MB aggregate per request ->
  413 request_too_large) + UNIT_PHOTO_MAX_CONCURRENT_UPLOADS (3 in flight ->
  429 too_many_concurrent_uploads, slot released on response close). The
  dashboard uploads large selections in SEQUENTIAL 10-file batches (each unit
  state applies per batch; a mid-way failure reports how many uploaded), so a
  100-photo drag-drop still works end to end.
- F2 NAMESPACE SCOPING: resolveUnitMedia presigns ONLY keys under the unit's
  own `unit-media/<unitId>/` prefix; a foreign key (an MMS uploads/ attachment
  or another unit's photo) pasted into the PATCH-writable `media` degrades to
  url-absent instead of being presigned onto the PUBLIC flyer.
- F3 HANG-CLASS CLOSURE: the whole upload finish() body is wrapped in a
  catch-all (500 when nothing responded) - the builder's SF1 fix guarded the
  success tail but left the pre-store getById unguarded in the same
  non-Express-captured callback.
