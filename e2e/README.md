# E2E Harness

Playwright end-to-end tests that drive the real dashboard + API against a
hermetic local stack (DynamoDB Local, console messaging, no AWS/Twilio/Google).
Design & rationale: [`docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md`](../docs/superpowers/specs/2026-06-14-ui-e2e-testing-harness-design.md).

## Setup (first time)

Run these once from the repo root:

1. **Docker** must be running (DynamoDB Local is a container).
2. **Install deps:** `npm ci` (or `npm install`) — pulls in `@playwright/test`.
3. **Install the bundled browser** the suite uses (no admin needed):
   ```
   npx playwright install chromium
   ```
4. **Verify:** `npm run e2e` — should boot the stack and pass. You're set for the
   suite and for headed/UI runs (`npm run e2e -- --headed`, `npx playwright test --ui`).

### Interactive driving via the Playwright MCP (optional)

Driving the live UI through an MCP server has a browser-channel wrinkle on Windows:

- **This project's MCP** ([`.mcp.json`](../.mcp.json)) is configured with
  `--browser chromium`, so it reuses the bundled build from step 3 — **no admin
  needed**. Prefer this if your client surfaces it.
- **A Claude-client *plugin* Playwright MCP** (the `mcp__plugin_playwright_*`
  tools) defaults to the **`chrome` channel** (real Google Chrome), NOT bundled
  chromium. If you see:
  ```
  Error: Chromium distribution 'chrome' is not found ... Run "npx playwright install chrome"
  ```
  install the chrome channel **once, in an Administrator terminal** (it writes to a
  machine location, which is why it needs elevation on Windows):
  ```
  # Administrator PowerShell, from the repo root:
  npx playwright install chrome
  ```
- **No admin / don't want the MCP?** You don't need it. The written suite and
  `--headed`/`--ui` runs use bundled chromium and need no elevation; the MCP is
  only for free-form interactive exploration.

## Two modes

| Mode | Command | What it does |
|------|---------|--------------|
| **Suite** (CI / full check) | `npm run e2e` | Playwright cold-boots the stack via `scripts/e2e-session.mjs`, runs every spec, tears down. `reuseExistingServer` reuses a running session locally; CI always boots fresh. |
| **Session** (agent inner loop) | `npm run e2e:session` | Long-lived non-watch stack you leave running and drive via the Playwright MCP. DynamoDB + seed come up once. |

Helpers (session mode):
- `npm run e2e:reseed` — reset local data to a clean seeded slate (fast; no restart).
- `npm run e2e:restart` — restart **app+worker only** to pick up backend code changes (Vite, DB, and the browser keep their place).
- `npm run e2e:stop` — reliably stop the session stack (kills the launcher + children, removes `lane.json`).
- `npm run e2e -- --grep "<name>"` — run a subset against the live session.
- `npm run e2e:report` — open the last HTML report.

## Port-lane model

Each e2e run (or `npm run e2e:session`) operates in an isolated **lane** — a
block of four ports that are never shared with `npm run dev` or another concurrent
worktree.

### Lane 0 — dev only

Ports `8080 / 5174 / 8889 / 5173` are **lane 0** — the conventional `npm run dev`
ports. **No e2e run ever uses lane 0.** The lane resolver always returns a lane
≥ 1, and lane 0 is explicitly forbidden.

### Lanes 1–16 — e2e lanes

| Resource | Formula | Example (lane 1) |
|----------|---------|------------------|
| App (Express) | `9001 + L*100 + 0` | `:9101` |
| Dashboard (Vite) | `9001 + L*100 + 10` | `:9111` |
| Fake-Twilio | `9001 + L*100 + 20` | `:9121` |
| Public base URL | `9001 + L*100 + 30` | `:9131` |

Each lane gets its own DynamoDB table prefix (`hc-local-<L>-`) and S3 bucket
(`hc-local-media-<L>`) — data never crosses between lanes.

### How a lane is picked

1. **`E2E_LANE` env var** (set by `playwright.config.ts` when it resolves a lane;
   also an escape hatch for hash collisions — e.g. `E2E_LANE=3 npm run e2e`).
