---
id: voice-verify-start-rate-limit
title: Cell verify-start has no rate limit and resets the attempt counter per call
type: security
severity: low
status: open
area: app
created: 2026-07-01
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
