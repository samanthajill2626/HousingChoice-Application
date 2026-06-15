# E2E Harness — Phase 4: Session mode tooling + MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent a persistent, controllable local stack: one non-watch launcher used by both `npm run e2e` (suite) and `npm run e2e:session` (the agent inner loop), with `e2e:restart` (app+worker only, keeping Vite/DB/browser), `e2e:reseed` (data reset), `e2e:report`, the Playwright MCP registered, and an `e2e/README.md` agent workflow.

**Architecture:** `scripts/e2e-session.mjs` spawns the app, worker, and Vite as **individual `node` processes** (app/worker via `node --import tsx <file>`; Vite via its bin script) — each a single process, so shutdown is a clean `child.kill()` with no process-tree problem. It bakes in the hermetic test env (`--local` equivalents + `DEV_AUTH_ENABLED=1` + `MESSAGING_RECORD_OUTBOX=1`), ensures DynamoDB Local (idempotent) + create + seed once, installs explicit SIGINT/SIGTERM/exit cleanup (fixing the Phase 0 orphan/teardown findings), waits for app health, and `fs.watchFile`s a sentinel to restart **only app+worker** on demand. Playwright's `webServer` runs this same launcher (so suite teardown is clean and the test env is built-in — no `env:{}` needed).

**Tech Stack:** Node 24 (`child_process`, `fs.watchFile`, global `fetch`), tsx (`node --import tsx`), Vite, Playwright, `.mcp.json` (`@playwright/mcp`).

**Working directory:** worktree `w:/tmp/hc-e2e-worktree` on branch `e2e-testing-harness`. Do NOT switch branches or touch the main checkout. Commit on the current branch. **Docker must be running.**

---

## Spec reference

Implements **Phase 4** of `docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md` (§8 modes/commands, §11). Resolves the §15 Phase 0 deferred findings: stable non-watch launcher, explicit teardown/orphan cleanup, and a stack-identity probe (uses `/__dev/ping` from Phase 1). MCP is used interactively; the written suite never depends on it.

## Facts this plan relies on (verified against the codebase)

- `scripts/dev.mjs` spawns app/worker via `tsx watch …` and Vite via `npm run dev -w @housingchoice/dashboard`, using `concurrently` with `killOthersOn:['failure','success']`; no explicit signal handlers in dev.mjs itself. We do NOT modify dev.mjs (the new launcher is separate).
- `scripts/db.mjs` exports `ensureDbStarted()` (idempotent: no-op if `hc-dynamodb-local` already running, else start/create the in-memory container on `:8000`) and `LOCAL_ENDPOINT = 'http://localhost:8000'`, `CONTAINER_NAME`.
- DB setup steps: `tsx app/scripts/db-create.ts` then `tsx app/scripts/db-seed.ts` (both idempotent). dev.mjs runs these in `--local`.
- App health: `GET http://localhost:8080/health` → 200. Vite serves `:5173`. `/__dev/ping` → `{dev:true}` (Phase 1) is the stack-identity probe.
- The dev router (and thus dev-login/outbox/reseed) only mounts when `DEV_AUTH_ENABLED` truthy + non-prod + `DYNAMODB_ENDPOINT` set (Phase 3 fix). So the launcher MUST set `DYNAMODB_ENDPOINT` (local) + `DEV_AUTH_ENABLED=1` + `MESSAGING_RECORD_OUTBOX=1`.
- Local env (from devMode.mjs): `DYNAMODB_ENDPOINT=http://localhost:8000`, `TABLE_PREFIX=hc-local-`, `NODE_ENV=development`, `OTEL_SDK_DISABLED=true`, `PUBLIC_BASE_URL=http://localhost:5173`.
- `node --import tsx <file>` runs TypeScript without a build (tsx ^4.19 supports it). `process.execPath` is the node binary (absolute, no PATH/shell needed). Vite bin: `node_modules/vite/bin/vite.js` (hoisted to repo root in the workspace). Spawning each as a single `node` process means `child.kill()` cleanly stops it on any OS (no tree-kill).
- Root `package.json` scripts has no `e2e:session`/`e2e:restart`/`e2e:reseed`/`e2e:report` yet; `e2e` = `npm run e2e -w @housingchoice/e2e`. The e2e workspace has a `report` script.
- Current `e2e/playwright.config.ts` `webServer`: `command: 'npm run dev -- --local'`, `cwd: repoRoot`, `env: { DEV_AUTH_ENABLED:'1', MESSAGING_RECORD_OUTBOX:'1' }`, `url: 'http://localhost:5173'`, `reuseExistingServer: !CI`, `timeout: 180_000`.
- No `.mcp.json` exists in the repo. (A Playwright MCP may also be provided by a Claude Code plugin in some environments; the repo file makes it explicit/portable.)
- Repo-root `README.md` exists with a concise, hyperlinked, table-using style — match it.

