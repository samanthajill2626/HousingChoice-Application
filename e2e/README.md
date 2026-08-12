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

## Page performance profiler (on demand)

`npm run perf:pages` profiles every registered staff navigation destination and
representative read-oriented detail page. It is an on-demand diagnostic, not a CI
gate or production telemetry system. Run it from the repository root and serialize
it with every `npm run e2e`, `npm run e2e:session`, or other profiler run in the same
worktree.

The three target commands are:

```powershell
# Profiler-owned hermetic lane; safe for automated use.
npm run perf:pages -- hermetic --scale=10

# Human only: the imported lane-0 dataset on the local Vite dashboard.
npm run perf:pages -- local --base-url=http://127.0.0.1:5174 --login-email=founder@example.com

# Human only: deployed dev assets/backend with interactive headed OAuth.
npm run perf:pages -- hosted-dev --base-url=https://dev.example.test --headed --browser-channel=chrome
```

An agent may run `local` or `hosted-dev` only when the human explicitly instructs
that individual run and names the target. Their first end-to-end executions are
human-owned: before merge they have guard unit evidence only. This repository does
not automate either target.

### Hermetic scale and controls

Scale 1 adds 100 contacts, 25 properties, 50 placements, 50 tours, 100
conversations, and 10 broadcasts. It keeps the densities at 10 messages per
conversation and 25 recipients per broadcast. Scale multiplies entity counts, not
the two densities. An explicit entity option replaces that scale-derived count:

```powershell
npm run perf:pages -- hermetic --scale=10 --contacts=2500 --messages-per-conversation=20 --cold-repeats=5 --warm-repeats=5 --route-order-seed=240812
```

Other count overrides are `--units`, `--placements`, `--tours`,
`--conversations`, `--broadcasts`, and `--recipients-per-broadcast`. Validation
happens before a lane starts or any data is cleared. Use `--print-config` to validate
a noninteractive command and inspect only its safe resolved configuration:

```powershell
npm run perf:pages -- hermetic --scale=10 --print-config
```

The hermetic target owns a positive e2e lane, resets only that lane, writes the
synthetic performance world, profiles it, and stops only the launcher it started.
It never clears lane 0 or stops shared DynamoDB Local. The count manifest printed
by `--print-config` and stored with the report is the authority for the resolved
totals.

Profiler ownership is fail-closed. The runner acquires an exclusive same-worktree
marker, ignores an inherited `E2E_LANE`, selects a free lane, and gives its launcher
a random owner token. The launcher does not reap occupied ports in profiler mode and
must observe its exact commit and token from its child app before any destructive
reseed. Readiness travels over the direct parent-child IPC channel, not shared stdout.

These are rough second-run planning envelopes, not performance claims. A second run
must first scan and clear the previous generated rows, including embedded broadcast
recipient maps; a first run can therefore be materially faster.

| Scale | Second-run reseed | Default 3 cold + 3 warm total |
|------:|------------------:|------------------------------:|
| 1 | about 1-3 minutes | about 15-30 minutes |
| 10 | about 2-8 minutes | about 30-90 minutes |
| 100 | about 15-45 minutes | about 2-6 hours |

Machine load, Docker storage, route timeouts, client truncation, and the shape of a
prior overridden run can move these ranges substantially. Use lower repeat counts
for exploration, then repeat the controlled command for evidence.

### Local imported-data target (human only)

