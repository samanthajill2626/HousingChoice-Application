<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Local S3 media mirroring + inline image/PDF rendering

**Date:** 2026-06-16
**Status:** Implemented & merged to `main` (the `local-s3-media` branch + worktree were merged and deleted 2026-06-18)

## Problem

Inbound MMS media is mirrored from the provider into a private S3 bucket
(`MEDIA_BUCKET`) and served back to the dashboard through the authed
`GET /api/messages/:providerSid/media/:idx` endpoint. In the hermetic local
stack `MEDIA_BUCKET` is unset, so `createMediaStore()` returns `undefined`, the
webhook skips mirroring, and the message keeps only the provider `mediaUrls`.
The dashboard never renders provider URLs inline (they are untrusted / not
fetchable in prod), so an inbound MMS shows the **"Media attachment (not yet
viewable)"** placeholder instead of the image.

The result: there is no way to see real inbound MMS media end-to-end in local
dev or in the e2e harness. We want a **local S3** so the mirror path runs, and
the dashboard to **render images inline and PDFs as a preview**, everything else
as a safe download — without weakening the existing stored-XSS posture.

## Goals

1. A local S3 (MinIO) in the hermetic stack, wired exactly like DynamoDB Local.
2. Inbound MMS media mirrors to it in local dev (`--local`) and in e2e.
3. Canned dev assets that actually render: images inline, a PDF as a preview.
4. Deliberately allow inline **PDF preview** (vetted), keeping deny-by-default
   for every other type — non-allowlisted types still flow as safe downloads.
5. A single cohesive per-attachment record (`{s3Key, contentType}`) so key and
   type can never drift.

## Non-goals

- No change to the deployed AWS media path beyond (a) the local endpoint
  override (inert in prod, guarded) and (b) adding `application/pdf` to the
  inline allowlist (intended to apply in prod too).
- Office docs (docx/xlsx/…) remain downloads — browsers can't preview them
  anyway. No document-conversion/thumbnailing service.
- No public/presigned media URLs — bytes stay behind the session gate (unchanged).

## Key background (verified)

- `createMediaStore()` returns `undefined` when `MEDIA_BUCKET` is unset
  ([app/src/adapters/mediaStore.ts](../../../app/src/adapters/mediaStore.ts)).
- The serve endpoint already implements correct defense-in-depth
  ([app/src/routes/api.ts](../../../app/src/routes/api.ts) ~L673-694): inline
  only for allowlisted types, else `Content-Disposition: attachment` +
  `application/octet-stream`; always `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`. **Non-allowlisted ≠
  blocked — it is a safe download.**
- `getStream()` returns the object `Content-Type` alongside the body from a
  single `GetObjectCommand`, so the serve endpoint gets the authoritative type
  **for free** (no extra HEAD).
- The allowlist lives in
  [app/src/lib/mediaTypes.ts](../../../app/src/lib/mediaTypes.ts):
  `image/jpeg|png|gif|webp`. SVG is deliberately excluded.
- The fake's `inferMediaContentType`
  ([fake-twilio/src/engine/signer.ts](../../../fake-twilio/src/engine/signer.ts))
  maps extensions → types but returns `application/octet-stream` for `.svg`
  **and `.pdf`**.
- DynamoDB Local is a Docker container managed by
  [scripts/db.mjs](../../../scripts/db.mjs) (`hc-dynamodb-local`, in-memory,
  create-if-absent / restart-if-exists); tables via `app/scripts/db-create.ts`.
- `--local` (not `--mock`) decides local AWS. `--mock` is Twilio-only and
  orthogonal (see [scripts/dev.mjs](../../../scripts/dev.mjs)).

## Design

### 1. Local S3 (MinIO), mirroring the DynamoDB-Local pattern

New `scripts/s3.mjs` (sibling of `db.mjs`) managing a `hc-s3-local` container:

```
docker run -d --name hc-s3-local -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=local -e MINIO_ROOT_PASSWORD=locallocal \
  minio/minio server /data --console-address ":9001"
```

- `start` / `stop` semantics identical to `db.mjs` (create-if-absent,
  restart-if-exists). Data is ephemeral (no volume mount) — resets when the
  container is removed; this matches the in-memory DynamoDB Local behavior.
- API endpoint `http://localhost:9000`; console `:9001` (dev convenience).
- New npm scripts `s3:start` / `s3:stop`. Export `CONTAINER_NAME`,
  `LOCAL_S3_ENDPOINT`, `MINIO_*` constants for reuse by the launchers, mirroring
  `db.mjs`'s exports.

**Bucket creation:** `app/scripts/s3-create.ts` (mirrors `db-create.ts`) creates
bucket `hc-local-media` if absent, using an S3 client built with the endpoint
override (see §3). Idempotent (ignore `BucketAlreadyOwnedByYou`).

### 2. Lifecycle wiring (gated on `--local`)

