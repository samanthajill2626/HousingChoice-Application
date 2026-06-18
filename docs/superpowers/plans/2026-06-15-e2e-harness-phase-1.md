<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# E2E Harness — Phase 1: Config flags, gating & fail-fast — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the dev-endpoint safety scaffolding in the `app/` backend — a `DEV_AUTH_ENABLED` config flag, a production fail-fast, and a structurally-gated (dynamically-imported) `devRouter` that mounts only in non-production when the flag is set — with a single `GET /__dev/ping` probe to prove the gate works.

**Architecture:** Three of the four §6 safety layers land here. (1+2) `loadConfig()` parses `DEV_AUTH_ENABLED` and **throws at load** if it's truthy while `NODE_ENV==='production'` (fail-fast). (3) The dev router lives in its own module imported **only** by `maybeLoadDevRouter()` at the composition root (`index.ts`), so a normal prod process never even loads the code. `buildApp` stays **synchronous** and gains an optional `devRouter` dep it mounts at the same trust level as `/health`. Phase 1's router is a no-op except `GET /__dev/ping → {dev:true}` (a liveness/stack-identity probe). The 4th layer (env gate B = the flag itself) is inherent.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import extensions mandatory), Express 5, Vitest + supertest.

**Working directory:** the worktree `w:/tmp/hc-e2e-worktree` on branch `e2e-testing-harness`. Do NOT switch branches; do NOT touch the main checkout. Commit on the current branch.

---

## Spec reference

Implements **Phase 1** of `docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md` (§11), realizing the safety model in §6 layers 1–3. Dev-login, the recording driver, and the outbox/reseed endpoints are LATER phases — Phase 1's `devRouter` exposes only `/__dev/ping`. Do not build more (YAGNI).

## Facts this plan relies on (verified against the codebase)

- `app/src/lib/config.ts`: `loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig` — synchronous, NOT cached, reads the injectable `env`. `nodeEnv` is computed first: `const nodeEnv = env.NODE_ENV ?? 'development';`. The return statement is a big object literal that includes `nodeEnv`. `AppConfig` is an interface (fields incl. `nodeEnv: string`, `messagingDriver`).
- Existing fail-fast pattern (Twilio, ~lines 233–246): `throw new Error('...Refusing to start...')`. Match this voice.
- Boolean env convention is inline, e.g. `(env.OTEL_SDK_DISABLED ?? '').toLowerCase() === 'true'` and elsewhere `normalized === 'true' || normalized === '1' || normalized === 'yes'`. No shared helper.
- `app/src/app.ts`: `export function buildApp(deps: BuildAppDeps = {}): Express` — synchronous, returns `app`. Mount block (~76–125) begins with an `X-Content-Type-Options` header middleware, then `app.use(healthRouter);`, then `/webhooks`, `/public`, `/auth`, `/api`, then `deps.configureRoutes?.(app);`. `healthRouter` is mounted at the top because it is EXEMPT from the origin-secret validator (`originSecretMiddleware`, imported at line ~24). Routers are created synchronously; there is no dynamic `import()` in `buildApp` today.
- `app/src/index.ts` builds `config` and calls `const app = buildApp({ config });` (~line 110). `index.ts` already uses top-level `await` (it does `await import(...)` at ~line 13), so `await` at module scope is available there.
- `Logger` type: `import { logger as defaultLogger, type Logger } from './lib/logger.js'` (pino). Router factories take `{ logger?: Logger }` and do `const log = deps.logger ?? defaultLogger;`.
- Router template (`app/src/routes/health.ts`): `import { Router } from 'express'; export const healthRouter: Router = Router(); healthRouter.get('/health', (_req,res)=>{...})`.
- Factory template (`app/src/routes/public.ts`): `export interface XRouterDeps { logger?: Logger; ... }` + `export function createXRouter(deps: XRouterDeps = {}): Router { const log = deps.logger ?? defaultLogger; const router = Router(); ...; return router; }`.
- Tests: `app/test/*.ts`, Vitest. Pattern (`app/test/app.test.ts`): `import request from 'supertest'; import { describe, expect, it } from 'vitest'; import { buildApp } from '../src/app.js'; import { loadConfig } from '../src/lib/config.js';` then `const config = loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }); app = buildApp({ config, ... });`. Tests control config by calling `loadConfig(env)` with a hand-built env object (NOT by mutating process.env). `CF_ORIGIN_SECRET` is passed in to satisfy config.
- App test command (from worktree root): `npm run test -w @housingchoice/app` (the script is `vitest run`). A single file: `npm run test -w @housingchoice/app -- run app/test/devGating.test.ts` is NOT correct because cwd is the app workspace — use `npm run test -w @housingchoice/app -- devGating` (vitest filters by substring).
- ESM/NodeNext: all intra-package relative imports MUST end in `.js` (e.g. `'./lib/config.js'`, `'../routes/dev.js'`).

