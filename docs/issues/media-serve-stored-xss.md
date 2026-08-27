---
id: media-serve-stored-xss
title: Stored XSS via served Content-Type on the same-origin MMS media endpoint
type: security
severity: high
status: resolved
area: app/media-serve
created: 2026-06-15
resolved: 2026-06-18
refs: app/src/routes/api.ts:2284-2304, app/src/lib/mediaTypes.ts, app/src/services/mediaMirror.ts:104, app/test/mmsMedia.test.ts
---

**Problem.** `GET /messages/:providerSid/media/:idx` served a **stored** `Content-Type`
that originates from inbound MMS media (`MediaContentType{i}`), same-origin, with no
allowlist. An inbound MMS whose media is served as `text/html` (or another active type)
could execute script in the dashboard origin → **stored XSS**. Inbound MMS media is
attacker-controllable, so this was a realistic vector. Pre-existing on `main`; surfaced
by a security review during the fake-twilio work — **not introduced by it**.

**Resolution (2026-06-18).** Two-layer allowlist anchored on a single source of truth
(`app/src/lib/mediaTypes.ts` — `INLINE_MEDIA_TYPES`: raster images + sandboxed PDF only;
SVG/HTML/XHTML deliberately excluded):

- **Read side (authoritative gate)** — `app/src/routes/api.ts:813-820` serves inline
  **only** when `isInlineMediaType(object.contentType)` holds; everything else (incl.
  `text/html`, `image/svg+xml`, `application/xhtml+xml`, absent/empty, and the legacy
  `media_s3_keys` fallback folded to `application/octet-stream` by `mediaAttachmentsOf`,
  `app/src/repos/messagesRepo.ts:329-337`) is forced to `application/octet-stream` +
  `Content-Disposition: attachment`. Runs on the actual S3 object's type, so it holds for
  objects persisted before the write-side fix. `isInlineMediaType` trims + lowercases
  before an exact set match, so `IMAGE/PNG`, surrounding space, and `…; charset=…`
  parameter forms cannot bypass it.
- **Write side (defense-in-depth)** — `app/src/routes/webhooks/twilio.ts:234-236` stores
  the mirrored type via `normalizeStoredMediaType(...)`, collapsing anything off the
  allowlist to `application/octet-stream` at rest.
- **Headers** — `X-Content-Type-Options: nosniff` app-wide (`app/src/app.ts:70-72`) and
  per-response, plus `Content-Security-Policy: default-src 'none'; sandbox` on the media
  response — script execution is neutered even if a renderer were reached.

**Not affected.** The call-recording endpoint (`app/src/routes/api.ts:752`) sources its
type from the recording store, hardcoded `audio/mpeg` at mirror time off the
HMAC-validated `recordingStatusCallback` — not MMS-sender-controllable.

**Tests.** `app/test/mmsMedia.test.ts` (malicious `text/html` + `image/svg+xml` →
octet-stream + attachment + CSP; write-side normalization) and `app/test/mediaTypes.test.ts`.

Adversarially re-audited 2026-06-18 and confirmed complete (no residual inline path,
including the legacy fallback). Migrated from the former `docs/KNOWN_ISSUES.md`.

**Amendment (2026-08-26, media content-type fidelity).** Three details of the
resolution above changed; the GUARANTEE did not.

- The read-side gate is now `resolveMediaTier` (`app/src/lib/mediaTypes.ts`),
  not `isInlineMediaType`, which keeps its own set and exact-match semantics
  for the outbound upload endpoint.
- Matching is on the media-type ESSENCE rather than the exact string, so the
  parameterized forms of ALLOWLISTED types are now admitted
  (`image/png; charset=x` reaches the inline tier). Safety rests on the
  CANONICAL OUTPUT instead of the matching: the resolver returns the
  allowlist's own constant, so a caller-supplied parameterized string never
  reaches a response header. Non-allowlisted types are unaffected -
  `text/html; charset=x` has essence `text/html` and still fails the gate.
- "Everything else is forced to octet-stream" is now two tiers: a DECLARABLE
  set of non-script-capable types (video, audio, HEIC, vCard, the OOXML
  documents) is served with its true Content-Type but ALWAYS as
  `Content-Disposition: attachment`, so it is downloaded and never rendered
  same-origin. Everything else, including every script-capable type and
  anything unrecognised, still gets octet-stream + attachment exactly as
  before.
- A FOURTH detail, in the write-side bullet above: the normalizer both MOVED and
  WIDENED. It is called at `app/src/services/mediaMirror.ts:104`, not in
  `webhooks/twilio.ts`, and `normalizeStoredMediaType` now returns
  `resolveMediaTier(...).canonical`, so a DECLARABLE type is PRESERVED at rest
  instead of being collapsed - "collapsing anything off the allowlist" now
  means off BOTH tiers. Nothing script-capable gained ground: those types still
  collapse to `application/octet-stream` at store time, and
  `app/test/mmsMedia.test.ts` still pins `text/html` doing exactly that.

See docs/superpowers/specs/2026-08-26-media-content-type-fidelity-design.md
sections 5.1 and 7.

Current anchors, since the line numbers inside the dated text above are stale
and were deliberately left as written: the serve block is
`app/src/routes/api.ts:2284-2304`, the tier resolver and both allowlists are in
`app/src/lib/mediaTypes.ts`, the write-side normalize call is
`app/src/services/mediaMirror.ts:104`, the legacy `media_s3_keys` fold is
`mediaAttachmentsOf` at `app/src/repos/messagesRepo.ts:1001` (unchanged - still
`application/octet-stream`), the app-wide `nosniff` header is
`app/src/app.ts:118`, and the unaffected call-recording endpoint is
`app/src/routes/api.ts:2168`.
