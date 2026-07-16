# Property photos REVISION: direct browser-to-S3 upload (presigned POST)

Date: 2026-07-15
Status: APPROVED (Cameron, 2026-07-15) - ready for implementation
Branch: feat/unit-photos (SAME unmerged branch, worktree w:/tmp/unit-photos, @ 177691e)
Supersedes: the UPLOAD MECHANISM of 2026-07-15-unit-photos-design.md (its S2 route
+ the section 8 F1 memory fences). Everything else in that spec still stands.

## 1. Why this revision

The original upload route streams multipart bodies THROUGH the EC2 app and
buffers the whole validated batch in memory (E3 validate-then-store). The
review added F1 fences (60MB/request, 3-concurrent gate, dashboard 10-file
batching) to bound the memory - but that CAPS the problem, it does not remove
it: EC2 still holds every uploaded byte, on a single 2GB t4g.small.

Cameron's decision (2026-07-15): move the bytes OFF EC2 entirely. The browser
uploads each file DIRECTLY to S3 via a presigned POST; EC2 mints the upload
grants and records the result but never touches a byte. This dissolves the
memory problem at the root - the F1 fences and the client batching are removed,
not kept. New infra (a bucket CORS rule) and a new dep are explicitly approved.

## 2. What is REMOVED (rip out)

