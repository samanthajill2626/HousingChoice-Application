# E2E Harness — Phase 2: Dev-login + auth fixture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dev-only `POST /auth/dev-login` that mints a real session cookie for a seeded user (mirroring the OAuth callback), then wire Playwright to authenticate via a setup project + `storageState` so authenticated browser tests work — proving an authenticated dashboard route loads and an unauthenticated visit shows the login screen.

**Architecture:** `dev-login` is a new route INSIDE the existing gated `createDevRouter` (mounted before the origin-secret validator, only when `DEV_AUTH_ENABLED` + non-prod). It reuses the production session primitives verbatim — `sealSession()`, `sessionCookieOptions()`, `sessionEpochOf()` — so the dev session is byte-compatible with a real one; only the identity source differs (a `usersRepo.findByEmail` lookup of a seeded user instead of Google). On the Playwright side, a **setup project** (not `globalSetup`, which runs before `webServer`) calls dev-login and saves `storageState`; a fixture exposes an authenticated page.

**Tech Stack:** Express 5, TypeScript ESM (NodeNext, `.js` imports), Vitest + supertest (backend), Playwright (setup project + fixtures).

**Working directory:** worktree `w:/tmp/hc-e2e-worktree` on branch `e2e-testing-harness`. Do NOT switch branches or touch the main checkout. Commit on the current branch.

---

## Spec reference

Implements **Phase 2** of `docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md` (§7 dev-login, §11). Builds on Phase 1's gated `devRouter`. The recording driver, outbox, and reseed are Phase 3 — do NOT add them (YAGNI).

## Facts this plan relies on (verified against the codebase)

- **Session primitives** (`app/src/lib/sessionCookie.ts`): `SESSION_COOKIE_NAME = 'hc_session'`; sealed session payload `{ userId, email, role, epoch }`, purpose `'session'`.
- **Reusable helpers** (`app/src/middleware/auth.ts`): `sealSession(user: {userId,email,role}, config, { epoch }): string`, `sessionCookieOptions(config): {...}` (httpOnly true, secure only in prod, sameSite 'lax', path '/', maxAge 7d), and `SESSION_TTL_MS`. The real callback does exactly: `res.cookie(SESSION_COOKIE_NAME, sealSession({userId,email,role}, config, { epoch: sessionEpochOf(user) }), sessionCookieOptions(config));`.
- **Users repo** (`app/src/repos/usersRepo.ts`): `UsersRepo.findByEmail(email): Promise<UserItem|undefined>` and `.findById(userId)`; `sessionEpochOf(user): number` (returns `user.session_epoch ?? 1`); `userIdForEmail(email): string`; `createUsersRepo({logger})`. `UserItem` has `{ userId, email, role, created_at, session_epoch?, ... }`.
- **Seed users** (`app/scripts/db-seed.ts`): `va@example.com` (userId `user-0002`, role `'va'`) and `founder@example.com` (role `'founder_admin'`). **Use `va@example.com`** (role `'va'` is a clean, valid role; avoids the founder role-name question).
- **requireAuth** → `401 {error:'unauthorized'}` for unauthenticated `/api/*`. `sessionMiddleware` validates the cookie and checks the sealed epoch against `usersRepo.findById(userId)` (so a unit test must inject the same fake repo into `deps.auth.usersRepo`).
- **Session secret in dev**: `config.sessionSecret` defaults to `DEV_SESSION_SECRET_DEFAULT = 'dev-placeholder-session-secret'` when `SESSION_SECRET` is unset — so `seal` works in local/test with no setup.
- **buildApp deps**: `buildApp({ config, devRouter, auth: { usersRepo } })` — `auth.usersRepo` is threaded into `sessionMiddleware`. JSON body parsing is global (the `/echo` test posts JSON), so `req.body` works in the devRouter.
- **Dashboard auth flow** (`dashboard/src/app/AuthContext.tsx`): probes `GET /auth/me`; 401 → renders `<Login/>`, 200 → renders the app. `/auth/me` reads the session cookie (round-trippable like in `app/test/auth.test.ts`).
- **UI assertion strings**: Login screen (`dashboard/src/routes/Login.tsx`) shows the text **"Sign in with Google"** and h1 "HousingChoice". The authenticated inbox (`dashboard/src/routes/Inbox.tsx`, route `/`) shows `<h1>Inbox</h1>` (role heading, name "Inbox") regardless of data.
- **Vite proxy** (`dashboard/vite.config.ts`): `/auth` and `/api` proxied to `:8080` with header `x-origin-verify: dev-placeholder-not-a-secret`, so the browser can POST `/auth/dev-login` and probe `/auth/me` through `:5173`.
- **Test cookie helper** (`app/test/auth.test.ts`): reads `Set-Cookie` via a `setCookieValue(res, name)` helper; round-trips through `GET /auth/me` with `.set('x-origin-verify', SECRET)` and `.set('cookie', ...)`.
- **Existing devRouter** (`app/src/routes/dev.ts`): `createDevRouter(deps)` currently takes `{ logger? }` and exposes only `GET /__dev/ping`. `app/src/lib/devRoutes.ts` `maybeLoadDevRouter(config, logger)` calls `createDevRouter({ logger })` — this must start passing `config`.
- Playwright gotcha: `globalSetup` runs BEFORE `webServer`, so it cannot hit the app. Use a **setup project** (a test project, runs after the server is up) with `dependencies` — the documented Playwright auth pattern.
- `import.meta.dirname` is available (Node 24) for resolving paths in ESM e2e files.