---

## File structure (what this phase creates/changes)

- Modify `app/src/lib/config.ts` — add `devAuthEnabled: boolean` to `AppConfig`; parse `DEV_AUTH_ENABLED`; add the production fail-fast near the top of `loadConfig`; include the field in the return.
- Create `app/src/routes/dev.ts` — `createDevRouter(deps)` exposing only `GET /__dev/ping`.
- Create `app/src/lib/devRoutes.ts` — `maybeLoadDevRouter(config, logger?)`: the structural gate (dynamic import only when gated).
- Modify `app/src/app.ts` — add `devRouter?: Router` to `BuildAppDeps`; mount it immediately after `healthRouter` (shares the origin-secret exemption); import the `Router` type.
- Modify `app/src/index.ts` — `const devRouter = await maybeLoadDevRouter(config, <logger>); buildApp({ config, devRouter });`.
- Create `app/test/devGating.test.ts` — fail-fast, parsing, gate, and mount tests.

---

## Task 1: Config field, boolean parsing, and production fail-fast (TDD)

**Files:**
- Test: `app/test/devGating.test.ts` (create — fail-fast + parsing cases first)
- Modify: `app/src/lib/config.ts`

- [ ] **Step 1: Write the failing tests for config behavior**

Create `app/test/devGating.test.ts` with exactly this (more cases are added in Task 2):

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/lib/config.js';

const SECRET = 'test-origin-secret';

describe('dev gating — config', () => {
  it('fails fast when DEV_AUTH_ENABLED is set in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DEV_AUTH_ENABLED: '1' }),
    ).toThrow(/DEV_AUTH_ENABLED/);
  });

  it('parses truthy DEV_AUTH_ENABLED values outside production', () => {
    for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
      const cfg = loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: v, CF_ORIGIN_SECRET: SECRET });
      expect(cfg.devAuthEnabled).toBe(true);
    }
  });

  it('defaults devAuthEnabled to false when unset or falsey', () => {
    expect(loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }).devAuthEnabled).toBe(false);
    expect(
      loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: 'false', CF_ORIGIN_SECRET: SECRET }).devAuthEnabled,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `npm run test -w @housingchoice/app -- devGating`