Prepare and review the real-data import before profiling. Follow
[`RUNBOOK.md`'s import procedure](../RUNBOOK.md#importing-the-founders-quo--airtable-data-m16):
run `import:plan`, review the external workbook, run `import:apply --dry-run`, then
explicitly apply it with the target environment set to DynamoDB Local and
`TABLE_PREFIX=hc-local-`. The profiler never runs the importer, seeds, reseeds,
provisions a user, or changes this dataset. Start the local dev stack normally and
use an already existing admin email with `--login-email` when the imported data does
not contain the default `founder@example.com` identity.

Local accepts only a loopback URL on port 5174 and verifies `dev: true` plus exactly
the lane-0 `hc-local-` prefix. It then requires an interactive terminal and this
exact typed response before login:

```text
PROFILE http://127.0.0.1:5174
```

There is no flag or environment bypass. A local run measures Vite-served development
modules and is best for dataset-scaling diagnosis. It does not represent built
assets, CDN behavior, or production-user telemetry.

### Hosted-dev target (human only)

Hosted-dev requires HTTPS and `--headed`. Complete normal Google OAuth in the opened
browser; the runner waits for an admin session and then proves the authenticated
environment is exactly `dev`. Authentication is outside measured samples. The
Playwright storage-state object stays only in process memory and is never written to
disk.

Google may reject an automation-controlled bundled Chromium session. Before using
the documented `--browser-channel=chrome` fallback on Windows, install that channel
once from an Administrator PowerShell:

```powershell
npx playwright install chrome
```

Hosted-dev measures the deployed build, CDN/network effects, and deployed backend.
It is still not production-user telemetry. If OAuth refuses both browser channels,
stop and reassess the authentication approach; do not work around the target proof.

### Read-only boundary

The profiler performs navigation and exact read-oriented row-link clicks only. It
does not exercise workflow actions, forms, uploads, or media controls. Before any
measured navigation it installs browser-side CDP Fetch patterns derived from the
mechanically checked mutation catalog. The patterns cover cataloged first-party
`/api/**`, `/auth/**`, and `/__dev/**` mutation paths. Matching reads continue and
every matching `POST`, `PUT`, `PATCH`, and `DELETE` is blocked before the network and
recorded only as a sanitized method, endpoint template, and `source_click` or
`destination_mount` phase. Static assets, Vite modules, and unrelated reads do not
cross the driver interception boundary. CDP interception preserves the browser HTTP
cache; `summary.json` records this as `browser.httpCache: "preserved"`. Mount-time
and row-click mark-read attempts are expected blocked evidence, not proof of a
failed run.

This is a navigation-only guarantee, not a blanket network sandbox. Public paths
under `/public/**`, media reads under `/unit-media/**`, and direct storage origins
are outside the interception scope. The registry does not navigate public pages or
invoke media/storage write controls, so those residual paths are read-only in the
documented workflow. A new navigation-triggered mutation must be added to the
mechanically checked mutation catalog and self-QA state proof.

`/api/events` is a permanent event stream and is never intercepted, never counted
as pending readiness work, and never emitted as request evidence. Known timer polls
and SSE-triggered refreshes are retained as `background_refresh` or
`background_shell` counts separately from the primary page-load request counts,
bytes, and quiet-window timing. They cannot satisfy a required endpoint contract.

### Artifacts, privacy, and baselines

Each run writes a gitignored directory at
`e2e/.artifacts/performance/<timestamp>-<random>/` containing `report.md`,
`summary.json`, and `requests.jsonl`. A valid baseline additionally produces
`comparison.md` and `comparison.json`. Normal hermetic output first prints safe
resolved seed counts, then the safe run-directory name. Candidate serialized artifact
strings are scanned in memory before staging is created or bytes are written, then
the final staged bytes are scanned again before publication. On either failure the
runner writes only a fixed allowlisted `quarantine.json` manifest in a
`-quarantined` directory, prints the safe directory plus filenames and closed reason
categories in fixed terminal records, and returns nonzero.

Artifacts contain sanitized endpoint templates and allowlisted numeric/categorical
evidence. They never contain response or request bodies, headers, cookies, auth
material, query values, raw entity IDs, names, phone numbers, email addresses,
screenshots, HAR files, or browser traces. A quarantined artifact contains only the
fixed manifest, never scanned report content. Do not paste private source data into a
handback.

Compare a controlled run with a prior `summary.json`:

```powershell
npm run perf:pages -- hermetic --scale=10 --route-order-seed=240812 --baseline=e2e/.artifacts/performance/PRIOR_RUN/summary.json
```

Comparison reports absolute and percentage deltas for matching route/mode medians.
It does not enforce a budget or fail because a metric regressed. Keep target kind,
resolved counts/densities, route set, browser major/channel, viewport, repeat counts,
route-order seed, firewall version, settle window, and poll interval identical for a
controlled comparison. A changed app revision is the intended experimental variable;
a missing revision is warned as `target_version_unverified`.

### Reading the report

A cold sample uses a fresh authenticated browser context, empty HTTP cache, blocked
service workers, and direct navigation. A warm sample reuses one context and the SPA
shell, prepares the declared source page outside measurement, then resets collection
immediately before the exact destination click. Hermetic and local runs first warm
the process-wide Vite transform/module cache with one discarded route; hosted-dev
uses built assets and skips that warmup.

Default results are three cold and three warm samples per route. Read the median with
the minimum/maximum spread, request/resource counts, background counts, and recorded
route order. Contention, Docker and filesystem caches, browser/OS version, network/CDN
variance, long tasks, Vite transform caching, and earlier route order all add noise.
Warm samples deliberately share a context, so use the same `--route-order-seed` for
comparisons. Increase repeats when the spread is material; P95 remains null until a
route/mode has at least 20 successful samples.

`client_truncated: true` means a list hook hit its client walk ceiling, so a plateau
past that point is truncation, not evidence that the page scales. Contacts stop at 40
pages x 100 records per type; properties stop at 40 pages x the server default of 50
(2,000); the placements page performs five independent walks capped at 50 pages x 50
(2,500) each. Every passive `useContacts` consumer inherits the contacts ceiling:
contact lists, email and quarantine, tour lists, contact detail, property detail, and
relay conversation detail. Tour detail and placement detail do not passively mount
`useContacts`; the hook exists only inside their closed add-contact form, so both are
correctly reported with `load_scale_bearing: false`. This is the adjudicated correction
to the design document's older enumeration; the approved design remains unchanged.

Every ranking row separately reports `surface_scale_bearing` (does rendered volume
grow with the synthetic world?) and `load_scale_bearing` (does background/read work
grow?). A low-ranked route with a false flag on the relevant axis is not proof that it
scales. Email is the useful split example: its fixed unmatched-email surface does not
grow, but its passive contact load does.

At higher conversation scales, `/inbox` is legitimately expensive: page 1 renders 30
contact rows plus every generated open/connecting relay group, up to the profiler's
1,000-group ceiling, and each relay row has server-side lookup cost. Inbox is both a
ranked destination and the warm source for `/conversations/:conversationId`, so read
the conversation detail's source-preparation time separately from its measured click.

### Session ownership and recovery

Hermetic mode refuses to start if this worktree already has a live interactive
session or full-suite launcher. The guard is one-directional: a later e2e command in
the same worktree can apply the launcher's normal self-heal and reap the profiler's
owned launcher. The human must serialize profiler and e2e work in a worktree.

Normal profiler cleanup stops only its recorded launcher and leaves shared DynamoDB
Local running. If cleanup fails, or the profiler is killed during boot before the
launcher's parent-death watch is armed, run the same-worktree recovery command:

```powershell
npm run e2e:stop
```

It reaps the lane processes and clears the session/lane state files. Confirm the
ports are free before rerunning; never kill shared MCP browser processes.

### DynamoDB Local integration proof

The performance seed integration suite follows the repository's Docker-optional test
convention. If DynamoDB Local is unavailable, ordinary `npm test` emits the stable
`performance_seed_integration_skipped_dynamodb_unavailable` warning and skips that
suite so pure tests remain usable. This is intentionally a loud skip, not proof that
the seed boundary ran. Plan-owned seed verification sets
`PERF_SEED_REQUIRE_DYNAMO=1`; in that mode an unreachable DynamoDB Local is a hard
failure and the targeted suite cannot pass without executing its physical namespace,
reset, writer, and reader assertions.

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

Each lane gets its own DynamoDB table prefix (`hc-local-<L>-`), its own S3 bucket
(`hc-local-media-<L>`), **and its own DynamoDB Local *database* via a per-lane
access key (`hclane<L>`)** — the shared container (no `-sharedDb`) keeps a
separate store + write lock per (access key, region) pair, so lanes never share
data OR write throughput. To inspect a lane's tables with the AWS CLI you must
use ITS key (see `accessKeyId` in `e2e/.artifacts/lane.json`); the `local` key
shows only the dev loop's store.

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
  "mediaBucket": "hc-local-media-1",
  "accessKeyId": "hclane1"
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