---

## File structure (what this phase creates/changes)

- Create `scripts/e2e-session.mjs` — the unified non-watch launcher (suite + session), with sentinel restart + cleanup.
- Create `scripts/e2e-restart.mjs` — touch the restart sentinel.
- Create `scripts/e2e-reseed.mjs` — POST `/__dev/reseed`.
- Modify `package.json` (root) — add `e2e:session`, `e2e:restart`, `e2e:reseed`, `e2e:report`.
- Modify `e2e/playwright.config.ts` — point `webServer.command` at the launcher; drop now-redundant `env`.
- Modify `.gitignore` — ignore the sentinel dir `e2e/.artifacts/` already covers it (sentinel lives under `.artifacts/`); no change if so.
- Create `.mcp.json` — register `@playwright/mcp`.
- Create `e2e/README.md` — the agent workflow.

---

## Task 1: The session launcher + control scripts

**Files:** Create `scripts/e2e-session.mjs`, `scripts/e2e-restart.mjs`, `scripts/e2e-reseed.mjs`; Modify `package.json`, `e2e/playwright.config.ts`

- [ ] **Step 1: Create `scripts/e2e-session.mjs`**

```js
// Unified non-watch launcher for the e2e stack — used by BOTH `npm run e2e`
// (Playwright webServer) and `npm run e2e:session` (the agent's persistent
// inner-loop stack). Spawns app, worker, and Vite as individual `node`
// processes (clean single-process kill on any OS — no process tree), bakes in
// the hermetic test env, ensures DynamoDB Local + tables + seed once, waits for
// app health, and restarts ONLY app+worker when the restart sentinel changes
// (Vite, the DB, and any attached browser keep running / keep their place).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, watchFile } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dashboardDir = path.join(repoRoot, 'dashboard');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const sentinel = path.join(artifactsDir, '.restart');

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? 'true',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,
  TABLE_PREFIX: process.env.TABLE_PREFIX ?? 'hc-local-',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
  DEV_AUTH_ENABLED: '1',
  MESSAGING_RECORD_OUTBOX: '1',
};

const children = new Map(); // name -> ChildProcess
let shuttingDown = false;

function log(msg) {
  process.stdout.write(`[e2e-session] ${msg}\n`);
}

function spawnNode(name, args, cwd = repoRoot) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) log(`${name} exited (code=${code} signal=${signal})`);
  });
  children.set(name, child);
  return child;
}

function startApp() {
  spawnNode('app', ['--import', 'tsx', path.join('app', 'src', 'index.ts')]);
}
function startWorker() {
  spawnNode('worker', ['--import', 'tsx', path.join('app', 'src', 'worker.ts')]);
}
function startVite() {
  // Run Vite's bin directly so it's a single node process we can kill cleanly.
  spawnNode('web', [viteBin], dashboardDir);
}

function killChild(name) {
  const child = children.get(name);
  if (!child) return;
  child.kill('SIGTERM');
  children.delete(name);
}

async function runOnce(name, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
    child.on('error', reject);
  });
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch('http://localhost:8080/health');
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('app health did not come up in time');
    await new Promise((r) => setTimeout(r, 300));
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down — stopping app, worker, web (DynamoDB container left running)');
  for (const name of [...children.keys()]) killChild(name);
  setTimeout(() => process.exit(code), 500);
}

async function restartBackend() {
  log('restart sentinel changed — restarting app + worker (Vite/DB untouched)');
  killChild('app');
  killChild('worker');
  await new Promise((r) => setTimeout(r, 200));
  startApp();
  startWorker();
  try {
    await waitForHealth();
    log('app + worker back up');
  } catch (err) {
    log(`restart health check failed: ${String(err)}`);
  }
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  if (!existsSync(sentinel)) writeFileSync(sentinel, '0');

  log('ensuring DynamoDB Local…');
  await ensureDbStarted();
  log('creating tables + seeding…');
  await runOnce('db-create', ['--import', 'tsx', path.join('app', 'scripts', 'db-create.ts')]);
  await runOnce('db-seed', ['--import', 'tsx', path.join('app', 'scripts', 'db-seed.ts')]);

  log('starting app, worker, web (non-watch)…');
  startApp();
  startWorker();
  startVite();

  await waitForHealth();
  log('ready — app :8080, web :5173 (DEV_AUTH_ENABLED + MESSAGING_RECORD_OUTBOX on)');

  // Restart only app+worker when the sentinel file is rewritten.
  watchFile(sentinel, { interval: 300 }, () => {
    void restartBackend();
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => {
    for (const name of [...children.keys()]) killChild(name);
  });
}

main().catch((err) => {
  log(`fatal: ${String(err)}`);
  shutdown(1);
});
```

