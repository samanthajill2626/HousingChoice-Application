---
id: public-welcome-text-global-cap
title: No global ceiling on public welcome texts - per-IP limits cannot stop a caller with many real addresses
type: improvement
severity: low
status: open
area: app/routes
created: 2026-10-12
updated: 2026-10-21
refs: app/src/routes/public.ts:614-624, app/src/app.ts:165, app/src/middleware/rateLimit.ts:81
---

**Problem.** The only fence on `POST /public/housing-fair` (the /join intake and the
flyer "Sign up" form, which share one endpoint) is the per-IP `/public` limiter
(`PUBLIC_RATE_LIMIT_MAX`, default 5 per minute per viewer). Every first capture of a
phone number sends the welcome text from the business number
(`app/src/routes/public.ts:614-624`). A per-IP limit bounds ONE address; it cannot bound a
caller who spreads sign-ups across many REAL addresses (a botnet, a residential-proxy
pool, a cloud account cycling instances). Such a caller still drives unbounded welcome
texts: SMS spend, plus STOP replies and complaints counted against the A2P campaign.

This is the residual left after
[`public-rate-limit-key-spoofable-xff`](public-rate-limit-key-spoofable-xff.md), which
stops ONE viewer from posing as many. Filed at Cameron's request as a VERY LOW priority
item (2026-10-12): no sighting, and the housing-fair volume is small.

**Suggested fix.** A process-wide ceiling on welcome texts per window (for example N per
hour across all callers), checked just before the send, with a WARN when it trips. Over
the ceiling the sign-up is still captured (the lead is not lost) but the welcome is held
or skipped (design how staff learn of a skipped welcome when this is built). Same single-instance
in-memory assumption as `createRateLimit` (`rateLimit.ts`). Pick N from real sign-up
volume before building.