- **[scripts/dev.mjs](../../../scripts/dev.mjs):** when `--local`, start MinIO +
  create the bucket before the app boots, and add `MEDIA_BUCKET` +
  `MEDIA_S3_ENDPOINT` to the child env overlay (alongside the existing
  `DYNAMODB_ENDPOINT` local wiring). This is the S3 counterpart of local
  DynamoDB. `--mock` is unchanged; to actually exercise media you run
  `--local --mock` (local store + a source of inbound MMS), but the store turning
  on is purely a `--local` decision.
- **[scripts/e2e-session.mjs](../../../scripts/e2e-session.mjs):** the harness is
  always hermetic-local, so always start MinIO + create the bucket + set the env,
  next to the DynamoDB Local startup.
- **Teardown:** `e2e-stop.mjs` and `db:stop` stop the `hc-s3-local` container
  (best-effort, same as the DB container).

### 3. Config + mediaStore endpoint override

- **Config** ([app/src/lib/config.ts](../../../app/src/lib/config.ts)): add
  `mediaS3Endpoint?: string` from `MEDIA_S3_ENDPOINT`, analogous to
  `dynamodbEndpoint`. **Production guard:** reject a set `MEDIA_S3_ENDPOINT` when
  `NODE_ENV === 'production'` (mirrors the existing `TWILIO_API_BASE_URL` /
  dev-endpoint guards) — it is a local-only override.
- **mediaStore** ([app/src/adapters/mediaStore.ts](../../../app/src/adapters/mediaStore.ts)):
  when `config.mediaS3Endpoint` is set, build the `S3Client` with
  `{ endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } }`
  using local/dummy creds (MinIO needs path-style addressing and accepts any
  credentials) — the same shape as
  [app/src/lib/dynamo.ts](../../../app/src/lib/dynamo.ts). When unset, behavior
  is exactly as today (default SDK chain / instance role). `createMediaStore`
  still gates on `mediaBucket`; the endpoint only changes *where* the client
  points.

### 4. Canned dev assets → raster + PDF

Replace the three SVGs in
[fake-twilio/web/public/canned/](../../../fake-twilio/web/public/canned/):

| id | file | type | renders as |
|----|------|------|-----------|
| room | `room.png` | image/png | inline `<img>` |
| kitchen | `kitchen.png` | image/png | inline `<img>` |
| lease-doc | `lease-doc.pdf` | application/pdf | PDF preview link |

- Update [canned/index.ts](../../../fake-twilio/web/src/assets/canned/index.ts):
  the `url`/extension and labels; the `cannedLabelFor` matcher is unchanged.
- Picker thumbnails in
  [Composer.tsx](../../../fake-twilio/web/src/ui/Composer.tsx): PNGs render as the
  existing `<img>` thumb; the PDF asset shows a document icon/label rather than an
  `<img>` (a PDF in an `<img>` won't render).
- The committed PNGs/PDF stay small (these are dev fixtures).

### 5. Content-type policy

- Add `application/pdf` to `INLINE_MEDIA_TYPES`
  ([mediaTypes.ts](../../../app/src/lib/mediaTypes.ts)). SVG/HTML stay off it
  permanently. Everything not on the list keeps the existing safe-download path —
  no change.
- Add `.pdf → application/pdf` to the fake's `inferMediaContentType`
  ([signer.ts](../../../fake-twilio/src/engine/signer.ts)) so the simulated
  inbound MMS carries the right `MediaContentType`, which the mirror then stores.
- **CSP verification:** the serve response sets
  `Content-Security-Policy: default-src 'none'; sandbox`. For an inline image this
  is fine. For a PDF opened top-level (new tab) the browser's sandboxed native
  viewer should still render it, but the bare `sandbox` directive must be
  verified not to break the viewer; if it does, relax minimally for `application/
  pdf` responses (e.g. an allow-token that keeps scripts off) — to be confirmed
  during implementation and captured in a test/manual check. This is the one
  open risk; it does not affect the image path.

### 6. Per-attachment record (replaces the parallel-array risk)

Replace the message's `media_s3_keys: string[]` with one cohesive list:

```ts
media_attachments?: Array<{ s3Key: string; contentType: string }>
```

Index `i` identifies one attachment everywhere — the array element and the
`…/media/:i` serve URL. Key and type are written together, so "N keys / M types"
is unrepresentable.

Touch points (traced; call-recording path is separate and untouched):

- **[messagesRepo.ts](../../../app/src/repos/messagesRepo.ts):** item type
  (was `media_s3_keys`); `MessageAnnotations.mediaS3Keys` → `mediaAttachments`;
  `annotateMessage` writes `media_attachments`; update the debug log count.
- **[webhooks/twilio.ts](../../../app/src/routes/webhooks/twilio.ts):**
  `mirrorInboundMedia` records `{ s3Key: key, contentType: storedType }` per
  attachment (it already computes `storedType = normalizeStoredMediaType(...)` for
  the `put`); the dedupe check reads `persisted.media_attachments?.length`.
- **[api.ts](../../../app/src/routes/api.ts) serve endpoint:** index into
  `media_attachments[idx].s3Key`. The inline/attachment decision **still uses the
  live `Content-Type` from `getStream`** (authoritative, free) — the stored
  `contentType` is never the security gate.
- **[dashboard api/types.ts](../../../dashboard/src/api/types.ts):** the message
  shape carries `media_attachments` (serialized on the same path
  `media_s3_keys` took).
- **[dashboard MessageBubble.tsx](../../../dashboard/src/routes/thread/MessageBubble.tsx):**
  count + per-attachment render (see §7).

**Backward compatibility:** already-mirrored messages have the legacy
`media_s3_keys`. Add a single read-time normalization (in the repo item
hydration) that, when `media_attachments` is absent but `media_s3_keys` is
present, synthesizes `{ s3Key, contentType: 'application/octet-stream' }` (→
renders as a download, never broken). New writes always use `media_attachments`.
(The A2P campaign is still in review, so real legacy MMS is likely ~zero; the
shim is cheap insurance and can be dropped if we confirm no legacy data.)

### 7. Dashboard rendering

In [MessageBubble.tsx](../../../dashboard/src/routes/thread/MessageBubble.tsx),
render each attachment by its stored `contentType`:

- **image/\*** (allowlisted raster) → inline
  `<img src="/api/messages/:sid/media/:i">` (current behavior).
- **application/pdf** → a PDF chip/link that opens `…/media/:i` in a new tab; the
  serve endpoint sends it inline so the browser's viewer renders it.
- **anything else** → a download link (the endpoint forces the attachment).
- **No attachments mirrored** (mirror skipped/failed, e.g. bucket unset) → keep a
  placeholder chip (degraded but informative).

This replaces the unconditional `<img>` assumption and the static "(not yet
viewable)" placeholder for the mirrored case.

