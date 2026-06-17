# User Display Name (Google profile name on `UserItem`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give workspace users a real display name sourced from the Google `profile` name claim, exposed through ONE canonical resolver `displayNameOf(user)`, so the Inbox "Assigned" chip (and any user-shown surface) reads a person's name instead of an email. Resolves flag #3 from the C8 Inbox handoff.

**Architecture:** Add `name?: string` to `UserItem`; request the `profile` OAuth scope and capture the `name` claim into `AuthIdentity` (trimmed, length-capped, blank→absent, never logged); refresh `name` on the users table on EVERY login (first login via `activateOnLogin`, subsequent logins via `touchLastLogin`) — present-only so a missing claim never clobbers a stored name; add `displayNameOf(user) = user.name?.trim() || user.email || user.userId` to the users module and route every user-name-for-display through it.

**Tech Stack:** TypeScript (strict), Express, DynamoDB single-table repos (`UserItem` already has `[key]: unknown` — no table/GSI migration), openid-client OAuth adapter, Vitest + supertest, DynamoDB-Local integration tests. Node 24.

## Global Constraints

- **PII posture (doc §9):** emails are kept out of steady-state logs; **keep the name out of logs too** — never log `name` in the auth adapter, `resolveInvitedUser`, the repo, or anywhere. The auth adapter's `log.info({ sub }, …)` and `resolveInvitedUser`'s `log.info({ userId, role }, …)` stay exactly as they are (no name added).
- **Fallback is always name → email → userId.** A login must NEVER fail because the name claim is absent/blank; the chip must never be empty.
- **`name` is freeform:** trim and length-cap (120) but do **NOT** lowercase/normalize it (unlike email).
- **No wire-shape changes.** The C8 `assignment?: { userId, name }` REST shape does NOT change. The SSE `ConversationUpdatedEvent.assignment` stays a bare `userId` string (see Decision 4).
- **No new env, no Google-console change** (`profile` is a standard OIDC scope; the scope is a code constant). `.env` edits would be template-first, but none are expected.
- **DynamoDB Local / hermetic only.** Never touch real AWS; if access arises use the named profile + account-ID guard (default creds = WRONG account `961902293381`).
- **Match existing code style; TypeScript strict.** `UserItem` already carries `[key: string]: unknown`, so adding `name` is a plain attribute write (no migration).

## Key design decisions (baked in — the adversarial review will check these)

