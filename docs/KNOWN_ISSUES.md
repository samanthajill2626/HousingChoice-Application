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

## 2. [Medium · Test] `boards.spec.ts` relay-intro e2e failure (pre-existing)

- **Where:** [`e2e/tests/flows/boards.spec.ts`](../e2e/tests/flows/boards.spec.ts) — the
  "set up its relay thread → both parties get the intro text" test.
- **Status:** Pre-existing on `main`. Verified **unrelated** to the fake-twilio work — it
  fails identically with the fake-twilio branch's changes stashed, and the case-detail page
  renders fully (no crash/unmount). Unfixed.
- **Problem:** A relay-intro / pool-number provisioning gap — the relay-thread setup does
  not result in both parties receiving the intro text as the spec expects. (Distinct from
  the delivery-status render crash that *was* fixed on the fake-twilio branch.)
- **Next step:** Triage the relay-thread provisioning path (pool-number allocation +
  intro-text fan-out) against what the spec asserts; determine whether the spec or the
  implementation is stale.
