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
- `npm run e2e:stop` — reliably stop the session stack (kills the launcher + children).
- `npm run e2e -- --grep "<name>"` — run a subset against the live session.
- `npm run e2e:report` — open the last HTML report.

## Requirements
- Docker running (DynamoDB Local). The launcher sets `DEV_AUTH_ENABLED=1` and
  `MESSAGING_RECORD_OUTBOX=1` so dev-login and the message outbox are available.
- **Env vars:** the session launcher reads only `process.env` (hermetic/reproducible) and does NOT merge a local `.env` the way `npm run dev -- --local` does — so `TABLE_PREFIX`/`DYNAMODB_ENDPOINT` overrides in `.env` won't affect `e2e:session`.
- **Windows note:** killing the background task alone can leave the reparented node tree running on `:8080`/`:5173`. The launcher now auto-exits when its parent dies (parent-death watch), and `npm run e2e:stop` or the next `npm run e2e:session` (self-heal) also clean up any stale processes.
- The written suite uses Playwright's **bundled Chromium** (`npx playwright install
  chromium`). The Playwright **MCP** (for interactive driving) is registered in
  [`.mcp.json`](../.mcp.json) with `--browser chromium` so it reuses that bundled
  build — do NOT use the `chrome` channel (`npx playwright install chrome` needs
  Administrator on Windows). The suite never depends on the MCP.

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
