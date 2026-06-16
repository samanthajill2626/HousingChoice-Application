# Known Issues

Findings surfaced during development that are **not yet fixed**, tracked here because
the repo has no lightweight issue tracker wired up (the `origin` remote is Azure DevOps;
GitHub `gh` issues are unavailable). Move these to Azure Boards work items if/when that's
the preferred tracker.

---

## 1. [HIGH · Security] Stored XSS via served `Content-Type` on the same-origin MMS media endpoint

- **Where:** [`app/src/routes/api.ts`](../app/src/routes/api.ts) — the media-serve handler
  (`res.setHeader('Content-Type', object.contentType ?? 'application/octet-stream')`).
- **Status:** Pre-existing on `main`; surfaced by an automated security review during the
  fake-twilio work. **Not introduced by fake-twilio.** Unfixed.
- **Problem:** The endpoint serves a **stored** `Content-Type` that originates from inbound
  MMS media (`MediaContentType{i}`), same-origin, with no allowlist. An inbound MMS whose
  media is served as `text/html` (or another active type) can execute script in the
  dashboard origin → **stored XSS**. Inbound MMS media is attacker-controllable, so this is
  a realistic vector, not theoretical. Internal/authenticated does not mitigate it.
- **Suggested fix:** Restrict the served `Content-Type` to a strict image allowlist and
  force attachment disposition for anything else, e.g.:
  ```ts
  const SAFE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const ct = object.contentType && SAFE_IMAGE_TYPES.has(object.contentType.toLowerCase())
    ? object.contentType : 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', ct === 'application/octet-stream' ? 'attachment' : 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  ```
  Additionally validate/normalize `MediaContentType{i}` at mirror time in the inbound
  webhook handler (`app/src/routes/webhooks/twilio.ts`) and reject anything outside the
  allowlist before storing. The fake-twilio mock can now reproduce this end-to-end by
  sending an MMS with a hostile content-type via `POST /control/send-as-party`.

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
