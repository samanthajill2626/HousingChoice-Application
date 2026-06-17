# User Display Name Backend Handoff — Google profile name on `UserItem` (ORCHESTRATOR PROMPT)

> **You are the ORCHESTRATOR for this backend slice.** Do NOT write all the code
> yourself. Drive specialist subagents — a **builder**, a **reviewer**, and an
> **adversarial reviewer** — and triage their findings, exactly as this project has
> done for every slice (BE1–BE6, C8). Use **superpowers:subagent-driven-development**
> to run each phase (builder TDD → reviewer → adversarial reviewer attacks). You
> decide which findings are real; fix those, drop pedantic ones. **Self-QA before
> declaring done.**

## Goal

Give workspace users a real **display name**, sourced from the Google **profile**
name claim, so the "Assigned" chip (and anywhere a user is shown) reads a person's
name instead of an email. This resolves flag #3 from the C8 Inbox handoff.

**Why now / context:** `UserItem` (`app/src/repos/usersRepo.ts:70`) stores only
`userId` / `email` / `role` — no name — because login requests OAuth scope
`'openid email'` (no `profile`) and users are invited by email. See the design note:
`docs/superpowers/specs/2026-06-17-inbox-design.md` → *Deferred / future → "Real
assignee display name"* (Cameron chose option A: Google profile name).

## Read first

- `docs/superpowers/specs/2026-06-17-inbox-design.md` (the Deferred note + the C8
  `assignment` shape — `assignment?: { userId, name }`, which does NOT change).
- `app/src/adapters/auth.ts` (OAuth: `GOOGLE_SCOPE` at :66; claim extraction ~:113 —
  note the **PII posture**: emails stay out of logs; keep names out of logs too).
- `app/src/routes/auth.ts:217` + `app/src/repos/usersRepo.ts:264`
  (`activateOnLogin` — the ONE update run on EVERY login; stamps `last_login_at`).
- `.claude/CLAUDE.md` + `documentation/GLOSSARY.md` (conventions).

## Worktree (isolation — required)

From the main checkout: `git worktree add w:/tmp/hc-user-name -b user-displayname HEAD`
then `cd` in. Branch from **local HEAD**. **Do NOT switch HEAD in the main checkout.
Do NOT merge or push to `main`** — leave branch `user-displayname` for the human to
merge and report back.

## Scope

1. **OAuth scope:** add `profile` to `GOOGLE_SCOPE` (`'openid email'` →
   `'openid email profile'`). No Google-console change needed (`profile` is a standard
   OIDC scope) — but **users re-consent once** on next login (call this out in your
   summary).
2. **Capture the name claim:** in `auth.ts`, extract the `name` claim (a non-empty
   string) alongside `email`. Trim; cap to a sane length (e.g. 120). Treat absent/blank
   as "no name" (do not fail login — email is the fallback).
3. **Store + refresh on UserItem:** add `name?: string` to `UserItem`. Write/refresh it
   in `activateOnLogin` (extend its signature to take the name) so it stays current on
   **every** login — one update, alongside `last_login_at`. (`if_not_exists` stays only
   for `google_sub`; `name` is a plain `SET` so it refreshes.)
4. **Shared resolver (the key reuse point):** add `displayNameOf(user): string` to the
   users module — `user.name?.trim() || user.email || user.userId`. Route EVERY
   user-name-for-display through it. Find the consumers: wherever a conversation's
   `assignment` (a bare `userId` string — `conversationsRepo.ts:121`) is serialized to
   a display name (the SSE `toConversationUpdatedEvent` and any assignment serializer),
   and the admin users list (`adminUsers.ts` — projecting a name is a nice-to-have).
5. **Dev seed:** the hermetic seed user(s) (e.g. `va@example.com`) don't go through
   Google — give them a `name` in the seed so dev/e2e and the Inbox show a real name.
6. **Fallbacks + PII:** name → email → userId, always. **Never log the name** (match
   the existing email-out-of-logs posture). `name` is freeform — trim, length-cap; do
   NOT lowercase/normalize it (unlike email).

## ⚠️ Coordination flag (do not silently diverge)

The **Inbox C8 slice** (branch `inbox-backend`, unmerged) currently resolves
`assignment.name` inline as **email → userId**. Once your shared `displayNameOf` lands
and both branches merge, that one spot must switch to the resolver. **Call this out in
your summary** as an integration reconciliation item (the main session owns it). Your
branch should make `displayNameOf` THE canonical way to resolve a user display name.

## Suggested phases (formalize with writing-plans, then build)

1. `UserItem.name` + `activateOnLogin` refresh + `displayNameOf` + unit tests.
2. OAuth scope + claim capture + login wiring + tests.
3. Route existing consumers through `displayNameOf`; seed name; adversarial review.

## Conventions & guardrails

- **DynamoDB Local / hermetic only** — adding `name` is a plain attribute write (NO
  table/GSI migration; `UserItem` already has `[key]: unknown`). Don't touch real AWS;
  if any access arises use the named profile + account-ID guard (default creds = WRONG
  account `961902293381`).
- `.env` edits template-first; no new env expected (scope is a code constant).
- Keep names out of logs (PII). TypeScript strict; match existing style.

## Adversarial review — hunt for

**PII leakage** (name in logs / error messages / audit payloads where it shouldn't
be), **missing-name fallback** correctness (claim absent/blank/whitespace → email,
never a crash or empty chip), **scope/consent correctness** (login still works;
`profile` actually requested), **dev-login path** (hermetic seed user has a name; the
non-Google path isn't broken), **stale name** (refreshes on re-login), **auth/session**
regressions, and missed consumers (a user shown by email somewhere you didn't route
through `displayNameOf`).

## Acceptance / verification (autonomous = unit + API/integration; NO browser stack)

- `npm test -w @housingchoice/app` green (existing suite + new tests), incl. an
  integration test that a login with a `name` claim persists + refreshes it and that
  `displayNameOf` falls back correctly.
- `npm run typecheck -w @housingchoice/app` clean.
- Do **NOT** run the browser hermetic stack (`e2e:session`). Browser/e2e verification
  is the gated post-merge integration pass the main session owns.

## Ports

Tests may use DynamoDB Local (8000); no browser stack. Don't run `e2e:session`. If the
Dynamo port is busy another run is active — don't run concurrently with another worktree.

## Reporting (do not merge)

When green + reviewed, **STOP**. Summary must include: the **re-consent** heads-up
(users see a new permission prompt next login), the **inbox `assignment.name`
reconciliation** item (switch to `displayNameOf` at integration), and the fallback
behavior for users who haven't re-logged-in (still email until then). Leave branch
`user-displayname` for the human to merge. If the C8 `assignment` wire shape needs to
change, it does NOT — flag any surprise rather than diverging.