1. **`displayNameOf(user): string` is THE canonical resolver** — `user.name?.trim() || user.email || user.userId`. Lives in `app/src/repos/usersRepo.ts` (exported). Note the `.trim()`: a whitespace-only name falls through to email.
2. **Refresh on EVERY login, not just first.** `activateOnLogin` runs only on the first login (it writes `google_sub` and flips status); `touchLastLogin` runs on every subsequent login. To keep the name current, BOTH must SET `name` when a name is provided. (The handoff text named only `activateOnLogin`; this satisfies its stated "stays current on every login" requirement and the adversarial "stale name → refreshes on re-login" check.)
3. **Present-only SET — never clobber.** `name` is written ONLY when a non-empty (already-trimmed) name is passed. When the claim is absent/blank, the UpdateExpression omits `name` entirely, so a previously-stored name is preserved (a user who re-logs-in on a client that didn't return the profile claim does not lose their name). `name` is a plain `SET` (refreshes), unlike `google_sub`'s `if_not_exists`.
4. **The SSE `toConversationUpdatedEvent` is NOT changed.** It maps a `ConversationItem` → event synchronously and emits `assignment` as the bare `userId` string (`events.ts:94`); it has no users-repo access. Resolving a name there would (a) change the wire shape the frontend binds to and (b) require a users-repo lookup at every emit site (webhook/send/read/assign). The name is resolved at the REST layer (the inbox aggregator). **Decision: leave the event as a bare userId; flag in summary.**
5. **`name` reserved word:** DynamoDB reserves `NAME`, so every UpdateExpression touching it uses `ExpressionAttributeNames` `#name → 'name'`.
6. **The inbox consumer is in-scope here.** Since `inbox-backend` has merged to main (this branch's base is `4d68f12`), the inbox `assignment.name` reconciliation the C8 handoff deferred to the main session is now a single-branch change; `inbox.ts` already has the resolver inline (`userDisplayName`, `inbox.ts:198`). Route it through the canonical `displayNameOf`. Flag prominently in the summary (not a silent divergence).

---

## File Structure

- **Modify** `app/src/repos/usersRepo.ts` — add `name?: string` to `UserItem`; add exported `displayNameOf(user)`; extend `activateOnLogin(userId, googleSub, name?, at?)` and `touchLastLogin(userId, name?, at?)` to present-only `SET #name`.
- **Modify** `app/src/adapters/auth.ts` — `GOOGLE_SCOPE` `'openid email'` → `'openid email profile'`; add `name?: string` to `AuthIdentity`; capture `claims['name']` (trim, cap 120, blank→absent) in `completeLogin`; do NOT log it.
- **Modify** `app/src/services/resolveInvitedUser.ts` — pass `identity.name` to both `activateOnLogin` (first-login branch) and `touchLastLogin` (active branch); include the refreshed name on the returned in-memory `user`.
- **Modify** `app/src/routes/inbox.ts` — replace the inline `userDisplayName` (`inbox.ts:198`) usage with the canonical `displayNameOf` imported from the users module (keep a thin wrapper only for the `findById`-returned-undefined case, falling back to the assignee userId).
- **Modify** `app/src/routes/adminUsers.ts` — add `name: displayNameOf(u)` to the `toAdminUserView` projection (nice-to-have, low risk).
- **Modify** `app/src/lib/seedData.ts` — give both seeded users (`founder@example.com`, `va@example.com`) a realistic `name`.
- **Test:** `app/test/usersRepo.*` (or the nearest existing users test) for `displayNameOf` + the present-only SET; `app/test/` auth-adapter + resolveInvitedUser tests for claim capture + wiring; an `*.integration.test.ts` for login-persists-and-refreshes-name over DynamoDB Local. (Builder: find the existing test files for these modules and extend them; create a new file only if none exists.)

---

### Task 1: `UserItem.name` + `displayNameOf` + present-only name refresh in the repo

**Files:**
- Modify: `app/src/repos/usersRepo.ts`
- Test: the existing users-repo unit test (find it: `app/test/usersRepo*.test.ts` or similar; if none, create `app/test/usersRepo.test.ts`)

**Interfaces:**
- Consumes: existing `UserItem`, the `UpdateCommand` patterns already in `usersRepo.ts` (`activateOnLogin` at :264, `touchLastLogin` at :281).
- Produces (later tasks + consumers rely on these exact names/types):
  - `UserItem.name?: string`
  - `export function displayNameOf(user: Pick<UserItem, 'name' | 'email' | 'userId'>): string`
  - `activateOnLogin(userId: string, googleSub: string, name?: string, at?: string): Promise<void>` (name inserted BEFORE the existing optional `at` — update the interface AND the impl)
  - `touchLastLogin(userId: string, name?: string, at?: string): Promise<void>`

- [ ] **Step 1 — Read** `app/src/repos/usersRepo.ts` (esp. `UserItem` :70–99, `activateOnLogin` :264–279, `touchLastLogin` :281–291) and the existing users-repo test to mirror its harness/seed style.

- [ ] **Step 2 — Write failing unit tests.** In the users-repo test file add:
  - `displayNameOf`:
    - returns `name` when present and non-blank: `displayNameOf({ name: 'Sam Rivera', email: 'sam@x.com', userId: 'u1' }) === 'Sam Rivera'`
    - trims: `displayNameOf({ name: '  Sam  ', email: 'e', userId: 'u' }) === 'Sam'`
    - whitespace-only name falls through to email: `displayNameOf({ name: '   ', email: 'sam@x.com', userId: 'u1' }) === 'sam@x.com'`
    - absent name → email: `displayNameOf({ email: 'sam@x.com', userId: 'u1' }) === 'sam@x.com'`
    - no name AND no email → userId: `displayNameOf({ userId: 'u1' }) === 'u1'`
  - repo present-only SET (drive the real repo against the test's DynamoDB-Local-or-fake doc client the existing users test already uses; if the existing users test is unit-only with a fake doc client, assert the built UpdateExpression/values — match that test's existing assertion style):
    - `activateOnLogin(id, sub, 'Sam Rivera')` → the update SETs `name` (with `#name` attr-name) alongside google_sub/status/last_login_at.
    - `activateOnLogin(id, sub, undefined)` → the update does NOT mention `name` (no `#name`, no `:name`).
    - `activateOnLogin(id, sub, '')` (blank) → treated as absent → does NOT SET `name`.
    - `touchLastLogin(id, 'Sam Rivera')` → SETs `name`; `touchLastLogin(id, undefined)` → does NOT.

- [ ] **Step 3 — Run, verify fail.** `npm test -w @housingchoice/app -- usersRepo` → FAIL (`displayNameOf` not exported / name not set).

- [ ] **Step 4 — Implement** in `usersRepo.ts`:
  - Add `name?: string` to `UserItem` (with a short doc comment: freeform Google profile name; trimmed+capped at write time; absent until a login carries the claim).
  - `export function displayNameOf(user: Pick<UserItem, 'name' | 'email' | 'userId'>): string { return (typeof user.name === 'string' && user.name.trim().length > 0 ? user.name.trim() : '') || (user.email ?? '') || user.userId; }` (or equivalent that yields name→email→userId; ensure a blank/whitespace name does not win).
  - Extend `activateOnLogin(userId, googleSub, name, at = new Date().toISOString())`: build the UpdateExpression conditionally — base is `'SET google_sub = if_not_exists(google_sub, :sub), #status = :active, last_login_at = :at'`; when `name` is a non-empty trimmed string, append `, #name = :name`, add `'#name': 'name'` to ExpressionAttributeNames and `':name': name.trim()` to values. Keep `ConditionExpression: 'attribute_exists(userId)'`.
  - Extend `touchLastLogin(userId, name, at = …)`: base `'SET last_login_at = :at'`; append `, #name = :name` + the attr-name/value only when `name` is a non-empty trimmed string.
  - Do NOT log `name` anywhere.

- [ ] **Step 5 — Run, verify pass.** `npm test -w @housingchoice/app -- usersRepo` → PASS.

- [ ] **Step 6 — Typecheck.** `npm run typecheck -w @housingchoice/app` → clean (the `activateOnLogin`/`touchLastLogin` signature change will surface callers — `resolveInvitedUser` is updated in Task 2; if typecheck flags the call sites now, leave a minimal-but-compiling call (pass `undefined` for name) so the branch compiles, OR note it; Task 2 finalizes the wiring).

- [ ] **Step 7 — Commit.**
```bash
git add app/src/repos/usersRepo.ts app/test/usersRepo*.test.ts
git commit -m "feat(users): UserItem.name + displayNameOf resolver + present-only name refresh in activateOnLogin/touchLastLogin"
```

---

### Task 2: OAuth `profile` scope + `name` claim capture + login wiring

**Files:**
- Modify: `app/src/adapters/auth.ts`, `app/src/services/resolveInvitedUser.ts`
- Test: the existing auth-adapter test + `app/test/resolveInvitedUser*.test.ts` (find them; extend)

**Interfaces:**
- Consumes: Task 1's `activateOnLogin(userId, sub, name?, at?)` and `touchLastLogin(userId, name?, at?)`.
- Produces: `AuthIdentity.name?: string` (already trimmed, ≤120 chars, non-empty or absent).

- [ ] **Step 1 — Read** `app/src/adapters/auth.ts` (`GOOGLE_SCOPE` :66, claim extraction :110–128) and `app/src/services/resolveInvitedUser.ts` (the two login branches :72–97), plus their existing tests.

- [ ] **Step 2 — Write failing tests.**
  - Auth adapter (`completeLogin`): with a fake/stub token set whose claims include `name: '  Ada Lovelace  '` → `identity.name === 'Ada Lovelace'` (trimmed). Claims with no `name` → `identity.name` is `undefined`. `name: '   '` (blank) → `undefined`. An overlong name (e.g. 200 chars) → capped to 120. Login still succeeds in every case (email path unchanged). (Mirror how the existing auth-adapter test stubs `tokens.claims()`.)
  - `resolveInvitedUser`: first-login (invited) path calls `activateOnLogin` with `identity.name`; active path calls `touchLastLogin` with `identity.name`; the returned `user.name` reflects the provided name. (Use the existing fake usersRepo in that test; assert the name argument is forwarded.)
  - PII: assert (or at minimum, the implementer manually confirms + notes) no log line includes the name — the adapter logs only `{ sub }`, resolveInvitedUser only `{ userId, role }`.

- [ ] **Step 3 — Run, verify fail.** `npm test -w @housingchoice/app -- "auth|resolveInvitedUser"` → FAIL.

- [ ] **Step 4 — Implement.**
  - `auth.ts`: `const GOOGLE_SCOPE = 'openid email profile';`. In `completeLogin`, after extracting `email`, read `const rawName = claims['name'];` and compute `const name = typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim().slice(0, 120) : undefined;` then add `...(name !== undefined && { name })` to the `AuthIdentity` object. Add `name?: string` to the `AuthIdentity` interface with a doc comment (freeform Google profile name; absent when not granted/blank). Keep `log.info({ sub }, …)` unchanged — never add the name.
  - `resolveInvitedUser.ts`: in the invited branch, `await deps.usersRepo.activateOnLogin(existing.userId, identity.sub, identity.name, now);` and set the returned user's name: `user: { ...existing, google_sub: identity.sub, status: 'active', last_login_at: now, ...(identity.name !== undefined && { name: identity.name }) }`. In the active branch, `await deps.usersRepo.touchLastLogin(existing.userId, identity.name, now);` and `user: { ...existing, last_login_at: now, ...(identity.name !== undefined && { name: identity.name }) }`. Do NOT log the name. (The `user_activated` audit payload already records email/role/google_sub — do NOT add the name to the audit payload; PII stays minimal and the audit's purpose is access, not profile.)

- [ ] **Step 5 — Run, verify pass.** `npm test -w @housingchoice/app -- "auth|resolveInvitedUser"` → PASS.

- [ ] **Step 6 — Typecheck.** `npm run typecheck -w @housingchoice/app` → clean (call sites from Task 1 now finalized).

- [ ] **Step 7 — Commit.**
```bash
git add app/src/adapters/auth.ts app/src/services/resolveInvitedUser.ts app/test/
git commit -m "feat(auth): request profile scope + capture Google name claim; refresh UserItem.name every login"
```

---

### Task 3: Route consumers through `displayNameOf` + seed names + integration test + adversarial sweep

**Files:**
- Modify: `app/src/routes/inbox.ts`, `app/src/routes/adminUsers.ts`, `app/src/lib/seedData.ts`
- Test: extend `app/test/inboxApi.test.ts` / `app/test/adminUsers*.test.ts`; create/extend a `*.integration.test.ts` for the login→persist→refresh path

**Interfaces:**
- Consumes: Task 1's `displayNameOf`; Task 2's name-on-login wiring.

- [ ] **Step 1 — Read** `app/src/routes/inbox.ts` (the `userDisplayName` helper :198 and its caller `resolveUserName` ~:334), `app/src/routes/adminUsers.ts` (`toAdminUserView` ~:41), `app/src/lib/seedData.ts` (the `users` array ~:202). Also `grep` the codebase for other user-name-for-display sites (e.g. founder/admin notification copy) — if you find one that renders a user's email/userId as a name, route it through `displayNameOf` too and note it; if none, note that in the report.

- [ ] **Step 2 — Write failing tests.**
  - Inbox: in `inboxApi.test.ts`, seed an assigned conversation whose assignee user has `name: 'Sam Rivera'` → the inbox row's `assignment.name === 'Sam Rivera'`; an assignee with no `name` → `assignment.name` falls back to the email. (Extend the existing assignment test.)
  - adminUsers: the `GET /api/users` projection includes `name` = `displayNameOf(u)` for each user (a user with a name shows the name; one without shows the email).
  - Integration (DynamoDB Local, gated `describe.skipIf(!reachable)` like the existing integration tests): seed an invited user; simulate a login carrying `name` (drive `resolveInvitedUser` against the real repo, or the auth callback if the existing integration harness supports it) → the stored `UserItem.name` is set; a second login WITHOUT a name claim → the stored name is PRESERVED (not clobbered); a login with a CHANGED name → the stored name refreshes; `displayNameOf(storedUser)` returns the expected value at each step.

- [ ] **Step 3 — Run, verify fail.** `npm test -w @housingchoice/app -- "inboxApi|adminUsers|<integration>"` → FAIL.

- [ ] **Step 4 — Implement.**
  - `inbox.ts`: import `displayNameOf` from the users repo module; replace the body of the local `userDisplayName` (or its call inside `resolveUserName`) so a found user resolves via `displayNameOf(user)`, and a missing user (findById → undefined) falls back to the assignee `userId`. Remove the now-redundant inline name/email branching (DRY — one resolver). Keep the per-request cache.
  - `adminUsers.ts`: add `name: displayNameOf(u)` to the `toAdminUserView` projection (import `displayNameOf`).
  - `seedData.ts`: add a realistic `name` to both seeded users (e.g. founder → `name: 'Jordan Avery'`, va → `name: 'Sam Rivera'`). Keep everything else unchanged.

- [ ] **Step 5 — Run, verify pass.** `npm test -w @housingchoice/app -- "inboxApi|adminUsers|<integration>"` → PASS. Ensure DynamoDB Local is up for the integration test (`npm run db:start && npm run db:create` from the worktree; if port 8000 is held by another worktree's run you cannot control, finish everything else green and report the integration suite self-skipped).

- [ ] **Step 6 — Full suite + typecheck.** `npm test -w @housingchoice/app` (entire app suite green) and `npm run typecheck -w @housingchoice/app` clean.

- [ ] **Step 7 — Commit.**
```bash
git add app/src/routes/inbox.ts app/src/routes/adminUsers.ts app/src/lib/seedData.ts app/test/
git commit -m "feat(users): route inbox Assigned chip + admin users list through displayNameOf; seed user names; integration test"
```

---

## Self-Review (run before declaring done)

- **Spec coverage:** profile scope added; name claim captured (trim/cap/blank); name stored + refreshed on EVERY login (both paths); present-only (no clobber); `displayNameOf` canonical + routed through inbox + adminUsers; seed names; fallbacks correct; name never logged.
- **Adversarial focus (final review will hunt):** PII leakage (name in any log/error/audit payload), missing-name fallback (absent/blank/whitespace → email, never crash/empty), scope/consent correctness (login still works; `profile` actually requested), dev-login/seed path (seed user has a name; non-Google path not broken), stale name (refreshes on re-login; absent claim does NOT clobber), auth/session regressions, missed consumers (any user shown by email not routed through `displayNameOf`).
- **Contract notes to surface in the handoff (do NOT silently diverge):** (a) **re-consent** — users see a new Google permission prompt on next login (the `profile` scope); (b) users who haven't re-logged-in show email until their next login (name backfills lazily); (c) the SSE `toConversationUpdatedEvent` was intentionally left emitting a bare `userId` (name resolved at REST); (d) the inbox `assignment.name` reconciliation the C8 handoff deferred to the main session is DONE here because `inbox-backend` already merged to this branch's base — no separate reconciliation needed.