Expected: FAIL — `cfg.devAuthEnabled` is `undefined` (property doesn't exist) and the production case does NOT throw the DEV_AUTH_ENABLED error (it may throw a different Twilio error or not throw — either way the regex assertion fails or the property assertions fail). This confirms the feature is missing.

- [ ] **Step 3: Add the field to the `AppConfig` interface**

In `app/src/lib/config.ts`, in the `AppConfig` interface, add this field right after the `nodeEnv` field:

```ts
  /** Dev-only test/QA endpoints (dev-login, outbox, reseed) are gated on this.
   *  MUST be false in production — loadConfig fails fast otherwise. */
  devAuthEnabled: boolean;
```

- [ ] **Step 4: Parse `DEV_AUTH_ENABLED` and fail fast — near the TOP of `loadConfig`**

In `app/src/lib/config.ts`, immediately after the line `const nodeEnv = env.NODE_ENV ?? 'development';`, insert:

```ts
  // Dev-only endpoints (dev-login, outbox, reseed in later phases) are gated
  // behind this flag. It must NEVER be set in production; if it is, refuse to
  // start rather than expose a backdoor. Checked first, before other validation,
  // so the dangerous combination fails fast regardless of what else is missing.
  const devAuthEnabled = ['true', '1', 'yes'].includes((env.DEV_AUTH_ENABLED ?? '').toLowerCase());
  if (devAuthEnabled && nodeEnv === 'production') {
    throw new Error(
      'DEV_AUTH_ENABLED is set while NODE_ENV=production — refusing to start. The ' +
        'dev-only auth/test endpoints must never be enabled in production.',
    );
  }
```

- [ ] **Step 5: Include `devAuthEnabled` in the returned config object**

In the big object literal returned by `loadConfig`, add `devAuthEnabled,` adjacent to where `nodeEnv` is placed in the return (shorthand property — the local `const devAuthEnabled` is in scope).

- [ ] **Step 6: Run the tests — verify they PASS**

Run: `npm run test -w @housingchoice/app -- devGating`
Expected: PASS (3 tests in the `dev gating — config` describe).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck -w @housingchoice/app`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git -C w:/tmp/hc-e2e-worktree add app/src/lib/config.ts app/test/devGating.test.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(app): DEV_AUTH_ENABLED config flag + production fail-fast

§6 safety layers 1-2: parse DEV_AUTH_ENABLED (truthy outside prod) and refuse
to start if it is set while NODE_ENV=production.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Structurally-gated devRouter + /__dev/ping + wiring (TDD)

**Files:**
- Modify: `app/test/devGating.test.ts` (add gate + mount tests)
- Create: `app/src/routes/dev.ts`
- Create: `app/src/lib/devRoutes.ts`
- Modify: `app/src/app.ts`
- Modify: `app/src/index.ts`

- [ ] **Step 1: Add the failing gate + mount tests**

Append these imports to the top of `app/test/devGating.test.ts` (alongside the existing ones):

```ts
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { maybeLoadDevRouter } from '../src/lib/devRoutes.js';
```

And append this describe block to `app/test/devGating.test.ts`:

```ts
describe('dev gating — router', () => {
  const enabled = () => loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET });
  const disabled = () => loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET });

  it('maybeLoadDevRouter returns a router only when the flag is set', async () => {
    expect(await maybeLoadDevRouter(enabled())).toBeDefined();
    expect(await maybeLoadDevRouter(disabled())).toBeUndefined();
  });

  it('mounts /__dev/ping when the dev router is present', async () => {
    const config = enabled();
    const app = buildApp({ config, devRouter: await maybeLoadDevRouter(config) });
    const res = await request(app).get('/__dev/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dev: true });
  });

  it('does NOT expose /__dev/ping when the dev router is absent', async () => {
    const app = buildApp({ config: disabled() });
    const res = await request(app).get('/__dev/ping');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `npm run test -w @housingchoice/app -- devGating`
Expected: FAIL — `maybeLoadDevRouter` and the `devRouter` dep don't exist yet (import/type errors or 404 where 200 expected).

- [ ] **Step 3: Create the dev router `app/src/routes/dev.ts`**

```ts
// Dev-only router. Mounted ONLY when DEV_AUTH_ENABLED is truthy AND
// NODE_ENV !== 'production' (gated by lib/devRoutes.ts; config.ts fails fast if
// the flag is ever set in production). Phase 1 exposes only a liveness/identity
// probe; later phases add dev-login, the recorded-message outbox, and reseed.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

export interface DevRouterDeps {
  logger?: Logger;
}

export function createDevRouter(deps: DevRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const router = Router();

  // GET /__dev/ping — confirms the dev endpoints are active. Tests and the e2e
  // harness use this to verify they are talking to a hermetic dev stack.
  router.get('/__dev/ping', (_req, res) => {
    res.status(200).json({ dev: true });
  });

  log.debug({ routes: ['/__dev/ping'] }, 'dev router mounted');
  return router;
}
```

- [ ] **Step 4: Create the structural gate `app/src/lib/devRoutes.ts`**

```ts
// Structural gate (§6 layer 3) for the dev-only endpoints: the dev router module
// is dynamically imported ONLY when the gates pass, so a normal production
// process never even loads the code. config.ts already fails fast if the flag is
// set in production; this is the second, structural layer. Lives at the
// composition root so buildApp can stay synchronous.
import type { Router } from 'express';
import type { AppConfig } from './config.js';
import { logger as defaultLogger, type Logger } from './logger.js';

export async function maybeLoadDevRouter(
  config: AppConfig,
  logger: Logger = defaultLogger,
): Promise<Router | undefined> {
  if (!config.devAuthEnabled || config.nodeEnv === 'production') return undefined;
  const { createDevRouter } = await import('../routes/dev.js');
  return createDevRouter({ logger });
}
```

- [ ] **Step 5: Wire the optional devRouter into `buildApp` (`app/src/app.ts`)**

(a) Ensure the `Router` type is imported from express. If the existing express import doesn't include it, add:

```ts
import type { Router } from 'express';
```

(b) Add to the `BuildAppDeps` interface:

```ts
  /** Pre-built dev-only router, supplied by the composition root when gated on.
   *  Mounted at the same trust level as /health (exempt from the origin-secret
   *  validator). Undefined in normal runs. */
  devRouter?: Router;
```

(c) In `buildApp`, immediately AFTER `app.use(healthRouter);`, insert:

```ts
  // Dev-only endpoints, gated at the composition root. Mounted here (before the
  // origin-secret validator, like /health) so the e2e harness and tests can
  // reach them without the CloudFront header. Absent in normal runs.
  if (deps.devRouter) app.use(deps.devRouter);
```

ACCEPTANCE for placement: the Step-1 test `GET /__dev/ping` (supertest, no CF header) must return 200. If it returns 403/blocked, the mount is on the wrong side of `originSecretMiddleware` — move it to share `/health`'s exemption. Read `app/src/middleware/originSecret.ts` and the app.ts ordering to confirm.

- [ ] **Step 6: Wire the gate into the composition root (`app/src/index.ts`)**

(a) Add the import near the other `./lib/*` imports:

```ts
import { maybeLoadDevRouter } from './lib/devRoutes.js';
```

(b) Replace the `const app = buildApp({ config });` line with:

```ts
  const devRouter = await maybeLoadDevRouter(config, log);
  const app = buildApp({ config, devRouter });
```

Use the logger variable that already exists in `index.ts` for `log`. If `index.ts` has no logger in scope at that point, call `await maybeLoadDevRouter(config)` (the logger defaults). Do NOT introduce a new logger just for this.

- [ ] **Step 7: Run the tests — verify they PASS**

Run: `npm run test -w @housingchoice/app -- devGating`
Expected: PASS — all tests in both describe blocks (`dev gating — config` and `dev gating — router`).

- [ ] **Step 8: Run the full app test suite + typecheck (no regressions)**

Run: `npm run test -w @housingchoice/app`
Expected: the whole app suite passes (the new optional `devRouter` dep defaults to undefined, so existing `buildApp` callers are unaffected).
Run: `npm run typecheck -w @housingchoice/app`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git -C w:/tmp/hc-e2e-worktree add app/src/routes/dev.ts app/src/lib/devRoutes.ts app/src/app.ts app/src/index.ts app/test/devGating.test.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(app): structurally-gated devRouter with /__dev/ping probe

§6 layer 3: dev router is dynamically imported only when gated (non-prod +
DEV_AUTH_ENABLED), wired at the composition root so buildApp stays sync. Phase 1
exposes only GET /__dev/ping -> {dev:true} as a stack-identity probe.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 exit gate (per spec §12)

1. **Build + test:** Tasks 1–2 complete.
2. **Verification gate (evidence required):** `npm run test -w @housingchoice/app` is green (incl. `devGating`), and `npm run typecheck -w @housingchoice/app` is clean. Capture the summary lines. (The e2e smoke from Phase 0 is unaffected — no need to re-run the stack here.)
3. **Adversarial review:** dispatch a fresh, independent reviewer over the Phase 1 diff with the §12 off-the-leash mandate — focus especially on the SECURITY of the gating (can `/__dev/*` ever be reachable in production? does the fail-fast cover every load path? is the dynamic import truly skipped when disabled? any way the flag is truthy-parsed unexpectedly?), plus correctness/regressions. Triage; fix confirmed issues; re-verify.
4. **Done** only on green tests + clean review. Then proceed to Phase 2 (dev-login + auth fixture).

## Notes for later phases (do NOT do them now)

- `/auth/dev-login`, the recording messaging driver, `/__dev/outbox`, and `/__dev/reseed` are Phases 2–3 and will be added to `createDevRouter` (dev-login may live under `/auth/*` but still flows through this gated router, OR via the existing auth router with its own guard — decide in the Phase 2 plan).
- `/__dev/ping` is also the **stack-identity probe** the Phase 0 review (§15) wanted; Phase 4's launcher/readiness guard can use it to confirm it's talking to a hermetic dev stack rather than a stale/live server.
