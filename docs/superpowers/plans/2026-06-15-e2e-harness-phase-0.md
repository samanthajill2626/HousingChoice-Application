<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-06-18).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted on 2026-06-18. **This file is NOT
> current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# E2E Harness — Phase 0: Scaffold & Prove Cold Boot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an `e2e/` Playwright workspace whose single command cold-boots the existing hermetic local stack, loads one unauthenticated public page in a real browser, asserts it renders, and tears the stack down — proving the harness works end-to-end on this machine.

**Architecture:** A new top-level `e2e/` npm workspace owns `@playwright/test` and a `playwright.config.ts`. Playwright's `webServer` runs the existing `npm run dev -- --local` (hermetic: DynamoDB Local + `hc-local-` tables + seed + app `:8080` + worker + Vite `:5173`, no AWS/secrets, console messaging driver). Readiness is gated on the Vite dev server at `:5173` (the surface the test uses). `reuseExistingServer: !CI` lets a running session stack be reused locally but forces a fresh boot in CI.

**Tech Stack:** Playwright (`@playwright/test`), Node 24, npm workspaces, TypeScript ESM (`module: NodeNext`, `target: ES2023`), DynamoDB Local (Docker).

**Working directory:** All work happens in the worktree at `w:/tmp/hc-e2e-worktree` on branch `e2e-testing-harness`. Do NOT switch branches in the main checkout.

**Prerequisite:** Docker must be running (DynamoDB Local is a container). If `npm run dev -- --local` can't start the DB, that's the environment, not the plan — fix Docker first.

---

## Spec reference

Implements **Phase 0** of `docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md` (§11). Establishes the §4 layout, the §8 Suite-mode command shape (minimal form), and the §9 artifact conventions. Auth, dev fakes, the recording driver, session mode, and the cross-UI flow are explicitly LATER phases — do not build them here (YAGNI).

## Facts this plan relies on (verified against the codebase)

- Root `package.json`: `workspaces: ["app", "dashboard"]`; `"type": "module"`; `engines.node >=24`. New workspaces are added by appending to that array.
- `npm run dev -- --local` (via `scripts/dev.mjs`): hermetic mode. Sets `DYNAMODB_ENDPOINT=http://localhost:8000`, `TABLE_PREFIX=hc-local-`, `NODE_ENV=development`, `OTEL_SDK_DISABLED=true`, `PUBLIC_BASE_URL=http://localhost:5173`. Runs `db:start` → `db:create` → `db:seed`, then launches app (`:8080`), worker, and the dashboard Vite server (`:5173`) concurrently with `tsx watch`. No AWS creds or secrets required.
- Config (`app/src/lib/config.ts`): `MESSAGING_DRIVER` defaults to `console` when `NODE_ENV !== 'production'`. No Twilio/Google/AWS secrets needed in local mode. Google OAuth unset → `/auth/login` returns 503 (irrelevant to Phase 0's unauthenticated page).
- Unauthenticated page: `http://localhost:5173/housing-fair` renders an `<h1>` with literal text **`Housing fair sign-up`** (from `dashboard/src/routes/HousingFair.tsx`). The Vite proxy forwards `/api`, `/auth`, `/public` to `:8080`; this page renders client-side and needs only Vite to be up.
- Health endpoint: `GET http://localhost:8080/health` → `200 {"status":"ok",...}`. NOT proxied through `:5173`.
- TS base config: `tsconfig.base.json` has `strict`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2023`.
- `.gitignore` already ignores `node_modules/` (any depth) and `*.log`/`logs/`. Playwright artifact dirs are NOT yet ignored.
- `@playwright/test` is NOT a dependency anywhere yet.
- IMPORTANT: do NOT name the e2e package's run script `test`. Root `npm run test` runs `--workspaces --if-present`, which would sweep a `test` script into the unit-test run and boot the whole stack. The e2e script is named `e2e`.

---

## File structure (what this phase creates/changes)

- Create `e2e/package.json` — the workspace manifest; owns `@playwright/test`; exposes `e2e` + `report` scripts.
- Create `e2e/tsconfig.json` — extends the repo base; type-checks specs/config.
- Create `e2e/playwright.config.ts` — reporters, artifacts dir, projects, baseURL, and (Task 2) the `webServer` boot.
- Create `e2e/tests/public/housing-fair.spec.ts` — the single smoke spec.
- Modify root `package.json` — add `"e2e"` to `workspaces`; add a root `e2e` script.
- Modify `.gitignore` — ignore `e2e/.artifacts/`.

---

## Task 1: Scaffold the e2e workspace and a smoke spec that fails with no server (RED)

**Files:**
- Create: `e2e/package.json`
- Create: `e2e/tsconfig.json`
- Create: `e2e/playwright.config.ts`
- Create: `e2e/tests/public/housing-fair.spec.ts`
- Modify: `package.json` (root — `workspaces` + `scripts`)
- Modify: `.gitignore`

- [ ] **Step 1: Create `e2e/package.json`**

```json
{
  "name": "@housingchoice/e2e",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "e2e": "playwright test",
    "report": "playwright show-report .artifacts/html-report"
  },
  "devDependencies": {
    "@playwright/test": "^1.50.0"
  }
}
```

- [ ] **Step 2: Add the workspace and root script to root `package.json`**

In `package.json` (root), change the `workspaces` array from:

```json
  "workspaces": [
    "app",
    "dashboard"
  ],
```

to:

```json
  "workspaces": [
    "app",
    "dashboard",
    "e2e"
  ],
```

And add this line to the `scripts` block (place it right after the `"test": ...` line):

```json
    "e2e": "npm run e2e -w @housingchoice/e2e",
