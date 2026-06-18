# Known Issues

Findings surfaced during development that are **not yet fixed**, tracked here because
the repo has no lightweight issue tracker wired up (the `origin` remote is Azure DevOps;
GitHub `gh` issues are unavailable). Move these to Azure Boards work items if/when that's
the preferred tracker.

---

## 1. [HIGH · Security] Stored XSS via served `Content-Type` on the same-origin MMS media endpoint — ✅ RESOLVED

- **Where:** [`app/src/routes/api.ts`](../app/src/routes/api.ts) — the media-serve handler
  (`GET /messages/:providerSid/media/:idx`).
- **Status:** **RESOLVED.** Defense added across both write and read paths; adversarially
  re-audited 2026-06-18 and confirmed complete (no residual inline path for a dangerous
  type, including the legacy `media_s3_keys` fallback). Pre-existing on `main`; surfaced by
  an automated security review during the fake-twilio work — **not introduced by fake-twilio.**
- **Problem:** The endpoint served a **stored** `Content-Type` that originates from inbound
  MMS media (`MediaContentType{i}`), same-origin, with no allowlist. An inbound MMS whose
  media is served as `text/html` (or another active type) can execute script in the
  dashboard origin → **stored XSS**. Inbound MMS media is attacker-controllable, so this was
  a realistic vector, not theoretical. Internal/authenticated does not mitigate it.
- **Fix:** A two-layer allowlist anchored on a single source of truth
  ([`app/src/lib/mediaTypes.ts`](../app/src/lib/mediaTypes.ts)) — `INLINE_MEDIA_TYPES`
  (raster images + sandboxed PDF only; SVG/HTML/XHTML deliberately excluded):
  - **Read side (authoritative gate):** [`app/src/routes/api.ts:813-820`](../app/src/routes/api.ts#L813-L820)
    serves inline **only** when `isInlineMediaType(object.contentType)` holds; everything
    else (incl. `text/html`, `image/svg+xml`, `application/xhtml+xml`, absent/empty, and the
    legacy `media_s3_keys` fallback which `mediaAttachmentsOf` folds to `application/octet-stream`,
    [`app/src/repos/messagesRepo.ts:329-337`](../app/src/repos/messagesRepo.ts#L329-L337)) is
    forced to `application/octet-stream` + `Content-Disposition: attachment`. This gate runs
    on the actual S3 object's type, so it holds even for objects persisted before the
    write-side fix. `isInlineMediaType` trims + lowercases before an exact set match, so
    `IMAGE/PNG`, leading/trailing space, and `…; charset=…` parameter forms cannot bypass it.
  - **Write side (defense-in-depth, layer 1):** [`app/src/routes/webhooks/twilio.ts:234-236`](../app/src/routes/webhooks/twilio.ts#L234-L236)
    stores the mirrored object's `Content-Type` via
    `normalizeStoredMediaType(MediaContentType{i})`, collapsing anything off the allowlist to
    `application/octet-stream` at rest.
  - **Headers:** `X-Content-Type-Options: nosniff` is set both app-wide
    ([`app/src/app.ts:70-72`](../app/src/app.ts#L70-L72), global middleware ahead of all routers)
    and per-response, plus a restrictive `Content-Security-Policy: default-src 'none'; sandbox`
    on the media response ([`app/src/routes/api.ts:819-820`](../app/src/routes/api.ts#L819-L820)) —
    so even if a renderer were somehow reached, script execution is neutered.
- **Not affected:** the call-recording endpoint
  ([`app/src/routes/api.ts:752`](../app/src/routes/api.ts#L752), `object.contentType ?? 'audio/mpeg'`)
  serves a content-type sourced from the recording store, hardcoded `'audio/mpeg'` at mirror
  time ([`app/src/routes/webhooks/voice.ts:1344`](../app/src/routes/webhooks/voice.ts#L1344))
  off the HMAC-validated `recordingStatusCallback` — not MMS-sender-controllable.
- **Tests:** route-level XSS guards (malicious type → octet-stream + attachment + CSP) at
  [`app/test/mmsMedia.test.ts:186-218`](../app/test/mmsMedia.test.ts#L186-L218) (`text/html`
  and `image/svg+xml`), write-side normalization at
  [`app/test/mmsMedia.test.ts:109-119`](../app/test/mmsMedia.test.ts#L109-L119), and the
  allowlist unit tests in [`app/test/mediaTypes.test.ts`](../app/test/mediaTypes.test.ts).

---

## 2. [Medium · Test] `boards.spec.ts` relay-intro e2e failure — ✅ RESOLVED

- **Where:** [`e2e/tests/dashboard/boards.spec.ts`](../e2e/tests/dashboard/boards.spec.ts) — the
  "set up its relay thread → both parties get the intro text" test.
- **Status:** **RESOLVED** on the fake-twilio voice work. Live-verified green
  (`boards.spec.ts` → `ok … both parties get the intro text`, full `5 passed` run incl. the
  voice flows).
- **Root cause (two parts):** the relay-thread setup provisions a pool number, which the
  fake-twilio mock used to `501` (`AvailablePhoneNumbers`/`IncomingPhoneNumbers.json`), AND
  — once those were implemented — the app's `relayLiveProvisioning` kill-switch still
  defaulted OFF under `MESSAGING_DRIVER=twilio`, returning `503 relay_provisioning_disabled`
  before reaching the fake.
- **Fix:** (a) the fake now implements real number provisioning (Phase 6 of the voice work);
  (b) `config.relayLiveProvisioning` now defaults ON when `twilioApiBaseUrl` is set (mock
  mode) — explicit `RELAY_LIVE_PROVISIONING` still wins; prod-safe because
  `TWILIO_API_BASE_URL` is rejected at boot in production. With both, the pool number is
  minted through the fake and the intro SMS fans out to both parties as the spec asserts.