---

## File structure (what this phase creates/changes)

- Modify `app/src/routes/dev.ts` — extend `DevRouterDeps` with `config?`/`usersRepo?`; add `POST /auth/dev-login`.
- Modify `app/src/lib/devRoutes.ts` — pass `config` into `createDevRouter`.
- Modify `app/test/devGating.test.ts` — add dev-login unit tests (success cookie + `/auth/me` round-trip; unknown email 404).
- Create `e2e/fixtures/authState.ts` — shared constants (state file path + seeded email).
- Create `e2e/auth.setup.ts` — setup-project test that dev-logins and saves `storageState`.
- Create `e2e/fixtures/auth.ts` — extended `test` with a `vaPage` fixture (context using the saved state).
- Modify `e2e/playwright.config.ts` — add `setup` project + `chromium` `dependencies: ['setup']`.
- Create `e2e/tests/dashboard/auth.spec.ts` — unauthenticated sees login; authenticated sees inbox.

---

## Task 1: `POST /auth/dev-login` in the gated dev router (TDD)

**Files:**
- Test: `app/test/devGating.test.ts` (add a `dev-login` describe)
- Modify: `app/src/routes/dev.ts`, `app/src/lib/devRoutes.ts`

- [ ] **Step 1: Write the failing dev-login unit tests**

Append to `app/test/devGating.test.ts`. First ensure these imports exist at the top (add any missing):

```ts
import { SESSION_COOKIE_NAME } from '../src/lib/sessionCookie.js';
import { createDevRouter } from '../src/routes/dev.js';
import { userIdForEmail, type UserItem, type UsersRepo } from '../src/repos/usersRepo.js';
```

Add a `setCookieValue` helper near the top of the file (if not already present):

```ts
function setCookieValue(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const header = res.headers['set-cookie'] as string[] | undefined;
  const line = header?.find((c) => c.startsWith(`${name}=`));
  return line ? line.split(';')[0].slice(name.length + 1) : undefined;
}
```

Then append:

```ts
describe('dev gating — /auth/dev-login', () => {
  const VA = 'va@example.com';
  const vaUser: UserItem = {
    userId: userIdForEmail(VA),
    email: VA,
    role: 'va',
    created_at: '2026-06-01T00:00:00.000Z',
    session_epoch: 1,
  };
  // Minimal fake: dev-login uses findByEmail; sessionMiddleware (on /auth/me)
  // uses findById for the epoch check.
  const usersRepo = {
    findByEmail: async (email: string) =>
      email.trim().toLowerCase() === VA ? vaUser : undefined,
    findById: async (userId: string) => (userId === vaUser.userId ? vaUser : undefined),
  } as unknown as UsersRepo;

  const buildDevApp = () => {
    const config = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });
    return buildApp({ config, devRouter: createDevRouter({ config, usersRepo }), auth: { usersRepo } });
  };

  it('mints a session cookie for a seeded user and round-trips via /auth/me', async () => {
    const app = buildDevApp();
    const res = await request(app).post('/auth/dev-login').send({ email: VA });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: VA, role: 'va' });

    const token = setCookieValue(res, SESSION_COOKIE_NAME);
    expect(token).toBeTruthy();

    const me = await request(app)
      .get('/auth/me')
      .set('x-origin-verify', SECRET)
      .set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email: VA, role: 'va' });
  });

  it('returns 404 for an unknown email', async () => {
    const app = buildDevApp();
    const res = await request(app).post('/auth/dev-login').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `npm run test -w @housingchoice/app -- devGating`
Expected: FAIL — `createDevRouter` doesn't accept `config`/`usersRepo` yet and there is no `/auth/dev-login` route (404 where 200 expected; possibly a type error on the deps).

- [ ] **Step 3: Extend the dev router (`app/src/routes/dev.ts`)**

Replace the contents of `app/src/routes/dev.ts` with:

```ts
// Dev-only router. Mounted ONLY when DEV_AUTH_ENABLED is truthy AND
// NODE_ENV !== 'production' (gated by lib/devRoutes.ts; config.ts fails fast if
// the flag is ever set in production). Exposes a liveness probe and a dev-login
// that mints a REAL session for a seeded user, mirroring the OAuth callback.
// Later phases add the recorded-message outbox and reseed.
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { sealSession, sessionCookieOptions } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../lib/sessionCookie.js';
import { createUsersRepo, sessionEpochOf, type UsersRepo } from '../repos/usersRepo.js';

