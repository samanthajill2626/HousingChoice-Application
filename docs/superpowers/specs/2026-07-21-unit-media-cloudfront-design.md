# Unit photos via CloudFront (same-origin media reads) - design

Date: 2026-07-21
Status: approved by Cameron (brainstorm 2026-07-21); implementation pending
Feature branch: feat/unit-media-cloudfront (worktree w:/tmp/unit-media-cloudfront)

## Problem / context

Unit photos live in the shared private media bucket under keys
`unit-media/<unitId>/<uuid>` and are displayed today via presign-per-read
(`app/src/lib/unitMedia.ts` resolveUnitMedia, 1h presigned GET URLs) and
uploaded via browser-to-S3 presigned POST (`app/src/routes/units.ts`
photos/presign + photos/confirm). A deployed-only CSP incident forced the
bucket origin into `connect-src` AND `img-src` (main commits cf4dae03 +
061ddd8d). This feature is the agreed strategic follow-up: serve photo READS
through the EXISTING CloudFront distribution on the app's own domain so that

- (a) `img-src` returns to `'self' data: blob:` (bucket origin dropped), and
- (b) photos get real CDN caching (today every page render presigns fresh
  URLs and every fetch hits S3).

Uploads are OUT of scope: they stay browser-to-S3 presigned POST, and the
`connect-src` bucket allowance stays.

## Decisions (settled with Cameron 2026-07-21)

- D1 REMOVAL: on a `unit.media` edit that removes stored keys, best-effort
  DeleteObject the removed objects (own-namespace keys only, never legacy
  absolute-URL entries). Failure degrades to a WARN, never a 500. No
  automated CloudFront invalidation - a removed photo may serve from edge
  caches up to the TTL; manual invalidation is the operator escape hatch.
- D2 TTL: 7 days (604800 s) edge caching, and the same `Cache-Control:
  public, max-age=604800` stamped on viewer responses so browsers cache too.
  Keys are immutable server-minted uuids (bytes never change under a key),
  so long caching is safe; removal staleness up to 7 days is accepted.
- D3 FALLBACK ROUTE STREAMS (not 302): CSP checks a redirect's TARGET
  against `img-src`, so a 302-to-presigned-S3 would force the bucket origin
  to stay in `img-src` - defeating goal (a). The app route pipes bytes
  media store -> app -> browser, mirroring the existing recording / MMS
  media streaming routes.
- D4 LIVE-MODE LOCAL DEV FOLDED IN: `npm run dev` live mode gets
  `MEDIA_BUCKET` wired to the real dev media bucket (closes issue
  live-mode-local-dev-has-no-media-store), and dev terraform adds
  `http://localhost:5174` to the s3_media CORS `dashboard_origins` so
  direct presigned-POST upload works from localhost. Display needs no CORS
  (the fallback route streams server-side).
- D5 PUBLIC READ POSTURE - KNOWN AND DESIGNED: `/unit-media/*` is an
  unauthenticated read surface, both via CloudFront and via the app
  fallback route. See "Security posture" below. Cameron signed off
  explicitly; flag it in code comments and docs as designed, not an
  oversight.
- D6 PHASE-INDEPENDENT: the new origin + behavior are orthogonal to
  `custom_domain_phase` (the phase staircase only gates aliases and the
  viewer certificate). A relative `/unit-media/...` URL works on any host
  in every phase.

## Non-goals

- Uploads: unchanged (presigned POST direct to S3; `connect-src` keeps the
  bucket origin; the upload CORS rule stays POST-only apart from D4's new
  dev origin).
- The transcode feature's oversize-original orphans (see issue
  unit-photo-removal-never-deletes-s3-objects, 2026-07-21 update): NOT
  swept here. D1 covers removed-photo keys only.
- No CloudFront serving for the PII namespaces (`media/`, `recordings/`,
  `uploads/`): no behavior exists for them; they stay reachable only via
  the app's authenticated streaming routes.