2. **Hash → preferred lane.** `e2e/support/lane.mjs` hashes `git rev-parse
   --absolute-git-dir` (per-worktree gitdir) with djb2 → maps to lane `[1..16]`.
   Different worktrees hash to different preferred lanes, so concurrent worktrees
   naturally spread out.
3. **Free-probe.** If the preferred lane's four ports are occupied (a session is
   already running there), the resolver walks forward until it finds a completely
   free lane.

### Concurrent worktrees

Multiple worktrees can each run `npm run e2e` simultaneously. Each auto-picks its
own free lane (step 3 above), so they never share ports, tables, or buckets. If
all 16 lanes are occupied, the resolver exits with a clear error and the offending
worktree can use `E2E_LANE=<n>` to force a specific lane after a `npm run
e2e:stop` in that worktree.

**Cold-start caveat.** The shared containers (DynamoDB Local `:8000`, MinIO `:9000`)
are single instances. If two sessions start *from cold at the same instant*, both
race to `docker run` the same container — the loser hits a name/port conflict. This
is narrow (it only bites when both containers are down AND two starts land within
the same moment) and self-corrects on a re-run. To avoid it entirely when kicking
off several worktrees at once, warm the containers first: `npm run db:start &&
npm run s3:start` (idempotent — "already running" once up), then start the e2e runs.
The lanes themselves are fully isolated once booted.

### `e2e/.artifacts/lane.json`

Every session writes its resolved state to `e2e/.artifacts/lane.json` before
starting children:

```json
{
  "lane": 1,
  "ports": { "app": 9101, "dashboard": 9111, "fake": 9121, "publicBase": 9131 },
  "urls":  { "app": "http://127.0.0.1:9101", "dashboard": "http://127.0.0.1:9111",
              "fake": "http://127.0.0.1:9121", "publicBase": "http://127.0.0.1:9131" },
  "tablePrefix": "hc-local-1-",
  "mediaBucket": "hc-local-media-1"
}
```

The helper scripts (`e2e:reseed`, `e2e:restart`, `e2e:stop`) read this file to
target the running lane. It is gitignored. `e2e:stop` removes it on teardown so a
stale file cannot mislead the next run.

### 127.0.0.1 convention

All URLs in the harness use `127.0.0.1` — **never** bare `localhost`. On systems
where Node resolves `localhost` to `::1` (IPv6) instead of `127.0.0.1` (IPv4),
a probe of `127.0.0.1:<port>` sees a free port even if the process is listening
on `localhost`, causing a false "free" and a double-bind. Forcing IPv4 throughout
the lane stack eliminates this class of failure.

## Requirements
- Docker running (DynamoDB Local). The launcher sets `DEV_AUTH_ENABLED=1` and
  `MESSAGING_RECORD_OUTBOX=1` so dev-login and the message outbox are available.