export interface DevRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  usersRepo?: UsersRepo;
}

export function createDevRouter(deps: DevRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const router = Router();

  // GET /__dev/ping — confirms the dev endpoints are active (stack-identity probe).
  router.get('/__dev/ping', (_req, res) => {
    res.status(200).json({ dev: true });
  });

  // POST /auth/dev-login — mint a session for a seeded user without Google.
  // Mirrors the OAuth callback's session minting exactly (same seal + cookie
  // options), so the resulting session is indistinguishable from a real login.
  router.post('/auth/dev-login', async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' && body.email.trim() ? body.email : 'va@example.com';
    const user = await users.findByEmail(email);
    if (!user) {
      res.status(404).json({ error: 'unknown_dev_user', email });
      return;
    }
    res.cookie(
      SESSION_COOKIE_NAME,
      sealSession({ userId: user.userId, email: user.email, role: user.role }, config, {
        epoch: sessionEpochOf(user),
      }),
      sessionCookieOptions(config),
    );
    log.info({ email: user.email, role: user.role }, 'dev-login minted a session');
    res.status(200).json({ userId: user.userId, email: user.email, role: user.role });
  });

  return router;
}
```

NOTE on the `role` type: `sealSession` expects a `UserRole` role. `va@example.com` is role `'va'` (valid), so the default path type-checks. If TypeScript complains that `user.role` (a wider type) isn't assignable, that's a pre-existing type width issue — narrow with the user's actual value; do NOT loosen `sealSession`'s signature.

- [ ] **Step 4: Pass `config` through the structural gate (`app/src/lib/devRoutes.ts`)**

Change the return line in `maybeLoadDevRouter` from `return createDevRouter({ logger });` to:

```ts
  return createDevRouter({ config, logger });
```

- [ ] **Step 5: Run the tests — verify they PASS**

Run: `npm run test -w @housingchoice/app -- devGating`
Expected: PASS — all dev-gating tests including the two new dev-login cases.

- [ ] **Step 6: Full app suite + typecheck**

Run: `npm run test -w @housingchoice/app`  → green (previously 759 passed / 5 skipped, now +2).
Run: `npm run typecheck -w @housingchoice/app`  → clean.

- [ ] **Step 7: Commit**

```bash
git -C w:/tmp/hc-e2e-worktree add app/src/routes/dev.ts app/src/lib/devRoutes.ts app/test/devGating.test.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(app): dev-login endpoint in the gated dev router

POST /auth/dev-login mints a real session for a seeded user by reusing
sealSession/sessionCookieOptions/sessionEpochOf verbatim — byte-compatible with
the OAuth callback. Gated + non-prod only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Playwright setup project, auth fixture, and the proving spec

**Files:**
- Create: `e2e/fixtures/authState.ts`, `e2e/auth.setup.ts`, `e2e/fixtures/auth.ts`, `e2e/tests/dashboard/auth.spec.ts`
- Modify: `e2e/playwright.config.ts`

- [ ] **Step 1: Create shared auth constants `e2e/fixtures/authState.ts`**

```ts
import path from 'node:path';

// Saved storage state lives under the gitignored artifacts dir.
export const AUTH_DIR = path.join(import.meta.dirname, '..', '.artifacts', 'auth');
export const VA_STATE = path.join(AUTH_DIR, 'va.json');

// Seeded staff user (db-seed.ts): role 'va'.
export const VA_EMAIL = 'va@example.com';
```