- No automated invalidation wiring (no distribution id in app config, no
  cloudfront IAM for the app).

## Architecture

### Terraform

Module `infra/modules/cloudfront`:

- New variable: the media bucket's regional domain name (e.g.
  `<bucket>.s3.us-east-1.amazonaws.com`) - nullable/default null so envs
  without a media bucket keep working; the media origin + behavior are
  created only when set.
- New `aws_cloudfront_origin_access_control` (S3, sigv4, always sign).
- Second origin: the media bucket regional endpoint with
  `origin_access_control_id` set (S3 origin config, no custom headers - the
  x-origin-verify header is an app-origin concern only).
- New ordered behavior `path_pattern = "/unit-media/*"` targeting the media
  origin: allowed methods GET/HEAD (+OPTIONS is unnecessary - image reads
  are not CORS requests), cached methods GET/HEAD, compress on,
  viewer_protocol_policy redirect-to-https. The path forwards to S3 as-is,
  so URL path == object key; no origin path rewrite.
- New custom cache policy: min TTL 1, default TTL 604800, max TTL 604800;
  no cookies/headers/query strings in the cache key (S3 objects vary by
  path only). S3 sends no Cache-Control, so default TTL governs edge
  caching.
- New response headers policy on that behavior: `Cache-Control: public,
  max-age=604800` (override origin) + `X-Content-Type-Options: nosniff`.
- Output the distribution ARN (for the bucket policy statement).

Module `infra/modules/s3_media` (or the env stacks - implementer's call if
a module-level reference cycle appears; the cloudfront module needs the
bucket domain while the bucket policy needs the distribution ARN, and the
policy resource can live wherever that resolves cleanly):

- Bucket policy statement: Allow `s3:GetObject` to principal
  `cloudfront.amazonaws.com` on `arn:...:<bucket>/unit-media/*` ONLY,
  condition `AWS:SourceArn` == the distribution ARN. This is a
  service-principal policy scoped to one distribution - NOT a public
  policy, so the existing public-access block (`block_public_policy`)
  does not reject it. No `s3:ListBucket` grant (a missing object returns
  403 rather than 404 through CloudFront - acceptable; the browser just
  shows a broken/absent image).
- Dev only: add `http://localhost:5174` to `dashboard_origins` (D4).

Envs `infra/envs/dev` + `infra/envs/prod`: wire the new module inputs and
outputs symmetrically; prod values ride along but are applied only at the
M1.11 cutover.

### App

`app/src/lib/unitMedia.ts` - resolveUnitMedia stops presigning:

- A stored key that passes the existing own-namespace guard
  (`unit-media/<unitId>/...` for THIS unit) resolves to the RELATIVE URL
  `/unit-media/<unitId>/<uuid>` (i.e. `/` + key). Deterministic: no media
  store needed, no async S3 call, no TTL. Resolution succeeds even when no
  media store is configured (the URL may then 404 at the route - same
  visible outcome as today's url-absent degradation, an absent image).
- Foreign / out-of-namespace keys: unchanged - degrade to url-absent with
  the same WARN (this guard is what keeps MMS `uploads/` keys or another
  unit's keys from ever being emitted as URLs).
- Legacy absolute http(s) URLs: unchanged pass-through.
- UNIT_MEDIA_PRESIGN_TTL_SECONDS and the presign path die here if nothing
  else uses them; update stale comments (PRESIGN PER READ / D5-2026-07-15
  language) to describe the same-origin scheme.

New route `GET /unit-media/*` (app/src/app.ts wiring + a small router/
handler module):

- Registered BEFORE the SPA catch-all; UNAUTHENTICATED BY DESIGN (D5);
  fronted by the same per-IP rate limiter class the /public surfaces use.
- Path validation (normative): exactly two path segments after
  `/unit-media/` - one unitId segment, one object segment - each from a
  safe charset (no slashes beyond the two separators, no `.`/`..`
  traversal, no empty segments, no percent-encoded tricks after
  decoding). Anything else 404s. This encodes the namespace scoping: the
  route can never serve `media/`, `recordings/` or `uploads/` keys. (In
  practice every stored key's object segment is a server-minted uuid -
  no seeded or legacy non-uuid keys exist as of 2026-07-21 - but the
  route validates SHAPE, not strict uuid format.)
- 503 when no media store is configured (matches the presign/confirm
  posture); 404 when the object is absent (getStream undefined).
- Streams via `mediaStore.getStream(key)`: stored Content-Type served
  as-is when it is an allowed image type (isImageMediaType), else
  `application/octet-stream` (belt-and-suspenders - upload pins the type
  at presign, so non-image types should not exist in this namespace);
  `X-Content-Type-Options: nosniff`; `Cache-Control: public,
  max-age=604800` (parity with the CloudFront response headers policy).
  Mirror the existing recording/MMS streaming routes' error handling
  (never leak errors as 500 pages with internals; destroyed-stream
  guard).
- In deployed envs CloudFront intercepts the path first, so this route is
  a fallback there (still correct if hit - e.g. during a
  deploy-before-apply window, where it streams from real S3 via the
  instance role). It is THE serving path for local dev (MinIO), hermetic
  e2e, and live-mode local dev.

Removal delete (D1), `app/src/routes/units.ts` + adapter:

- New `deleteObject(key)` on the MediaStore interface + S3 impl
  (DeleteObject; absent-object delete is a success no-op in S3).
- Where a `unit.media` edit removes stored keys (the PATCH media seam -
  diff previous list vs new list), fire-and-forget best-effort deletes for
  each removed key that is inside THIS unit's own namespace
  (unitMediaPrefix guard; legacy absolute URLs and foreign keys are never
  deleted). Each failure logs WARN (key + unitId, never a URL) and does
  not affect the API response. The unit.media write itself is unchanged
  and remains the source of truth.

CSP, `app/src/app.ts`:

- `img-src` returns to `'self' data: blob:` - the mediaOrigin allowance is
  removed from img-src ONLY.
- `connect-src` keeps the mediaOrigin allowance (presigned-POST uploads).
- Update the explanatory comment block; update
  `app/test/staticSmoke.test.ts` assertions to pin the new shape (img-src
  WITHOUT the bucket origin even when MEDIA_BUCKET is set; connect-src
  still WITH it).

Live-mode local dev (D4), `scripts/dev.mjs`:

- In live mode, when MEDIA_BUCKET is not already set, resolve the real dev
  bucket name `hc-dev-media-<accountId>` (account id via STS
  GetCallerIdentity using the same credential chain the live stack already
  uses for DynamoDB) and export it to the app + worker env. No
  MEDIA_S3_ENDPOINT (real S3). Failure to resolve degrades to today's
  storeless behavior with a clear console note, never a startup crash.

### Flyer + dashboard consumers

No consumer changes expected: both render `mediaDisplay[].url` as `<img
src>`; relative URLs are same-origin and CSP-clean. Verify the flyer
(`/p/:unitId`), the dashboard gallery, and the MMS attach-photo picker all
render from the new URLs (readers/renderers sweep - any consumer that
assumed an absolute URL is a bug to fix in this feature).

## Security posture (D5 - known and designed)

`/unit-media/*` is a PUBLIC, UNAUTHENTICATED read surface:

- Unit photos already render on the public flyer; the exposure class is
  unchanged. Protection is the unguessable server-minted uuid, as today -
  minus the 1h expiry presigned URLs had.
- WIDENING, accepted: ANY existing object under `unit-media/*` is
  fetchable by whoever knows its key - including uploaded-but-never-
  confirmed objects, removed-but-still-cached photos (up to 7 days), and
  the transcode feature's oversize originals. There is deliberately NO
  per-request check that a key appears in some unit's `media` list:
  CloudFront cannot do that check, and the fallback route matches
  CloudFront exactly so every environment behaves the same.
- Content is image-only by construction: the presigned-POST policy pins
  each object's Content-Type to the image allowlist at mint time, so
  nothing scriptable (e.g. image/svg+xml) can exist in the namespace; the
  route additionally refuses to serve a non-image type inline, and nosniff
  is stamped everywhere.
- The PII namespaces (`media/`, `recordings/`, `uploads/`) remain
  unreachable: no CloudFront behavior, OAC grant scoped to
  `unit-media/*` only, route path validation rejects them.

## Error handling summary

- resolveUnitMedia: never throws; foreign key -> url-absent WARN (as
  today).
- Route: 404 malformed path or absent object; 503 storeless; stream errors
  never crash the process (destroyed-stream guard as in existing media
  routes).
- Delete-on-removal: best-effort, WARN per failed key, API response
  unaffected.
- CloudFront: missing object serves 403 from S3 (no ListBucket) - rendered
  as a broken image; error caching keeps that brief.

## Testing

- Unit: route path validation (accepts the canonical shape; rejects PII
  namespaces, traversal, extra segments), 404/503 paths, header
  assertions (Content-Type, nosniff, Cache-Control), non-image stored
  type served as octet-stream; resolveUnitMedia relative-URL resolution +
  unchanged guards (foreign key, legacy URL); delete-on-removal fires for
  removed own-namespace keys only, WARN-not-500 on failure;
  staticSmoke CSP assertions updated.
- E2e: photo display end-to-end through the fallback route (hermetic
  stack has no CloudFront - the route IS the path under test); upload ->
  gallery -> flyer flow still green with relative URLs; removal leaves
  the gallery consistent. Adapt any existing spec that asserted presigned
  absolute URLs.
- Live self-QA (e2e:session + Playwright MCP): gallery + flyer render,
  network panel shows same-origin /unit-media/* image requests (the
  architectural claim), no CSP violations in the console, upload still
  works (connect-src unchanged).
- Terraform: `terraform validate` / `npm run plan` is Cameron's; the
  implementer authors config only (NO apply - repo law).

## Rollout (owed operator actions - record in handback + RUNBOOK)

1. Merge (Cameron's gate) -> dev `npm run plan` + `apply` (new OAC,
   origin, behavior, cache + response policies, bucket policy statement,
   dev CORS origin).
2. Dev deploy (app changes: route, resolver, CSP, delete-on-removal,
   dev.mjs).
   Order vs apply is NOT critical (deploy-first serves photos via the EC2
   fallback route; apply-first is inert until the app emits relative
   URLs) - but do both, then verify.
3. Verify on dev: photo renders on dashboard + flyer from
   /unit-media/*; response served by CloudFront (x-cache header) with
   Cache-Control; CSP header shows img-src without the bucket origin;
   /media/... and /recordings/... paths do NOT serve from CloudFront;
   upload still works; removal deletes the S3 object (console check) and
   the cached copy is accepted to linger <= 7 days.
4. Prod rides the M1.11 cutover, matching how the s3_media upload CORS
   was staged.

## Issues touched

- unit-photo-removal-never-deletes-s3-objects: removed-photo class CLOSED
  by D1 (update the issue; oversize-original class stays open, owned by
  the transcode follow-up).
- live-mode-local-dev-has-no-media-store: CLOSED by D4 (update the
  issue).
- media-serve-stored-xss: unaffected (different namespace/route), but the
  new route must cite the same inline-type hardening rationale.

## Related in-flight work

unit-photo-transcode (separate branch, spec'd 2026-07-21) raises the
upload cap and writes jpeg renditions as NORMAL `unit-media/<unitId>/<uuid>`
keys - it composes with this feature with no coordination beyond normal
branch hygiene against main. Its oversize originals become fetchable-by-key
under D5 (accepted) and are NOT deleted by D1.