```

- [ ] **Step 3: Create `e2e/tsconfig.json`**

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["playwright.config.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: Create `e2e/playwright.config.ts` WITHOUT a `webServer` (so the first run fails for the right reason)**

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: '.artifacts/test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: '.artifacts/html-report', open: 'never' }],
    ['json', { outputFile: '.artifacts/results.json' }],
  ],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **Step 5: Create the smoke spec `e2e/tests/public/housing-fair.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

// Phase 0 smoke: the public, unauthenticated housing-fair page renders in a
// real browser against the hermetic local stack. No auth, no form submission.
test('public housing-fair page renders unauthenticated', async ({ page }) => {
  await page.goto('/housing-fair');
  await expect(
    page.getByRole('heading', { name: 'Housing fair sign-up' }),
  ).toBeVisible();
});
```

- [ ] **Step 6: Ignore Playwright artifacts in `.gitignore`**

Append to `.gitignore` (after the existing `logs/` block is fine):

```
# Playwright e2e artifacts
e2e/.artifacts/
```

- [ ] **Step 7: Install dependencies and the Chromium browser**

Run from the worktree root (`w:/tmp/hc-e2e-worktree`):

```bash
npm install
npx playwright install chromium
```

Expected: `npm install` links the new `e2e` workspace and adds `@playwright/test` (reports added packages, no errors). `npx playwright install chromium` downloads the Chromium build (reports a version like "chromium ... downloaded" or "is already installed").

- [ ] **Step 8: Run the suite with NO stack running — verify it FAILS correctly (RED)**

Make sure no dev stack is already on `:5173`, then run from the worktree root:

```bash
npm run e2e
```

Expected: FAIL — 1 test failed. The failure is `page.goto('/housing-fair')` unable to connect (e.g. `net::ERR_CONNECTION_REFUSED` at `http://localhost:5173/housing-fair`) or a navigation timeout. This proves the runner, workspace wiring, baseURL, and spec are correct and that the harness fails honestly when the app is down. Do NOT commit yet.

---

## Task 2: Auto-boot the stack via `webServer` and turn the smoke green (GREEN)

**Files:**
- Modify: `e2e/playwright.config.ts` (add the `webServer` block)

- [ ] **Step 1: Add the `webServer` block to `e2e/playwright.config.ts`**

Add this import at the top of the file (below the existing import):

```ts
import { fileURLToPath } from 'node:url';
```

Add this constant above the `export default defineConfig({`:

```ts
// The hermetic dev loop lives at the repo root, one level up from e2e/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
```

Then add this `webServer` property inside the `defineConfig({ ... })` object (e.g. immediately after the `projects` array):

```ts
  webServer: {
    // Boots DynamoDB Local + app(:8080) + worker + Vite(:5173) in hermetic
    // mode. No AWS creds or secrets needed; messaging defaults to console.
    command: 'npm run dev -- --local',
    cwd: repoRoot,
    // Readiness gate: the Vite server is the surface the spec hits, and dev.mjs
    // only starts it after db:start/create/seed, so this also covers DB boot.
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
```

- [ ] **Step 2: Run the suite — verify the stack boots and the smoke PASSES (GREEN)**

From the worktree root:

```bash
npm run e2e
```

Expected: Playwright launches `npm run dev -- --local` (you'll see DynamoDB Local start, tables created, seed run, then app/worker/Vite start), waits for `:5173`, runs the spec, and reports `1 passed`. On completion Playwright tears the stack down. Total time is dominated by the one-time cold boot (container + seed), a few seconds to a couple of minutes on first run.

- [ ] **Step 3: Confirm artifacts were written**

Verify the report dir exists: `e2e/.artifacts/html-report/` and `e2e/.artifacts/results.json` are present. (Open the HTML report any time with `npm run e2e -w @housingchoice/e2e report` — i.e. the `report` script.)

- [ ] **Step 4: Commit Phase 0**

```bash
git add e2e/package.json e2e/tsconfig.json e2e/playwright.config.ts e2e/tests/public/housing-fair.spec.ts package.json package-lock.json .gitignore
git commit -m "feat(e2e): Phase 0 — Playwright harness scaffold + cold-boot smoke

New e2e/ workspace runs one unauthenticated browser smoke (/housing-fair) against
the hermetic --local stack via Playwright webServer; reuseExistingServer:!CI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 0 exit gate (per spec §12 execution model)

1. **Build + test:** Tasks 1–2 complete.
2. **Verification gate (evidence required):** from the worktree root, `npm run e2e` cold-boots the stack and reports `1 passed`, then tears down. Capture that output. (Re-running while a session stack is up should reuse it via `reuseExistingServer`.)
3. **Adversarial review:** dispatch a fresh, independent review sub-agent (no implementation context) over the Phase 0 diff with the off-the-leash mandate from §12 — flag anything wrong at any severity (e.g. webServer teardown leaks, port races, CI vs local divergence, artifact leakage into git, the `test`-script footgun). Orchestrator triages; trivial findings may be ignored, anything deferred is logged here.
4. **Done** only when the suite is green AND the review is clean. Then proceed to the Phase 1 plan.

## Notes carried forward to later phases (do NOT do them now)

- Phase 0 uses `tsx watch` (the existing dev command). A dedicated **non-watch, stable** test-mode launcher for clean Suite runs is built in **Phase 4** (session mode tooling). For a single short smoke this is fine.
- `DEV_AUTH_ENABLED`, the gated `devRouter`, dev-login, the recording messaging driver, the outbox/reseed endpoints, MCP wiring, and the cross-UI flow are Phases 1–5.