- [ ] **Step 2: Create the setup-project test `e2e/auth.setup.ts`**

```ts
import fs from 'node:fs';
import { expect, test as setup } from '@playwright/test';
import { AUTH_DIR, VA_EMAIL, VA_STATE } from './fixtures/authState.js';

// Runs as a dependency before the chromium project (so the webServer is up).
// Calls the dev-login endpoint and persists the resulting cookies as storageState.
setup('authenticate as the seeded VA user', async ({ request }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const res = await request.post('/auth/dev-login', { data: { email: VA_EMAIL } });
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).email).toBe(VA_EMAIL);
  await request.storageState({ path: VA_STATE });
});
```

- [ ] **Step 3: Create the auth fixture `e2e/fixtures/auth.ts`**

```ts
import { test as base, expect } from '@playwright/test';
import { VA_STATE } from './authState.js';
import type { Page } from '@playwright/test';

// Extends the base test with `vaPage`: a page in a context authenticated as the
// seeded VA user (via the storageState saved by auth.setup.ts). The default
// `page` fixture remains UNauthenticated.
export const test = base.extend<{ vaPage: Page }>({
  vaPage: async ({ browser }, use) => {
    const context = await browser.newContext({ storageState: VA_STATE });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
```

- [ ] **Step 4: Register the setup project in `e2e/playwright.config.ts`**

Replace the `projects` array with:

```ts
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
```

(Leave everything else — `webServer`, reporters, `use`, etc. — unchanged. The default `page` stays unauthenticated; only the `vaPage` fixture loads storageState, so the Phase 0 housing-fair smoke is unaffected.)

- [ ] **Step 5: Create the proving spec `e2e/tests/dashboard/auth.spec.ts`**

```ts
import { test, expect } from '../../fixtures/auth.js';

test('unauthenticated visit to the dashboard shows the login screen', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Sign in with Google')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inbox' })).toHaveCount(0);
});

test('dev-login lands on the authenticated inbox', async ({ vaPage }) => {
  await vaPage.goto('/');
  await expect(vaPage.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(vaPage.getByText('Sign in with Google')).toHaveCount(0);
});
```

- [ ] **Step 6: Run the e2e suite (boots the stack) — verify GREEN**

Ensure Docker is running, then from the worktree root:

Run: `npm run e2e`
Expected: the `setup` project runs (dev-login succeeds, `va.json` written), then chromium runs all specs — the Phase 0 housing-fair smoke PLUS the two new auth specs — all passing. The authenticated test loads `/` and sees the "Inbox" heading; the unauthenticated test sees "Sign in with Google".

- [ ] **Step 7: Typecheck the e2e workspace**

Run: `npm run typecheck -w @housingchoice/e2e`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git -C w:/tmp/hc-e2e-worktree add e2e/fixtures/authState.ts e2e/auth.setup.ts e2e/fixtures/auth.ts e2e/playwright.config.ts e2e/tests/dashboard/auth.spec.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(e2e): authenticated browser tests via dev-login + setup project

Setup project calls /auth/dev-login and saves storageState; a vaPage fixture
runs tests as the seeded VA user. Proves the authenticated inbox loads and an
unauthenticated visit shows the login screen.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 2 exit gate (per spec §12)

1. **Build + test:** Tasks 1–2 complete.
2. **Verification gate (evidence required):** `npm run test -w @housingchoice/app` green; `npm run e2e` green (setup + housing-fair + both auth specs); both typechecks clean. Capture the summary lines.
3. **Adversarial review:** fresh independent reviewer over the Phase 2 diff with the §12 off-the-leash mandate — focus on: can dev-login mint a session in production (it's in the gated router + behind the fail-fast — verify no leak)? Does it faithfully mirror the real session (epoch, cookie options, secret) or could it mint a session the middleware would reject / or a MORE privileged session than intended? Any way to dev-login as an arbitrary/admin user beyond seeded ones? Is the storageState file (httpOnly cookie) handled safely and gitignored? Plus correctness/regressions/test-quality.
4. **Done** only on green + clean review. Then proceed to Phase 3.

## Notes for later phases (do NOT do them now)

- The recording messaging driver, `GET /__dev/outbox`, and `POST /__dev/reseed` are Phase 3 (added to `createDevRouter`).
- Phase 4 will add the session-mode launcher; the `vaPage` fixture and setup project will work unchanged against a persistent stack.
- If later we need an admin browser, add a second seeded-user state (e.g. `founder.json`) — out of scope now.