- The whole `POST /api/units/:unitId/photos` busboy/streaming/buffering route
  in app/src/routes/units.ts, including: the busboy setup, the per-file buffer
  accumulation, the F1 aggregate-byte fence (`totalBytes`/`aggregateHit`), the
  F1 concurrency gate (`inFlightPhotoUploads`), the `finishInner`/`finish`
  catch-all machinery, and the `photoUploadLimits` test seam plumbed through
  api.ts + the harness (replaced by the presign route's own limiter).
- The F1 constants UNIT_PHOTO_MAX_REQUEST_BYTES + UNIT_PHOTO_MAX_CONCURRENT_
  UPLOADS in app/src/lib/unitMedia.ts.
- The dashboard's sequential 10-file batching (PHOTO_UPLOAD_BATCH_SIZE) - the
  browser can upload every file directly to S3 with no EC2 memory concern.
- The F1 unit tests (aggregate 413, concurrency 429/release, 10-file batching)
  and the F1 spec addendum (section 8 of the original) - re-point section 8 at
  THIS revision.

## 3. What is KEPT (unchanged)

- S1 storage/model: keys `unit-media/<unitId>/<uuid>`, `unit.media: string[]`,
  first entry = cover, atomic appendMedia/removeMedia/makeCover.
- S3 DISPLAY: presign-per-READ (D5), mediaDisplay {entry,url?}, flyer resolved
  urls only + the E1 shareable-404 gate. F2 namespace-scoped read presign
  (only `unit-media/<unitId>/` keys resolve) STAYS - it now also backstops the
  confirm step.
- S4 manage routes (DELETE, PUT cover) - unchanged.
- S5 dashboard gallery (thumbnails, hero=cover, unavailable tile, Remove
  confirm, Make cover, cap-disabled Add) - unchanged EXCEPT the upload action.
- Non-goals: no captions, no URL input, no S3 deletes, no seeds. The 100 cap is
  still the abuse backstop. D5 presign-per-read is the read rule.

## 4. Design

### R1. MediaStore: mint presigned POST (app/src/adapters/mediaStore.ts)

- New dep `@aws-sdk/s3-presigned-post` (createPresignedPost). It MUST go in
  app/package.json dependencies, NOT the root - the Dockerfile runtime stage
  installs `npm ci --workspace app --omit=dev` WITHOUT --include-workspace-root,
  so a root-level runtime dep is absent from the deployed image (the
  outbound-MMS prod-boot-crash lesson). Verify with a scratch npm ci using the
  runtime flags.
- Add `createPresignedPost(key, opts): Promise<{ url, fields }>` to the
  MediaStore interface + S3MediaStore. The policy conditions:
    - key EXACTLY the server-minted key (no client-chosen keys);
    - content-length-range 1 .. OUTBOUND_MMS_MAX_FILE_BYTES (5MB) - S3 rejects
      an over-size or zero-byte upload;
    - content-type an allowed image type (jpeg/png/gif/webp);
    - a short expiry (e.g. 5 min - long enough to pick + upload, short enough
      that a leaked grant expires).
  Keep `put()` (voice recording + any server-side path) and `presign()` (GET
  reads) as-is.

### R2. Two routes replace the upload route (app/src/routes/units.ts)

- `POST /api/units/:unitId/photos/presign`  body `{ count, contentTypes: string[] }`
  - Validate: unit exists + not deleted (404); count is 1..(a sane per-request
    batch max, e.g. 20 - a UX/politeness bound, NOT a memory bound); each
    contentType is an allowed image type (400 otherwise); existing + count <=
    100 cap (400 photo_cap_exceeded - a friendly pre-check; confirm re-guards
    atomically).
  - Mint `count` presigned POST grants, each keyed `unit-media/<unitId>/<uuid>`
    (server-minted uuid) with the R1 policy for that file's content type.
  - Return `{ uploads: [{ key, post: { url, fields } }] }`. No bytes touched.
  - Behind a per-user limiter (routeKey 'unit_photo_presign', 30/min) - a
    cheap mint-abuse fence; NO memory concern so no concurrency gate.
- `POST /api/units/:unitId/photos/confirm`  body `{ keys: string[] }`
  - For each key: (a) MUST start with `unit-media/<unitId>/` (prefix scope -
    rejects a foreign/cross-unit/uploads key, defense in depth beyond the
    minted-key design); (b) HeadObject succeeds (the object was actually
    uploaded); (c) HeadObject content-type is an allowed image type AND size
    <= 5MB (re-verify what S3 stored). A key failing any check is DROPPED with
    a logged warn; if NO key survives -> 400.
  - Atomic appendMedia(unitId, survivingKeys) - the 100-cap ConditionExpression
    re-guards under a race (a concurrent confirm filled the unit -> Conditional
    CheckFailed -> 400 photo_cap_exceeded, same shape). Audit `unit_photos_added`
    count-only. Return the updated unit with mediaDisplay (resolveUnitMedia).
  - Ordinary async Express handler - no busboy, no callback-outside-capture, so
    the F3 hang class simply does not exist here.
- 503 from BOTH routes when the media store is unconfigured.

### R3. CORS (infra - APPROVED)

- Prod: add `aws_s3_bucket_cors_configuration` to infra/modules/s3_media
  allowing method POST (the direct upload) from the deployed dashboard
  origin(s), AllowedHeaders ["*"], ExposeHeaders ["ETag"]. Parameterize the
  origins via a new module variable (e.g. `dashboard_origins: list(string)`)
  wired from the stack the way other origin config is; the operator sets the
  real value in tfvars. GET is NOT needed in CORS (image reads are <img src>,
  not fetch - not CORS-gated). The public-access-block stays (presigned POST is
  an authenticated request, unaffected by it).
- Local MinIO: PHASE-0 VERIFY what the harness needs - modern MinIO may allow
  all CORS origins by default in dev, or may need an explicit PutBucketCors in
  app/scripts/s3-create.ts. Determine empirically (a direct browser POST to
  MinIO from the dashboard origin succeeds) and configure s3-create.ts if
  required. Whatever is needed must be idempotent + local-only (never AWS),
  matching s3-create.ts's existing posture.

### R4. Dashboard upload (dashboard/src/routes/listing/ListingDetail.tsx)

- The hidden multi-file input stays. On change, the client now:
  1. POST /photos/presign with the chosen files' count + content types;
  2. for each file, POST directly to its `post.url` with `post.fields` + the
     File as `file` (a multipart FormData to S3/MinIO) - these run in PARALLEL
     (no EC2 memory concern; a modest concurrency, e.g. 4-6, keeps the browser
     civil); real per-file upload progress is now possible (XHR upload event) -
     wire it if cheap, else keep the existing busy state;
  3. POST /photos/confirm with the keys that uploaded OK; apply the returned
     unit in place.
  - Honest partial handling: if some direct uploads fail, confirm only the ones
    that succeeded and report "Uploaded N of M". A presign or confirm failure
    surfaces the existing inline role=alert error.
- New endpoints.ts clients: presignUnitPhotos, uploadToPresignedPost (raw S3
  POST - NOT through the app's request() helper; it targets S3, carries no
  session cookie/CSRF), confirmUnitPhotos. Remove uploadUnitPhotos (the old
  multipart-to-app client) + PHOTO_UPLOAD_BATCH_SIZE.

### R5. Trust + safety recap

- Keys are server-minted opaque uuids under the unit's own prefix; the browser
  never chooses a key. Confirm re-checks prefix + existence + type, so even a
  crafted confirm body cannot append a foreign object or a nonexistent key.
- Orphan posture unchanged: a file uploaded to S3 but never confirmed (tab
  closed) is an orphan under unit-media/, decaying like the accepted MMS
  upload orphans (the lifecycle-sweep issue already covers the class).
- The bucket stays PRIVATE; a presigned POST is a time-limited scoped WRITE
  grant, reads still presign per-read (D5).

## 5. Testing and gates

- PHASE-0 SPIKE (do FIRST, gates the design): createPresignedPost against MinIO
  works (a direct multipart POST with the policy fields stores the object;
  over-size + wrong-type are rejected by MinIO's policy enforcement) AND a
  browser-origin POST is not CORS-blocked (configure s3-create.ts if needed).
  Mirror the outbound-MMS MinIO presign spike.
- Unit (app): presign mints one grant per file with the right key prefix + the
  policy conditions (size/type); presign 404s a missing/deleted unit, 400s a
  non-image type + an over-cap count. Confirm: prefix-scope drop (foreign /
  cross-unit / uploads key never appended), HeadObject-missing drop, type/size
  re-check drop, empty-after-drops -> 400, surviving keys atomic-appended, cap
  re-guard race -> 400, audit count-only. MediaStore.createPresignedPost shape.
  DELETE the F1 tests.
- Unit (dashboard): the presign -> direct-POST -> confirm sequence (mock the
  three network calls); partial-failure "Uploaded N of M"; error states; the
  gallery/hero/cap-disable render tests stay.
- E2E (listing-photos.spec.ts): rework the upload to the real flow - the test
  drives presign, POSTs the bytes to MinIO, confirms; the thumbnail + hero
  render real bytes; Make cover flips the hero; Remove drops it; the public
  flyer shows the photo for an available unit; On-hold flyer 404s. (MinIO is in
  the harness; the CORS/presigned-POST path is exactly the new upload path.)
- Gates (bare, real exit codes, from the worktree): npm run typecheck +
  npm test + `timeout 1500 npm run e2e`, green on the current branch base (no
  new main sync needed unless main advanced meaningfully - one sync rule).
  npm install after the dep add.
- Self-QA (live stack + Playwright MCP, full seed): upload 2 photos (bytes go
  browser->MinIO, verify via the network panel that NO multipart body hits the
  app :port); cover flip; flyer; remove; On-hold 404. Confirm a large multi-
  file selection uploads with no app-side memory growth.

## 6. Post-merge / ops

- DEP: `@aws-sdk/s3-presigned-post` (app workspace) -> npm install on merge.
- INFRA (Cameron/operator runs, NOT the builder): terraform apply the
  s3_media CORS configuration on dev (and prod at cutover), with
  dashboard_origins set to the real deployed origin(s). The upload path is
  BROKEN in a deployed env until the CORS rule is applied - call this out in
  the handback + RUNBOOK.
- Local dev picks it up on a stack restart (+ the s3-create.ts CORS step if the
  spike found one is needed).
