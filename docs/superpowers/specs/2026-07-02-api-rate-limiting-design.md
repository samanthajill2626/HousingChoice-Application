<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# Per-user rate limits on the send/call-cost API routes

**Date:** 2026-07-02 · **Status:** design (ready for implementation plan)
**Resolves:** `docs/issues/api-rate-limiting.md` (med),
`docs/issues/voice-verify-start-rate-limit.md` (low), and — bundled small fix —
`docs/issues/voice-bridge-dnc-recheck.md` (low).

## 1. Why

Four authenticated routes spend real money and touch real phones (SMS sends,
ringing calls), and none is throttled. OAuth/RBAC bounds WHO can call them, but
nothing bounds HOW FAST — a runaway dashboard loop, a stuck retry, or a misused
session can machine-gun texts/calls from the business number (Twilio spend +
carrier-reputation damage + harassment of a real phone). The public surface
already has a per-IP fence (`PUBLIC_RATE_LIMIT_MAX`); this adds the equivalent
for the authenticated send-cost routes.

## 2. Design

**Keying: per USER (session userId), not per IP.** Staff share office IPs, and
every one of these routes sits behind `requireAuth` — the user identity is the
meaningful actor. (A leaked origin secret without a session gets 401 before any
limiter.)

**Ceilings (LOCKED, per user; code defaults, env-overridable):**

| Route | What it costs | Default | Env override |
|---|---|---|---|
| Manual 1:1 send (the send route in `routes/api.ts` — the one carrying the JIT consent gate) | an SMS | **30 / min** | `RATE_LIMIT_MANUAL_SEND_PER_MIN` |
| Broadcast send (`POST /api/broadcasts/:id/send`, `routes/broadcasts.ts`) | a fan-out trigger | **5 / min** | `RATE_LIMIT_BROADCAST_SEND_PER_MIN` |
| Call originate (`POST /api/contacts/:id/call`, `routes/voiceApi.ts`) | rings two real phones | **10 / min** | `RATE_LIMIT_ORIGINATE_PER_MIN` |
| Cell verify-start (`POST /api/users/me/cell/verify-start`, `routes/voiceApi.ts`) | an SMS to ANY typed number | **3 / 3 min** | `RATE_LIMIT_VERIFY_START_MAX` + `RATE_LIMIT_VERIFY_START_WINDOW_MS` |

**Mechanism:** one small shared middleware/helper (e.g. `app/src/middleware/
rateLimit.ts` or lib) — an in-memory sliding-window counter keyed
`(routeKey, userId)`. No new dependency needed unless the implementer prefers
`express-rate-limit` with a custom key — judgement call; in-memory is fine (the
app deploys as a single process; note that multi-instance scaling would need a
shared store — leave a comment, don't build it).

**On limit:** HTTP **429**, machine-readable body `{ error: 'rate_limited' }`
(+ `Retry-After` seconds header). NEVER drop silently. Audit/log at IDs-and-
counts level only (PII: no phone/body in the log line).

**Dashboard:** the four calling surfaces must show a sane inline message on 429
("Sending too fast — try again in a moment"), not a crash or a stuck spinner.
Reuse each surface's existing error affordance; keep it minimal.

**verify-start extra (from its issue):** a resend must NOT reset the code-guess
attempt counter budget-free — with the 3/3min ceiling this is bounded; no
further change needed beyond the limiter.

## 3. Bundled fix — voice-bridge-dnc-recheck

At press-1 on the outbound whisper gate (the OUTBOUND branch in
`routes/webhooks/voice.ts`, where `resolveOutboundTarget` runs), RE-CHECK the
target contact's `voice_opt_out` before `<Dial>`: if it was set after originate
(the seconds-wide race the issue documents), `<Hangup>` instead of dialing, log
IDs-only. Mark the issue resolved in the same branch.

## 4. Hermetic-stack + test interplay (IMPORTANT)

The e2e suite legitimately drives these routes faster than production defaults
(many specs share the one dev-login user within minutes). Mirror the
`PUBLIC_RATE_LIMIT_MAX` precedent: `scripts/e2e-session.mjs` sets every
`RATE_LIMIT_*` env high (e.g. 100000) so the hermetic suite never trips —
an externally-set value still wins. `npm run dev` keeps production defaults
(a human dev can't trip 30/min by hand; if it annoys, `.env` overrides).

## 5. Testing

- **Unit:** the limiter helper (window roll-over, per-user isolation, per-route
  isolation, env overrides); each route returns 429 + `Retry-After` past the
  ceiling and recovers after the window (drive with tiny env ceilings or fake
  timers). verify-start: 4th request within the window → 429, no SMS dispatched.
  DNC re-check: contact opted out between originate and press-1 → hangup TwiML,
  no `<Dial>`.
- **e2e:** one focused spec with the env ceiling set low is OPTIONAL (unit
  coverage suffices); the FULL suite must stay green under the raised hermetic
  ceilings (that's the real regression risk).

## 6. Env / template-first

Document the `RATE_LIMIT_*` vars in `.env.example` + `.env.dev.example` +
`.env.prod.example` as comments with the defaults (values only set when
overriding). No infra/terraform change. Update RUNBOOK's hardening section
(rate limits now exist; how to tune).

## 7. Out of scope

Public-surface limits (exist), per-IP keying, a shared limiter store for
multi-instance, webhook-route limits (Twilio-signed), read-route limits.