## Data flow (inbound MMS, local `--local --mock`)

1. Fake party sends a canned MMS → fake signs an inbound webhook with
   `MediaUrl0 = http://localhost:8889/canned/room.png`,
   `MediaContentType0 = image/png`.
2. App `/webhooks/twilio/sms` parses media, fetches the bytes
   (`adapter.getMediaStream`) from the fake host, and `mediaStore.put`s them to
   MinIO with `contentType = normalizeStoredMediaType('image/png') = image/png`.
3. The message records `media_attachments = [{ s3Key, contentType: 'image/png' }]`.
4. Dashboard thread load gets the message (incl. `media_attachments`) in one
   DynamoDB-backed read; chooses `<img src=…/media/0>` for the png.
5. The `<img>` request hits the authed serve endpoint → one `GetObject` from
   MinIO → streams bytes inline with `Content-Type: image/png`. Image renders.
   (PDF path: same, opened in a new tab, viewer renders.)

## Testing

**Unit**
- `mediaTypes`: allowlist includes `application/pdf`, still excludes
  `image/svg+xml` / `text/html`.
- fake `inferMediaContentType('.../x.pdf') === 'application/pdf'`.
- `mirrorInboundMedia` records `media_attachments` as `{s3Key, contentType}`
  pairs (update existing `mmsMedia.test.ts` / `twilioSmsWebhook.test.ts`).
- repo backward-compat: legacy `media_s3_keys` hydrates to
  `media_attachments` with `application/octet-stream`.
- dashboard `MessageBubble`: renders `<img>` for image/\*, a PDF link for
  application/pdf, a download link for other types (update `Thread.test.tsx`).

**E2E** (extend
[e2e/tests/flows/fake-twilio-sms.spec.ts](../../../e2e/tests/flows/fake-twilio-sms.spec.ts);
requires MinIO in the e2e stack per §2)
- Send a PNG canned image via the fake-phones UI → in the staff thread, assert an
  actual inline `<img>` whose `…/media/0` request returns **200** with an image
  content-type.
- Send the PDF canned asset → assert the PDF preview link is present and its
  `…/media/0` request returns **200** `application/pdf`.

## Risks / open items

1. **CSP vs. inline PDF viewer** (§5) — verify the `sandbox` CSP doesn't break
   top-level PDF rendering; relax minimally for pdf responses only if needed.
2. **Docker/MinIO availability** — adds a second required container for the local
   loop; document in RUNBOOK/README next to the DynamoDB Local prerequisite.
3. **Backward-compat shim** (§6) — keep unless we confirm no legacy MMS exists.

## Rollout

Single change set on `local-s3-media`. Local-only infra (MinIO) + a guarded
endpoint override + the pdf allowlist entry. The deployed media path is otherwise
unchanged; the `media_s3_keys` → `media_attachments` rename ships with a read-time
compat shim so existing data keeps working.
