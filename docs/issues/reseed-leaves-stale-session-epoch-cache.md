---
id: reseed-leaves-stale-session-epoch-cache
title: /__dev/reseed left the in-memory session-epoch cache stale → post-reseed dev-login rejected
type: bug
severity: med
status: resolved
area: app
created: 2026-06-29
resolved: 2026-06-29
refs: app/src/routes/dev.ts:128, app/src/middleware/auth.ts:100, app/src/lib/devRoutes.ts, app/src/index.ts
---

**Problem.** `POST /__dev/reseed` wiped + reseeded the users table but never touched
the in-memory `sessionEpochCache` (a 60s revocation cache shared by the auth
middleware). After a reseed, a freshly-minted dev-login session sealed its cookie with
the user's *reseeded* epoch, but the auth middleware validated against a *stale* cached
epoch (e.g. one bumped by an earlier sign-out, as `frame.spec` does) — so `/auth/me`
and `/api/me` returned 401 and the dashboard bounced back to the login screen.

This was latent: no existing spec dev-logged-in *after* a reseed within the 60s window.
The tenant-onboarding scenario suite is the first set to do so (it runs after
`flows/outbox.spec`, which reseeds), so all its `login()` calls failed in the full
suite while passing in isolation. Discovered via the sequence-diagram e2e work.

**Resolution (2026-06-29).** Added `clear()` to `SessionEpochCache`; created ONE shared
cache at the composition root (`index.ts`) and injected it into both `buildApp` and the
dev router (`maybeLoadDevRouter` → `createDevRouter`); the `/__dev/reseed` handler now
calls `sessionEpochCache.clear()` after `resetLocalData`, so no stale epoch survives a
reseed. Verified by the full e2e suite going green (31/31), including the scenario specs
that dev-login immediately after a reseed.
