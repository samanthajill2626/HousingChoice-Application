---
id: voice-verify-start-rate-limit
title: Cell verify-start has no rate limit and resets the attempt counter per call
type: security
severity: low
status: resolved
area: app
created: 2026-07-01
resolved: 2026-07-02
refs: app/src/routes/voiceApi.ts:181, app/src/repos/usersRepo.ts:573
---

**Problem.** The self-service cell verification endpoint (`POST /api/me/cell/start`,
Voice Phase 1 §7) has no rate limiting, and each call resets the pending-code attempt
counter to 0 (`startCellVerification`). The route is behind `requireAuth` (staff-only)
and sends the code via `adapter.sendMessage` directly (deliberately NOT the A2P-metered
consumer path — this is an internal staff line), so the blast radius is bounded to
authenticated staff. But an authenticated staffer could (a) SMS-bomb an arbitrary typed
number by repeatedly calling start, and (b) weaken the `confirm` brute-force ceiling
(`CELL_VERIFY_MAX_ATTEMPTS`) by restarting to get a fresh attempt budget. No unauth path,
no PII leak. Flagged by the Voice Phase 1 security + final reviews as a hardening gap
(defer, not merge-blocking).

**Suggested fix.** Add a per-user minimum resend interval (e.g. 30–60s between start
calls) and/or a max-active-pending guard on verify-start; consider not zeroing the
attempt counter on a resend within the same TTL window. Front the route with a
per-user rate limiter analogous to `rateLimit.ts` (currently only on the public surface).

**Resolution (2026-07-02).** Shipped with the per-user rate-limits feature
(design: `docs/superpowers/specs/2026-07-02-api-rate-limiting-design.md`):
`POST /api/users/me/cell/verify-start` now sits behind a per-user
sliding-window limiter (`createUserRateLimit` in `app/src/middleware/
rateLimit.ts`) — default **3 starts per 3 minutes** per user
(`RATE_LIMIT_VERIFY_START_MAX` + `RATE_LIMIT_VERIFY_START_WINDOW_MS`). The
limiter runs BEFORE the handler, so a 429'd start sends NO SMS and leaves the
pending-verification state (code hash / expiry / attempts) untouched. That
bounds both abuse cases: (a) SMS-bombing a typed number is capped at 3/3 min,
and (b) attempt-counter resets are budget-bound — a staffer can no longer
restart budget-free (the per-spec judgement: with the ceiling, no further
attempt-counter change is needed). On limit: 429 `{ error: 'rate_limited' }` +
`Retry-After`. Covered by unit tests (4th start in the window → 429, no SMS
dispatched, pending state untouched).
