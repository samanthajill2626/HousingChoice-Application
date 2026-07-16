# Outbound MMS media transcoding (fix Twilio 12300)

Status: approved design, pre-implementation
Date: 2026-07-16
Branch: feat/outbound-mms-transcoding
Owner: Cameron (review/merge); build via orchestrated subagent

## 1. Problem / root cause

Sending an MMS with certain image attachments fails with **Twilio error 12300
"Invalid Content-Type"**. Root cause (verified 2026-07-16, no prior fix exists):

- The outbound MMS path gates uploads on `isInlineMediaType` (lib/mediaTypes.ts),
  whose allowlist is `image/jpeg, image/png, image/gif, image/webp,
  application/pdf`. That list was designed for INBOUND rendering / stored-XSS
  safety ("what is safe to show in the dashboard"), NOT for "what Twilio will
  deliver."
- There is **no Twilio-deliverable-type filter anywhere on the outbound path**
  (send service, api.ts send route, messaging adapter, relay fan-out all checked).
- So a stored `image/webp` (or `application/pdf`) is presigned and handed to
  Twilio, which fetches the URL, sees a Content-Type it cannot carry, and rejects
  the whole send with 12300.

Twilio's carrier-deliverable MMS image set is effectively **jpeg / png / gif**.
`webp` is the common trap: modern browsers and screenshot tools produce `.webp`
constantly, so "some images fail" reads to a user as "images fail with 12300."

## 2. Goals / non-goals

Goals:

- No attachment that reaches Twilio is ever a non-deliverable Content-Type
  (kills 12300 at the root).
- A user can attach a `webp` or a `pdf` and it is silently converted to a
  deliverable JPEG and sent.
