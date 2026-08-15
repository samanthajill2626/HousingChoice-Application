---
id: shared-google-oauth-client-dev-prod
title: dev and prod share one Google OAuth client (no separate prod client)
type: debt
severity: low
status: deferred
area: app/auth
created: 2026-08-15
refs: .env.prod.example, .env.dev.example
---

**Problem.** `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are the SAME values in dev
and prod - one Google Cloud OAuth client carries the redirect URIs for both
`https://dev.app.housingchoice.org` and `https://app.housingchoice.org`. A separate
prod client was deliberately NOT created for the M1.11 go-live (Cameron, 2026-08-15):
the app is internal-only and staff-facing, so the blast radius is small and the setup
cost was not worth spending on cutover week.

Consequences while it stands:

- A leak or rotation of the client secret hits BOTH stacks at once - rotating for dev
  forces a prod `secrets:push` + deploy in the same window, and vice versa.
- The Google consent screen, app name, branding and verification status are shared, so
  prod cannot be branded or verified independently of dev.
- Redirect-URI edits for dev are made on the client prod also depends on; a fat-finger
  that removes or rewrites a URI can break prod login.
- Access control does NOT depend on this. Login is invite-first (a Google account with
  no user record is refused 403 regardless), and `OAUTH_ALLOWED_DOMAINS` is a second
  fence. So a shared client does not widen WHO can get in, only what a compromise of
  the client itself would reach.

**Suggested fix.** Create a second OAuth client in the same Google Cloud project,
scoped to the prod origin only:

1. New OAuth 2.0 Client ID, authorized redirect URI for `https://app.housingchoice.org`
   only.
2. Put the new values in `.env.prod` (template-first via `.env.prod.example` if any
   comment changes), `npm run secrets:push -- prod`, then deploy.
3. Remove the prod redirect URI from the dev client so the two are genuinely disjoint.
4. Verify a prod login end-to-end before removing anything from the dev client.

No code change - both values are plain config the app already reads per env.
