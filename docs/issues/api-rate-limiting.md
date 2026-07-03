---
id: api-rate-limiting
title: No rate limiting on the /api manual-send route
type: security
severity: med
status: resolved
area: app/api
created: 2026-06-11
resolved: 2026-07-02
refs: app/src/middleware/rateLimit.ts, app/src/routes/api.ts, docs/superpowers/specs/2026-07-02-api-rate-limiting-design.md
---

**Problem.** The `/api` manual-send route has no Express rate limit. It is
origin-secret-protected only, so a leaked origin secret currently means unthrottled sends.

**Suggested fix.** Add an Express rate limit on the manual-send route. (Originally framed as
"before M1.3 auth lands"; OAuth/RBAC reduces but does not remove the case for throttling.)

Migrated from the RUNBOOK "Security / hardening backlog".

**Resolution (2026-07-02).** Shipped per the design spec
(`docs/superpowers/specs/2026-07-02-api-rate-limiting-design.md`): a per-USER
sliding-window limiter (`createUserRateLimit` in `app/src/middleware/rateLimit.ts`,
keyed by session userId — every metered route sits behind `requireAuth`, and a
leaked origin secret without a session gets 401 before any limiter) now fronts
all four send/call-cost routes, not just manual send: manual 1:1 send (30/min,
`RATE_LIMIT_MANUAL_SEND_PER_MIN`), broadcast send (5/min,
`RATE_LIMIT_BROADCAST_SEND_PER_MIN`), call originate (10/min,
`RATE_LIMIT_ORIGINATE_PER_MIN`), and cell verify-start (3/3 min,
`RATE_LIMIT_VERIFY_START_MAX` + `_WINDOW_MS`). On limit: 429
`{ error: 'rate_limited' }` + `Retry-After` seconds + an IDs-only WARN. The
message **retry** route (`POST .../messages/:providerSid/retry`) shares the SAME
`manualSendLimiter` budget as the send route — it fires a real SMS and escapes
the per-conversation breaker (`automated:false`), and a retry never clears the
original's `failed` status, so an un-metered retry could be re-fired unbounded;
sharing the one 30/min window closes that (spec §1's stuck-retry threat) without
granting a separate budget. The hermetic e2e stack raises the ceilings
(`scripts/e2e-session.mjs`); RUNBOOK "Security / hardening" documents tuning.
Companion issues resolved in the same change: `voice-verify-start-rate-limit`,
`voice-bridge-dnc-recheck`.