- **Env vars:** the session launcher reads only `process.env` (hermetic/reproducible) and does NOT merge a local `.env` the way `npm run dev -- --local` does — so `TABLE_PREFIX`/`DYNAMODB_ENDPOINT` overrides in `.env` won't affect `e2e:session`.
- **Windows note:** killing the background task alone can leave the reparented node tree running on `:8080`/`:5173`. The launcher now auto-exits when its parent dies (parent-death watch), and `npm run e2e:stop` or the next `npm run e2e:session` (self-heal) also clean up any stale processes.
- **Browsers:** see [Setup](#setup-first-time) — the suite uses bundled Chromium
  (no admin); interactive MCP driving may need a one-time admin `npx playwright
  install chrome` if your client's plugin MCP uses the chrome channel. The suite
  never depends on the MCP.

## Agent workflow (driving the UI yourself)
1. Start the stack in the background: `npm run e2e:session` (wait for `ready`).
2. The launcher logs the lane URLs: `app=http://127.0.0.1:<port> dashboard=…`.
3. Confirm you're on the hermetic stack: `GET /__dev/ping` via the dashboard URL → `{"dev":true}`.
4. Authenticate the MCP browser: `POST /auth/dev-login` `{ "email": "va@example.com" }`
   (proxied via the dashboard URL), or navigate the UI. Then drive with the Playwright MCP
   (navigate, snapshot, click, fill, screenshot).
5. Assert outbound texts via `GET /__dev/outbox?to=<phone>`.
6. After a change: backend → `npm run e2e:restart`; data → `npm run e2e:reseed`;
   then re-drive (the browser keeps its page) or run a spec subset.
7. Before claiming done: `npm run e2e` (full suite, green).

## Dev-only surface (local stack only)
`/auth/dev-login`, `/__dev/ping`, `/__dev/outbox`, `/__dev/reseed` mount ONLY
when `DEV_AUTH_ENABLED=1`, `NODE_ENV!=production`, AND a local `DYNAMODB_ENDPOINT`
is set. They never exist in a deployed environment.

## Layout
- `playwright.config.ts` — projects (`setup` → `chromium`), reporters, `webServer`.
- `auth.setup.ts` — dev-login → saved `storageState` (the `vaPage` fixture uses it).
- `fixtures/` — `auth` (`vaPage`), `outbox` (`getOutbox`), `reseed`.
- `support/` — `selectors.md` (the selector conventions), `urls.ts` (central lane-URL module), `lane.mjs` (lane resolver), `preflight.ts` (globalSetup).
- `tests/` — `public/`, `dashboard/`, `flows/`.
- `.artifacts/` — reports, traces, screenshots, the `.restart` sentinel, `lane.json` (gitignored).

## CI readiness (documented, not yet wired)

CI is intentionally **not built** (project decision D4) — but the harness is
CI-ready and `npm run e2e` already honors CI semantics via `playwright.config.ts`:
- `reuseExistingServer: !process.env.CI` — CI always boots a fresh stack (never
  reuses a stale/leaked one); locally a running `e2e:session` is reused.
- `forbidOnly: !!process.env.CI` — a stray `test.only` fails the CI run.

To wire it later, a GitHub Actions job needs all of the following:

1. **Node 24 + `npm ci`.**
2. **Docker / DynamoDB Local.** The e2e launcher starts the container via
   `scripts/db.mjs` (GitHub `ubuntu-latest` runners have Docker preinstalled).
   The app `*.integration.test.ts` and the e2e launcher BOTH need DynamoDB Local —
   without it the integration suites silently **self-skip** (zero coverage) and the
   launcher's DB step fails. Start + create + seed it before the unit/integration
   run: `npm run db:start && npm run db:create && npm run db:seed`.
3. **Bundled Chromium with caching** — `npx playwright install --with-deps
   chromium` (cache `~/.cache/ms-playwright`). Do NOT use the `chrome` channel.
4. **Run with `CI=1`** so the semantics above engage.
5. **Upload `e2e/.artifacts/`** (HTML report, traces, screenshots, videos) on
   failure for debugging.
6. **Cold-runner timing:** first `--local` boot pulls `amazon/dynamodb-local` +
   cold-starts tsx/vite; if `webServer.timeout` (180s) proves tight on a cold
   runner, prewarm the image (`docker pull amazon/dynamodb-local`) or raise it.

Sample workflow (copy to `.github/workflows/e2e.yml` when CI is adopted):

```yaml
name: e2e
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - uses: actions/cache@v4
        with:
          path: ~/.cache/ms-playwright
          key: ${{ runner.os }}-pw-${{ hashFiles('package-lock.json') }}
      - run: npx playwright install --with-deps chromium
      - name: Start DynamoDB Local (+ tables + seed)
        run: npm run db:start && npm run db:create && npm run db:seed
      - name: Unit + integration tests
        run: npm test
      - name: E2E
        run: npm run e2e
        env: { CI: '1' }
      - if: failure()
        uses: actions/upload-artifact@v4
        with: { name: e2e-artifacts, path: e2e/.artifacts/ }
```

**Known limitations to resolve when CI lands:**
- CI uses the Playwright-managed `webServer` (it starts/stops
  `scripts/e2e-session.mjs`); on Linux, Playwright tears the webServer down via its
  own process-group kill, so suite teardown is clean. The **standalone**
  `e2e:session`/`e2e:stop` teardown is verified on Windows but **not yet validated
  on Linux** (children aren't reaped via process groups since they aren't spawned
  detached) — only relevant for interactive Linux use, not the CI suite.
- Consider pinning `@playwright/mcp` to the installed Playwright version in
  `.mcp.json` (the MCP is interactive-only; CI never uses it).