- The system self-guards: adding a future uploadable type that Twilio cannot
  carry fails CI until it is given a transcode path ("note what IS accepted,
  transcode what ISN'T -- now and in the future").
- Auto-fit: a user can attach large photos and they are downscaled/compressed to
  stay within the MMS budget, instead of being rejected.
- A multi-page PDF sends page 1 as an image, with a soft warning that only page 1
  will be sent.
- EC2 memory stays bounded on the 2 GB t4g.small host.

Non-goals (explicit):

- **HEIC** is out of scope. iPhone HEIC is not in the allowlist and sharp's
  prebuilt binary cannot decode it (libheif licensing). Mobile Safari usually
  auto-converts HEIC->JPEG on upload, so this is mostly a desktop-with-.heic-file
  edge. Recorded, not handled.
- Cross-image dynamic total-budget fitting (re-compress the whole set as photos
  are added) is deferred (design Approach B). Approach A (auto-fit each file) is
  built; the 5 MB total remains a send-time backstop with a clear message.
- Preserving multi-page PDFs as multi-page (only page 1 is sent).
- Moving transcoding to a Lambda now (see Section 12: the design keeps a clean
  seam to do this later).

## 3. The deliverable-type registry (core principle)

In lib/mediaTypes.ts, add the single source of truth for Twilio deliverability:

```
TWILIO_DELIVERABLE_MMS_TYPES = { image/jpeg, image/png, image/gif }
```

The MMS *uploadable* allowlist stays the existing image+pdf set
(`jpeg, png, gif, webp, pdf` = INLINE_MEDIA_TYPES minus nothing relevant; pdf
included).

One pure function decides every source file's fate:

```
plan(sourceType, sizeBytes) ->
  | 'transcode-pdf'    when sourceType == application/pdf
  | 'deliver'          when sourceType == image/gif           (pass through; preserves animation; gif is deliverable)
  | 'transcode-image'  when sourceType in { image/webp, image/jpeg, image/png }   (normalize + auto-fit)
  | 'reject'           otherwise                              (never reached; the upload allowlist gates first)
```

Notes:

- `image/webp/jpeg/png` ALL transcode-image. We deliberately re-encode even
  already-deliverable jpeg/png so auto-fit (downscale + quality ladder) applies,
  which best serves the "help fit within the 5 MB budget, per-file AND total"
  goal. Accepted trade-off: minor generation loss re-encoding an already-small
  JPEG; bounded CPU (Section 8).
- `image/gif` is pass-through (NOT sharp-transcoded) so animated gifs are not
  flattened to a single frame. gif is deliverable, so pass-through is safe. A
  pathological oversize gif is caught by the send-time total/per-file cap.
- The **guardrail test**: every type in the uploadable allowlist must map to a
  non-`reject` plan. Adding a future uploadable type that is neither deliverable,
  a transcodable image, nor pdf fails CI until it is given a branch. This is the
  "now and in the future" guarantee, enforced by a test rather than a comment.

## 4. Architecture / data flow (direct-to-S3 presign -> confirm-transcode)

The MMS composer upload is migrated OFF the busboy through-EC2 endpoint
(routes/mediaUploads.ts `POST /api/media/uploads`) and ONTO the direct-to-S3
presign/confirm pattern already proven for unit photos (routes/units.ts
`/photos/presign` + `/photos/confirm`). Rationale: the client uploads bytes
straight to S3 (EC2 byte-free on upload); the ONLY EC2 memory cost is the
confirm-time download+transcode, which is what we bound.

Flow, per attachment:

1. **Presign** -- `POST /api/media/presign` mints a presigned POST for a
   server-minted key `uploads/<uuid>`. Policy pins: Content-Type in the uploadable
   allowlist, content-length-range `1 .. MMS_UPLOAD_SOURCE_MAX_BYTES` (~20 MB, so
   big phone photos can be uploaded then auto-fit down), short TTL (reuse the
   unit-photo 300s grant TTL). Reuses `MediaStore.createPresignedPost`.
2. **Browser uploads the original directly to S3.** Unbounded client-side; EC2
   never sees the bytes. Reuses the same origin-scoped `s3_media` CORS rule the
   unit-photo direct upload already applied (already in effect on dev).
3. **Confirm** -- `POST /api/media/confirm` `{ key }`:
   - Enforce own-prefix (`uploads/<uuid>` shape) so a caller cannot point confirm
     at an arbitrary bucket key.
   - HeadObject the original: absent -> 400 `unknown_attachment`; read
     Content-Type + size.
   - `plan(type, size)`:
     - `deliver` (gif) -> return the original key as the deliverable; NO download,
       NO rewrite.
     - `transcode-pdf` / `transcode-image` -> acquire a transcode semaphore slot
       (Section 8), GET the original bytes from S3, run mediaTranscode (Section 5),
       PUT the deliverable JPEG to a FRESH key `uploads/<uuid2>` (matches the
       existing `UPLOAD_KEY_PATTERN`, so no send-route pattern change), release the
       slot. The ORIGINAL `uploads/<uuid>` is retained (original + converted both
       stored).
   - Return `{ deliverableKey, contentType, size, transcodedFrom?, pdfPageCount? }`.
4. **Send** -- the composer sends `attachmentKeys: [deliverableKey, ...]` to the
   existing `POST /api/conversations/:id/messages`. `resolveAttachmentKeys`
   HeadObjects each key (now a JPEG or a pass-through gif) and presigns per attempt
   as today. The send path is otherwise UNCHANGED.

Storage keys:

- Original (browser-uploaded): `uploads/<uuid>` -- retained.
- Deliverable (transcode path): `uploads/<uuid2>` (fresh uuid, `image/jpeg`).
- Deliverable (gif pass-through): the original key itself.

## 5. The transcode adapter (mediaTranscode.ts)

New adapter `app/src/adapters/mediaTranscode.ts` -- the ONLY place `sharp` and
`@hyzyla/pdfium` are imported (mirrors the MediaStore adapter rule). Single entry:

```
transcodeForMms(bytes: Buffer, sourceType: string): Promise<{
  bytes: Buffer,
  contentType: 'image/jpeg',
  pdfPageCount?: number,     // set for pdf (drives the multi-page warning)
  transcodedFrom: string,    // original type, for telemetry/response
}>
```

Verified pipeline (spike-proven 2026-07-16; the published docs were wrong -- see
"gotchas" below):

- transcode-image (webp/jpeg/png):
  `sharp(bytes).rotate()` (honor EXIF orientation before stripping metadata)
  `.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })`
  then the quality ladder (Section 7) -> `image/jpeg`.
- transcode-pdf:
  `const lib = await PDFiumLibrary.init()` (module singleton, init once);
  `const doc = await lib.loadDocument(bytes)`; `pdfPageCount = doc.getPageCount()`;
  render page 0 with `page.render({ scale, render: 'bitmap' })` -> raw RGBA
  `{ data, width, height }`; feed to
  `sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })` then the same
  resize + quality ladder -> `image/jpeg`. Destroy page/doc; keep the library.
  `scale` chosen to land the raster near MAX_EDGE, clamped to [1, 3].

Spike gotchas now pinned (do NOT trust the pdfium.js.org docs):

- The render engine string `'sharp'` does NOT exist in @hyzyla/pdfium 2.1.13.
  The only string engine is `'bitmap'`, which returns a RAW buffer (not PNG).
  Use `render: 'bitmap'` then hand the raw buffer to sharp with explicit
  `{ raw: { width, height, channels: 4 } }`.
- The type default says `colorSpace: 'BGRA'`, which would swap red/blue. Empirically
  `'bitmap'` returns RGBA (a pure-red page rendered to pixel [255,0,0]). No swap
  needed. A regression test asserts color-accuracy (the red-pixel check) so a future
  library change that flips this is caught.

sharp hardening: call `sharp.concurrency(1)` and set `limitInputPixels`
(~24 MP = `SHARP_MAX_INPUT_PIXELS`) so an absurd-dimension image is rejected before
a full raster decode. A too-large-dimension input throws -> confirm 400.

## 6. Send-route defense-in-depth (belt-and-suspenders root-cause guard)

Independently of transcoding, tighten the send path so 12300 can NEVER happen even
if confirm is bypassed:

- In `resolveAttachmentKeys` (routes/api.ts), replace the `isInlineMediaType`
  content-type re-check with a check against `TWILIO_DELIVERABLE_MMS_TYPES`. A key
  whose stored Content-Type is not jpeg/png/gif is rejected with a clear error
  (`unsupported_attachment_type`), before any presign. This is the minimal
  root-cause fix; transcoding is what makes legitimate webp/pdf sends succeed.
- Relay fan-out (jobs/relayFanOut.ts) inherits the deliverable keys from the hub
  message's durable `media_attachments` and re-presigns per leg as today -- no
  change needed; the keys are already JPEGs.

## 7. Auto-fit (quality ladder)

Constants (lib/outboundMediaLimits.ts or a new sibling):

- `TRANSCODE_TARGET_MAX_EDGE = 1600` px (longest edge; MMS-friendly).
- `TRANSCODE_TARGET_MAX_BYTES = 1_500_000` (per-file soft target the ladder aims
  for).
- `TRANSCODE_JPEG_QUALITY_LADDER = [82, 72, 62, 52, 42]`.

Algorithm: resize to <= MAX_EDGE, then encode at the first ladder quality whose
output is <= TARGET_MAX_BYTES; if none qualifies, use the lowest quality result.
The hard per-file cap `OUTBOUND_MMS_MAX_FILE_BYTES` (5 MB) is a final assertion --
a 1600px JPEG at q42 is far under it, so this is effectively never hit; if it ever
is, confirm returns 400 `file_too_large_after_fit`.

Effect: typical photos land at ~200-600 KB, so per-file limits are never a problem
and the 5 MB total comfortably holds several photos. Cross-image budgeting for the
extreme many-photo case stays deferred (Approach B); the send-time total cap is the
backstop with a "remove one" message.

## 8. Memory / concurrency safety (2 GB t4g.small: app + worker one box)

The 2 GB host runs app + worker as compose containers on one box; there is no
memory isolation between them, so transcode memory must be bounded.

- **Client upload concurrency is a non-issue** (browser -> S3 direct).
- The only EC2 cost is confirm-time `S3 GET + transcode`, gated by a process-wide
  semaphore `MMS_TRANSCODE_MAX_CONCURRENT = 2`. A confirm past the cap WAITS for a
  slot (bounded by `MMS_TRANSCODE_WAIT_TIMEOUT_MS = 20_000` -> 503 on timeout).
- **Queued confirms hold only the S3 key, not the bytes** -- EC2 fetches the object
  only after winning a slot. So N confirms firing at once cause zero source-byte
  pile-up (the failure mode the busboy approach had).
- Per-transcode working set: JPEG/WebP downscale uses shrink-on-load (~tens of MB);
  PNG full-decode bounded by `SHARP_MAX_INPUT_PIXELS`; pdf raster bounded by the
  clamped render scale + the pdfium WASM heap. Peak ~= 2 * worst-case (~100 MB) +
  2 * fetched source ~= ~230 MB transient on top of the ~0.7-1 GB baseline -> ~1.2
  GB peak, safely under 2 GB. The real cost is transient CPU on 2 vCPU, contained by
  the cap; acceptable for a low-traffic internal tool.
- This is the F1 lesson from unit-photos: a per-minute rate limiter is NOT a
  concurrency bound. The semaphore is the concurrency bound.

## 9. MMS limit alignment (unchanged, inherited)

- `OUTBOUND_MMS_MAX_MEDIA = 10` == Twilio API max media/message. Enforced
  client-side (attachmentReject) and server-side (resolveAttachmentKeys).
- `OUTBOUND_MMS_MAX_TOTAL_BYTES = 5 MB` == Twilio total ceiling, summed at send over
  the DELIVERABLE (transcoded) object sizes -- so the budget is measured against
  exactly what goes to Twilio. Over -> `attachments_too_large`.
- Transcoding adds no new send-count/size behavior; it only makes each attachment
  carrier-deliverable, and (via auto-fit) smaller, which helps the total hold.

## 10. Dashboard behavior + error handling

Composer (routes/contact/Timeline.tsx and the relay/tour composers that share the
attachment machinery): repoint the per-attachment upload from the busboy
`uploadMedia` call to presign -> browser POST -> confirm. Reuse the existing
per-chip `uploading` / `ready` / `error` state machine.

- While confirm runs, the chip shows a spinner (transcode takes a beat), then flips
  to ready using the returned `deliverableKey`.
- Multi-page PDF: when confirm returns `pdfPageCount > 1`, the chip shows a soft
  inline note "PDF - only page 1 will be sent as an image." Send stays enabled.
  Single-page PDF and images show no note. (Per decision: soft/informational, no
  warning on the single-page happy path.)
- Auto-fit is silent (no "we compressed this" copy).

Error handling by layer:

| Failure | Where | Response |
| --- | --- | --- |
| Presign policy violation (over source cap / wrong type) | S3 edge | Browser POST rejected -> chip error with reason |
| Corrupt / undecodable file | confirm (sharp/pdfium throw) | 400 `transcode_failed` with a `detail` field = the caught library error message; chip shows "Couldn't process this file: {detail}" |
| Semaphore full | confirm | waits for a slot; on timeout 503; chip offers retry |
| Transcoded result still over per-file cap after the ladder | confirm | 400 `file_too_large_after_fit` (pathological) |
| Total > 5 MB across attachments | send route (existing) | `attachments_too_large` -> "remove one" message |
| Non-deliverable key reaches send (confirm bypassed) | send route guard (Section 6) | `unsupported_attachment_type` |

Diagnostics: the `transcode_failed` response includes the library error string
(sharp: "Input buffer contains unsupported image format"; pdfium: the load error).
These are diagnostic strings with no secrets/PII on an authed staff-only surface, so
surfacing them on the chip is safe and speeds debugging. The server ALSO logs the
full error object + `s3Key` + `transcodedFrom` at error level so the chip detail and
the log line correlate on the same key.

PII/logging discipline (existing rule): log s3Key + byte counts + transcodedFrom
only, never filenames or bytes; presigned URLs remain bearer tokens (never logged).

## 11. Dependencies + deployment

New runtime deps in **app/package.json** (NOT root -- the Dockerfile runtime stage
runs `npm ci --workspace app --omit=dev`, which omits root):

- `sharp` (Apache-2.0) -- image transcode. Prebuilt `@img/sharp-linux-arm64`
  (linux/arm64/glibc) matches the `node:24-slim` arm64 runtime. Verified the
  prebuilt exists on npm.
- `@hyzyla/pdfium` (MIT, over BSD/Apache PDFium) -- pure WASM (one ~3.9 MB
  `pdfium.wasm`, no os/cpu lock, zero native deps); runs identically on arm64.

Dev/test dep (app devDependencies): `pdf-lib` (MIT) to generate multi-page PDF
fixtures in tests.

Licensing note: all permissive. MuPDF/Ghostscript/Poppler were rejected as
AGPL/GPL (would encumber a proprietary SaaS).

**Deployment risk to prove (build integration):** sharp's arm64 binary is an
OPTIONAL dependency. npm's lockfile must actually contain the `@img/sharp-linux-arm64`
entry or `npm ci` inside the arm64 build can skip it -> runtime "Could not load the
sharp module" boot crash. The plan MUST: regenerate the lockfile so it includes the
linux-arm64 sharp variant (e.g. `npm install --os=linux --cpu=arm64 --include=optional`
or equivalent), and PROVE it with a real arm64 `npm ci --workspace app --omit=dev`
(buildx), same discipline as the @aws-sdk/s3-presigned-post dep. `npm install` is
owed on merge.

## 12. Infra

- The `s3_media` CORS rule (origin-scoped: dashboard origin + the media bucket) is
  ALREADY applied on dev and covers this direct-upload path as-is -- MMS uses the
  same bucket and same origin. The presign size/type limits live in the per-request
  presigned-POST policy, not in Terraform.
- Reading the original and writing the derivative both use the EC2 IAM role's
  existing `s3:GetObject`/`s3:PutObject` on `MEDIA_BUCKET`.
- Expectation: **no new dev Terraform apply is needed** for this feature. The only
  remaining apply is the prod CORS at cutover, already tracked for unit-photos; this
  feature rides it. If the build surfaces a genuine infra need, flag it explicitly.

## 13. Lambda future seam (deferred, recorded)

The confirm-time transcode is a clean lift-out point. Later, an S3 `ObjectCreated`
event on the original key can trigger a Lambda that writes the deliverable; confirm
then just polls for the derivative. All transcode logic lives behind
`mediaTranscode.ts`, so it can be moved into a Lambda without touching callers. Not
built now; recorded as the designated move if transcode volume ever pressures the
box.

## 14. Rollout / migration

- Replace the composer's use of the busboy `POST /api/media/uploads` with
  presign + confirm. Remove the busboy endpoint (routes/mediaUploads.ts) and its
  tests, OR keep it dormant only if an internal/e2e seam still needs it -- prefer
  removal to avoid a second, un-transcoded upload path that could reintroduce 12300.
- The legacy raw `mediaUrls` send seam (internal/e2e only) is separate and
  unaffected.
- Update the dashboard api client (`uploadMedia`) to the presign/confirm calls and
  the composer chip flow.

## 15. Testing

Unit -- mediaTypes registry (guardrail): `plan()` returns the right branch per type;
the loud test that every uploadable type maps to a non-reject plan.

Unit -- mediaTranscode (real bytes, ported from the spike, no mocks):

- webp -> valid image/jpeg, dims preserved.
- oversized png -> longest edge capped at 1600 (auto-fit downscale).
- large image -> quality ladder drops output <= target bytes.
- 3-page pdf -> pdfPageCount === 3 AND page-1 renders to a valid, COLOR-ACCURATE
  jpeg (the red-pixel assertion, guarding the BGRA/RGBA regression).
- 1-page pdf -> pdfPageCount === 1.
- corrupt pdf / non-image bytes -> throws (so confirm can 400 with detail).

Integration -- presign/confirm routes: presign rejects bad type/oversize; confirm
transcodes + stores original AND derivative + returns metadata (incl. pdfPageCount);
own-prefix + absent-key rejection; the semaphore bound (N+1 concurrent confirms ->
the extra waits, none error/OOM); confirm idempotent on replay. Send route: the
deliverable-type guard rejects a non-jpeg/png/gif key.

e2e (Playwright, hermetic MinIO): attach a webp in the composer -> send -> assert the
sent/persisted media is image/jpeg and NO multipart bytes hit the app (extend the
existing no-multipart-to-app assertion); attach a multi-page pdf -> assert the
page-1 warning renders and the send carries one deliverable jpeg. This is the
real path that would have thrown 12300, proven green.

Live self-QA (reviewer): drive the real dashboard -- upload a genuine .webp and a
real multi-page .pdf; confirm the network shows browser->S3 direct + a bounded
confirm; the sent attachment is a jpeg; in --mock the dev outbox shows a deliverable
media URL.

## 16. Accepted trade-offs

- Re-encoding already-deliverable jpeg/png incurs minor generation loss; chosen so
  auto-fit applies uniformly and best serves the "help fit the total" goal. Bounded
  CPU via the semaphore.
- Animated gif is pass-through (not fitted); a pathological oversize gif is caught
  by the send-time cap.
- Multi-page PDFs lose pages 2+ (only page 1 sent), with a soft warning.
- HEIC unsupported (Section 2).
- Cross-image dynamic total-budget fit deferred (Approach B).
