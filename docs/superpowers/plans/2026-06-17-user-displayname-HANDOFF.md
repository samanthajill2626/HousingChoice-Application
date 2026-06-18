<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# User Display Name (Google profile name) — Handoff Summary

**Status:** ✅ Complete, reviewed, all green — **NOT merged** (left for the human to merge, per the handoff).
**Branch:** `user-displayname` (worktree `w:/tmp/hc-user-name`), branched from `4d68f12` (which already contains the merged `inbox-backend`/C8 slice).
**Commits (6):**
- `3019ef0` docs: implementation plan
- `2b1a2f9` feat(users): `UserItem.name` + `displayNameOf` + present-only name refresh in `activateOnLogin`/`touchLastLogin`
- `e2e954f` test(users): cover `activateOnLogin` whitespace-only name + `:name`-omission parity; clarify name-cap comment
- `5196c91` feat(auth): request `profile` scope + capture Google `name` claim; refresh `UserItem.name` every login
- `f653de3` feat(users): route inbox Assigned chip + admin users list through `displayNameOf`; seed user names; integration test

**Orchestration:** builder → reviewer (per task) + a final whole-branch adversarial review (opus). Final verdict: **Ready to merge = Yes; 0 Critical, 0 Important.**

---

## What changed
- **`app/src/repos/usersRepo.ts`** — `UserItem.name?: string`; exported **`displayNameOf(user) = name?.trim() || email || userId`** (THE canonical user-display-name resolver); `activateOnLogin(userId, sub, name?, at?)` and `touchLastLogin(userId, name?, at?)` now **present-only `SET #name`** (`#name` aliased — `NAME` is a DynamoDB reserved word).
- **`app/src/adapters/auth.ts`** — `GOOGLE_SCOPE` `'openid email'` → **`'openid email profile'`**; captures `claims['name']` into `AuthIdentity.name` (trim, cap **120**, blank/whitespace/non-string → `undefined`); never logged.
- **`app/src/services/resolveInvitedUser.ts`** — forwards `identity.name` to **both** login paths (`activateOnLogin` on first login, `touchLastLogin` on every subsequent login) and reflects it on the returned in-memory user. Audit payload unchanged (no name added).
- **`app/src/routes/inbox.ts`** — the Assigned chip's `assignment.name` now resolves through the canonical `displayNameOf` (replaced the inline resolver; `findById`→undefined still falls back to the assignee userId; per-request cache intact). **No wire-shape change** (`InboxRow.assignment` stays `{userId, name}`).
- **`app/src/routes/adminUsers.ts`** — `GET /api/users` projection adds `name: displayNameOf(u)` (secrets still stripped).
- **`app/src/lib/seedData.ts`** — both seeded users got a real `name` (founder → `Jordan Avery`, va → `Sam Rivera`) so dev/e2e and the Inbox show a real name without going through Google.

## How it was verified (autonomous = unit + API + DynamoDB-Local integration; NO browser stack)
- `npm test -w @housingchoice/app` → **1128 passed / 5 skipped** (the 5 skips are `staticSmoke`, unrelated). Run by the orchestrator on the final HEAD.
- `npm run typecheck -w @housingchoice/app` → clean.
- **Integration test (DynamoDB Local) ran green:** a login with a `name` claim persists `UserItem.name`; a re-login **without** a name claim **preserves** the stored name (present-only, no clobber); a changed name refreshes; `displayNameOf` falls back correctly.
- PII confirmed live: auth log lines carry only `{ sub }` — no name in any log/audit payload (dedicated PII tests + observed in the QA run).
- Browser/e2e verification is deliberately NOT run here — it's the gated post-merge integration pass the main session owns.

---

## ⚠️ Heads-up items for the human (must read before/after merge)
1. **Re-consent on next login.** Adding the `profile` scope means every user sees a **new Google permission prompt once** on their next login. No Google-console change is needed (`profile` is a standard OIDC scope).
2. **Names backfill lazily.** A user who hasn't logged in since this ships has **no stored name yet**, so their chip shows their **email** until their next login (then it backfills). This is the intended fallback (name → email → userId); nothing is broken in the meantime.
3. **No schema migration.** `name` is a plain attribute on `UserItem` (which already has `[key]: unknown`) — **no table/GSI change, no infra `apply`** needed before deploying this code.

## Contract notes & decisions (flagged, not silently diverged)
- **Inbox `assignment.name` reconciliation is DONE here, not deferred.** The original handoff deferred this to the main session "once both branches merge." Because `inbox-backend` has **already merged** into this branch's base (`4d68f12`), it is now a clean **same-branch** change, and `inbox.ts` already had the resolver inline — so it was routed through the canonical `displayNameOf` here. **No separate reconciliation is needed.** (The adversarial review confirmed this is the right call.)
- **The SSE `toConversationUpdatedEvent` was intentionally left emitting a bare `userId`** (not routed through `displayNameOf`). It is a pure synchronous `ConversationItem`→event mapper with no users-repo access, and `ConversationUpdatedEvent.assignment` is a wire shape the frontend binds to; the name is resolved at the REST layer (the inbox aggregator), and the frontend reconciles via refetch on the event. Routing it would change the wire shape and force a repo lookup at every emit site — out of proportion and unnecessary. (No consumer needs the name on the event.)
- **The C8 `assignment?: { userId, name }` REST shape did NOT change** — `name` is simply now populated with a real name when the assignee has one.
- **Refresh happens on EVERY login.** The handoff named `activateOnLogin`, but that runs only on the first login; to keep the name current on every login, `touchLastLogin` (the every-login update) was also extended. Both are present-only, so a missing/blank claim never clobbers a stored name.

## Out-of-scope observation (NOT introduced here — separate cleanup, do not block this merge)
`seedData.ts` seeds the founder with `role: 'founder_admin'`, but `UserRole` is `'admin' | 'va'` (the README deviation renamed it). This is **pre-existing** (this slice only added the `name:` line to that seed object; the role line is unchanged) and compiles because the seed array is typed with `unknown` values. It is **inert** with respect to this slice — `displayNameOf` and both projections ignore role, and the dev-login/session path behaves. Worth a separate cleanup ticket.

## Remaining deferred Minors (reviewer verdict: defer — cosmetic, non-blocking)
- `auth.ts` ~127: `.trim()` called twice (pure function; style only).
- `inbox.ts` ~197: a "userDisplayName removed" tombstone comment that will age poorly.
- `auth.test.ts` active-branch PII assertion is vacuous (the warn path isn't hit when `google_sub` matches; the PII-out-of-logs property is covered by other non-vacuous tests).
- Task-3 inbox tests live in a new top-level `describe` rather than nested in the existing assignment block (structural only).

## Operational note
DynamoDB Local (docker) was left running from the integration/QA run (idempotent `db:start`). Stop it with `npm run db:stop` if you don't need it.