- [ ] **Step 2: Create `scripts/e2e-restart.mjs`**

```js
// Triggers an app+worker restart in a running `npm run e2e:session` stack by
// rewriting the sentinel the launcher watches. Vite, DynamoDB, and any attached
// browser are untouched. No-op-ish if no session is running (just writes a file).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(repoRoot, 'e2e', '.artifacts');
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, '.restart'), String(Date.now()));
process.stdout.write('[e2e-restart] signaled app+worker restart\n');
```

- [ ] **Step 3: Create `scripts/e2e-reseed.mjs`**

```js
// Resets the local stack's data to a clean, freshly-seeded slate by POSTing the
// gated /__dev/reseed endpoint on the running app. Fast (no process restart).
const base = process.env.E2E_APP_URL ?? 'http://localhost:8080';
try {
  const res = await fetch(`${base}/__dev/reseed`, { method: 'POST' });
  if (!res.ok) {
    process.stderr.write(`[e2e-reseed] failed: HTTP ${res.status} (is a session running with DEV_AUTH_ENABLED?)\n`);
    process.exit(1);
  }
  process.stdout.write('[e2e-reseed] local data reset + reseeded\n');
} catch (err) {
  process.stderr.write(`[e2e-reseed] could not reach ${base}/__dev/reseed: ${String(err)}\n`);
  process.exit(1);
}
```

- [ ] **Step 4: Add root scripts** — in `package.json` `scripts`, after the `"e2e": ...` line:

```json
    "e2e:session": "node scripts/e2e-session.mjs",
    "e2e:restart": "node scripts/e2e-restart.mjs",
    "e2e:reseed": "node scripts/e2e-reseed.mjs",
    "e2e:report": "npm run report -w @housingchoice/e2e",
```

- [ ] **Step 5: Point Playwright at the launcher** — in `e2e/playwright.config.ts`, change the `webServer` block: set `command: 'node scripts/e2e-session.mjs'` and REMOVE the `env: { ... }` line (the launcher sets the env itself). Keep `cwd: repoRoot`, `url: 'http://localhost:5173'`, `reuseExistingServer: !process.env.CI`, `timeout: 180_000`, `stdout/stderr: 'pipe'`.

- [ ] **Step 6: Verify the suite still passes via the new launcher**

From the worktree root (Docker up): `npm run e2e`
Expected: the launcher boots (DynamoDB ensured, tables+seed, app/worker/web up), Playwright waits on `:5173`, and all specs pass — setup + housing-fair + 2 auth + outbox flow (the outbox flow proves `MESSAGING_RECORD_OUTBOX` is set by the launcher). Then Playwright tears down the launcher (its SIGTERM handler stops app/worker/web).

- [ ] **Step 7: Verify session mode + reseed + restart operationally**

In one terminal: `npm run e2e:session` (leave running). Wait for `ready`. Then in another:
- `curl -s http://localhost:8080/__dev/ping` → `{"dev":true}` (stack identity).
- `npm run e2e:reseed` → prints `local data reset + reseeded`.
- `npm run e2e:restart` → the session terminal logs `restarting app + worker` then `app + worker back up`; Vite stays up (no `:5173` blip in its log).
- `npm run e2e -- --grep "housing-fair"` against the live session → passes via `reuseExistingServer`.
Then Ctrl-C the session: it logs the shutdown and leaves no orphaned `node` processes (check Task: no app/worker/vite lingering on `:8080`/`:5173`).

- [ ] **Step 8: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add scripts/e2e-session.mjs scripts/e2e-restart.mjs scripts/e2e-reseed.mjs package.json e2e/playwright.config.ts
git -C w:/tmp/hc-e2e-worktree commit -m "feat(e2e): session-mode launcher + restart/reseed/report scripts

One non-watch launcher for suite + session: individual node processes (clean
cross-OS kill), baked-in test env, explicit teardown, and app+worker-only restart
via a sentinel. Playwright webServer now uses it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Register the Playwright MCP + write the agent README

**Files:** Create `.mcp.json`, `e2e/README.md`

- [ ] **Step 1: Create `.mcp.json`** at the worktree root:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

- [ ] **Step 2: Create `e2e/README.md`** — match the repo README's concise, hyperlinked style. Include exactly these sections:

```markdown
# E2E Harness

Playwright end-to-end tests that drive the real dashboard + API against a
hermetic local stack (DynamoDB Local, console messaging, no AWS/Twilio/Google).
Design & rationale: [`docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md`](../docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md).

## Two modes

| Mode | Command | What it does |
|------|---------|--------------|
| **Suite** (CI / full check) | `npm run e2e` | Playwright cold-boots the stack via `scripts/e2e-session.mjs`, runs every spec, tears down. `reuseExistingServer` reuses a running session locally; CI always boots fresh. |
| **Session** (agent inner loop) | `npm run e2e:session` | Long-lived non-watch stack you leave running and drive via the Playwright MCP. DynamoDB + seed come up once. |

Helpers (session mode):
- `npm run e2e:reseed` — reset local data to a clean seeded slate (fast; no restart).
- `npm run e2e:restart` — restart **app+worker only** to pick up backend code changes (Vite, DB, and the browser keep their place).
- `npm run e2e -- --grep "<name>"` — run a subset against the live session.
- `npm run e2e:report` — open the last HTML report.

## Requirements
- Docker running (DynamoDB Local). The launcher sets `DEV_AUTH_ENABLED=1` and
  `MESSAGING_RECORD_OUTBOX=1` so dev-login and the message outbox are available.

## Agent workflow (driving the UI yourself)
1. Start the stack in the background: `npm run e2e:session` (wait for `ready`).
2. Confirm you're on the hermetic stack: `GET /__dev/ping` → `{"dev":true}`.
3. Authenticate the MCP browser: `POST /auth/dev-login` `{ "email": "va@example.com" }`
   (proxied via `:5173`), or navigate the UI. Then drive with the Playwright MCP
   (navigate, snapshot, click, fill, screenshot).
4. Assert outbound texts via `GET /__dev/outbox?to=<phone>`.
5. After a change: backend → `npm run e2e:restart`; data → `npm run e2e:reseed`;
   then re-drive (the browser keeps its page) or run a spec subset.
6. Before claiming done: `npm run e2e` (full suite, green).

## Dev-only surface (local stack only)
`/auth/dev-login`, `/__dev/ping`, `/__dev/outbox`, `/__dev/reseed` mount ONLY
when `DEV_AUTH_ENABLED=1`, `NODE_ENV!=production`, AND a local `DYNAMODB_ENDPOINT`
is set. They never exist in a deployed environment.

## Layout
- `playwright.config.ts` — projects (`setup` → `chromium`), reporters, `webServer`.
- `auth.setup.ts` — dev-login → saved `storageState` (the `vaPage` fixture uses it).
- `fixtures/` — `auth` (`vaPage`), `outbox` (`getOutbox`), `reseed`.
- `tests/` — `public/`, `dashboard/`, `flows/`.
- `.artifacts/` — reports, traces, screenshots, the `.restart` sentinel (gitignored).
```

- [ ] **Step 3: Commit**
```bash
git -C w:/tmp/hc-e2e-worktree add .mcp.json e2e/README.md
git -C w:/tmp/hc-e2e-worktree commit -m "docs(e2e): register Playwright MCP (.mcp.json) + agent workflow README

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 4 exit gate (per spec §12)

1. **Build + test:** Tasks 1–2 complete.
2. **Verification gate (evidence required):** `npm run e2e` green via the new launcher; operational check of `e2e:session` + `e2e:reseed` + `e2e:restart` (Step 7) with no orphaned processes after Ctrl-C; `npm run typecheck -w @housingchoice/e2e` clean. Capture output.
3. **MCP capstone (agent-confirmed):** the orchestrator (not a subagent) starts `e2e:session`, then uses the Playwright MCP to navigate to the live dashboard, dev-login as the VA, and assert the authenticated inbox renders — proving the agent can drive the real UI. (The written suite does NOT depend on MCP.)
4. **Adversarial review:** fresh independent reviewer over the Phase 4 diff, off-the-leash, focusing on: cross-platform correctness of the launcher (Windows process kill, no orphans, `node --import tsx` + vite-bin spawn correctness), the restart sentinel (races, missed restarts, partial-restart leaving a dead app), does pointing the suite webServer at the launcher change/▽weaken anything, MCP config safety, README accuracy, and any regression to the (green) suite.
5. **Done** only on green suite + working session tooling + clean review. Then Phase 5.

## Notes for later phases (do NOT do them now)

- Phase 5 (cross-UI flow) will use this session stack + `e2e:reseed` between runs and must verify local async job dispatch (R1) for the relay path.
- Phase 6 (CI docs) will note: CI must start DynamoDB Local; `reuseExistingServer` is off in CI; integration tests skip without the DB.
