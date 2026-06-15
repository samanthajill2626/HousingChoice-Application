# UI End-to-End Testing Harness — Design & Scope

- **Date:** 2026-06-14
- **Status:** Approved design; pending detailed implementation plan (writing-plans)
- **Owner:** Cameron Abt
- **Authored with:** Claude Code (brainstorming skill)

---

## 1. Problem & Goal

We are entering heavy UI work. Today we have **API-level tests** (Vitest +
supertest in `app/`) and **jsdom component tests** (Vitest + Testing Library in
`dashboard/`), but **nothing drives a real browser against a running stack**.

The goal: give the agent (and sub-agents) "the keys" to do what a human QA does —
spin up the UI after a change, exercise it in a real browser, read the results,
and fix problems **before reporting a feature as complete**. The same tooling
must support:

1. **A written suite** that runs after changes and produces agent-readable
   results (for self-verification and, later, CI).
2. **Off-the-cuff live driving** — the agent navigates, clicks, reads the page,
   and screenshots interactively while iterating.

### Success criteria

- A sub-agent can run one command, get a deterministic pass/fail with readable
  output and failure screenshots, with **no human in the loop**.
- The agent can keep a stack running across many small changes **without losing
  its place in the browser** or paying repeated cold-boot costs.
- The harness runs **fully offline** (no real Twilio / Google / push), and is
  structured so a CI job can be added later with minimal effort.

---

## 2. Context: current architecture (as explored)

- **`app/`** — Express API backend (Node 24, `tsx`). Also serves public-facing
  pages (intake, flyer, housing fair). Tested with Vitest + supertest.
  - Clean adapter seams already exist:
    - `MessagingAdapter` interface with `TwilioMessagingDriver` **and a
      `ConsoleMessagingDriver` fake**, selected by `createMessagingAdapter()`
      via `config.messagingDriver` (`MESSAGING_DRIVER` env).
    - `WebPushAdapter` that **no-ops when unconfigured** (`createWebPushAdapter`
      returns `undefined`).
    - `AuthProvider` interface (`createGoogleAuthProvider`); the auth router
      already accepts an **injected fake provider** for tests.
  - Sessions are **sealed cookies** minted via a `seal()` primitive
    (`{ secret: sessionSecret, purpose }`).
- **`dashboard/`** — React 19 + Vite SPA (staff/navigator UI), React Router 7.
  Tested with Vitest + Testing Library + jsdom.
- **Local stack** — `npm run dev -- --local` is a **hermetic mode**: DynamoDB
  Local container + `hc-local-` tables + seed, dummy creds, **no AWS/secrets**.
  App on `:8080`, dashboard Vite on `:5173` proxying `/api` + `/auth` to `:8080`.
- **Job dispatch** — in `--local` mode jobs are dispatched **in-process** (no
  SQS). Recent commits fixed local dispatch registration; an EventBridge/job
  delivery gap is noted as carried-forward (see Risks §10).

### Domain terminology reminder

One entity, three labels: tenant → "home", landlord/staff → "listing",
code/data → **`unit`**. Test names and fixtures use audience-appropriate copy in
user-facing assertions but `unit`/`unitId` in code. See
`documentation/GLOSSARY.md`.

---

## 3. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Test scope | **Everything, end-to-end** — both UIs + backend, including cross-UI flows (public intake → staff inbox → relay). |
| D2 | External deps (Twilio, Google OAuth, web-push) | **Dev fakes at the boundary** — deterministic, offline. |
| D3 | Live driving mechanism | **Playwright MCP server + written `.spec.ts` suite.** |
| D4 | Run target | **Local/agent-first, CI-ready** (don't build CI now; keep it trivial to add). |
| D5 | Stack orchestration | **Two modes:** Suite mode (Playwright owns lifecycle, stable boot, teardown — for CI/full runs) and Session mode (long-lived persistent stack for the agent inner loop, controlled restarts, browser keeps its place). |
| D6 | Dev endpoint safety | **2 env gates + structural import gate + prod fail-fast** (see §6). |

---

## 4. Tooling & repository layout

- **Engine:** Playwright (real Chromium first; Firefox/WebKit deferred).
- **New top-level `e2e/` workspace** added to root `package.json` `workspaces`,
  isolated from `app`/`dashboard`, owning its own `playwright.config.ts`, deps,
  and `tsconfig.json`.
- **`@playwright/mcp`** registered in project `.mcp.json`, pointed at the
  Session-mode URL (`http://localhost:5173`), for live turn-by-turn driving.

```
e2e/
  playwright.config.ts        # reporters, projects, webServer, artifacts dir
  tsconfig.json
  package.json
  global-setup.ts             # dev-login once -> storageState
  fixtures/
    auth.ts                   # authenticated context per role
    outbox.ts                 # helpers to query /__dev/outbox
    reseed.ts                 # helper to call /__dev/reseed
  support/
    selectors.md              # accessibility-first conventions
  tests/
    public/                   # intake, flyer, housing-fair
    dashboard/                # inbox, contacts, units, broadcasts, admin
    flows/                    # cross-UI end-to-end flows
  .artifacts/                 # screenshots, traces, videos, json report (gitignored)
```

---

## 5. Test-mode wiring (the dev fakes)

A single env profile, layered on hermetic `--local`, flips the stack into a
deterministic test mode:

- **Messaging:** `MESSAGING_DRIVER=console`, upgraded to a **recording driver**
  that appends every outbound SMS/voice to a **`hc-local-dev-outbox` DynamoDB
  Local table**. DynamoDB (not in-memory) is required so **both the app and the
  worker** processes share one outbox — relay/broadcast sends happen in the
  worker.
- **Auth:** the **dev-login endpoint** (§7) — no Google popup.
- **Web-push:** left unconfigured → already no-ops. (Recording hook can be added
  later if we want push assertions.)
- Everything else is the **real** code path against real DynamoDB Local + seed.

### Recording messaging driver

- New `RecordingMessagingDriver` (or `ConsoleMessagingDriver` extended) writing
  `{ id, to, from, body, mediaUrls, kind: 'sms'|'voice', createdAt }` to the
  outbox table.
- Selected by `createMessagingAdapter()` when `MESSAGING_DRIVER=record` (or by
  reusing `console` + an env opt-in — decided in the plan). Keep `console`
  behavior intact for existing callers.
- Unit-tested with Vitest (writes a row, shape correct, no real network).

---

## 6. Dev endpoint safety model (D6 — stronger version)

The dev-only endpoints (§7) are protected by **four** layers:

1. **Env gate A — `NODE_ENV !== 'production'`.** Deployed stacks run
   `NODE_ENV=production`; false there by default.
2. **Env gate B — `DEV_AUTH_ENABLED=1`.** Explicit opt-in, **defaults off**, set
   only by the local test-mode profile and CI. No deployed config sets it.
3. **Structural import gate.** The dev endpoints live in a separate `devRouter`
   module that is **dynamically imported only when both env gates pass**. In a
   normal prod process the code path is never even loaded into the router.
4. **Prod fail-fast.** If `DEV_AUTH_ENABLED=1` is ever seen while
   `NODE_ENV === 'production'`, **config load throws and the app refuses to
   start** — turning a dangerous misconfig into a loud crash, not a silent
   backdoor. (Same pattern as `dev.mjs` refusing `TABLE_PREFIX=hc-prod-`.)

Optional 5th layer (include if cheap): require `DYNAMODB_ENDPOINT` to be the
local endpoint, tying dev-login to local data specifically.

---

## 7. Dev-only introspection endpoints

Mounted only via the gated `devRouter` (§6):

- **`POST /auth/dev-login { email }`** — mints a session for a **seeded user**
  by reusing the **exact same `seal()` session primitive and session shape** as
  the real OAuth callback. Only the identity source differs (seeded users lookup
  vs Google). This keeps the fake faithful to production session semantics.
- **`GET /__dev/outbox?to=&since=`** — returns recorded outbound messages from
  the outbox table. Tests assert "an SMS to +1555… containing X was sent."
- **`POST /__dev/reseed`** — wipes + reseeds DynamoDB Local for a clean slate
  mid-session without a full reboot.

### Browser authentication flow

- Playwright **`global-setup.ts`** calls `dev-login` once per needed role and
  saves cookies via **`storageState`**; tests reuse it (fast, no per-test login).
- The MCP browser authenticates by navigating to the same endpoint.
- Seed data includes **one user per role** (admin, va/navigator) and a tenant
  identity for tenant-facing flows.

---

## 8. The two run modes & commands

### Suite mode (CI / full verification)

- **`npm run e2e`** — Playwright `webServer` cold-boots a **stable,
  non-watching** test stack, runs **all** specs, tears down.
- `reuseExistingServer: !process.env.CI` — always fresh in CI; reuse a running
  Session stack locally.
- Hot-reload **off** (a `tsx watch` restart firing mid-test is a flakiness
  source).

### Session mode (agent inner loop)

- **`npm run e2e:session`** — start the **persistent, non-watching** test stack
  (DynamoDB + seed come up once and stay up). The agent drives via MCP.
- **`npm run e2e:restart`** — controlled ~1s restart of **app/worker only**
  (DynamoDB/seed untouched; **the browser keeps its place** because it is a
  separate process still sitting on its current URL/session).
- **`npm run e2e:reseed`** — clean slate without a full reboot (calls
  `/__dev/reseed` or re-runs seed).
- **`npm run e2e -- <file|--grep>`** — run a subset of specs against the live
  Session stack.
- **`npm run e2e:report`** — open the last HTML report.

### Cost model (why this shape)

- Cold boot (Docker DynamoDB Local + create + seed, a few seconds) is paid
  **once per Suite run** and **once per Session**, never per spec or per change.
- Hot-reload is **not** a cold boot; it only restarts the Node app process
  (~1s) and never restarts DynamoDB. Session mode avoids *automatic* reload so
  the browser is never yanked mid-flow; the agent triggers `e2e:restart` when it
  chooses to apply a backend change. Frontend-only edits can hot-swap in place.

---

## 9. Agent-readable output, artifacts & selectors

### Output

- Reporters: **`list`** (clean terminal lines the agent reads directly) +
  **`html`** + **`json`** to a file.
- On failure: **screenshot + trace + (optional) video** written to
  `e2e/.artifacts/` (gitignored). The agent opens screenshots/traces visually to
  diagnose. Convention mirrors the existing `logs/dev-<ts>.log` pattern.

### Selector & testability convention

- Prefer **accessibility-first** selectors (`getByRole`, `getByLabel`,
  `getByText`) — they double as the snapshot the MCP reads and push the UI toward
  accessibility.
- Add stable **`data-testid`** only where role/label is ambiguous.
- Consequence: UI feature work includes small, deliberate testability additions,
  treated as part of each feature — not a separate retrofit. Documented in
  `e2e/support/selectors.md`.

---

## 10. Risks & prerequisites

- **R1 — Local async job dispatch.** End-to-end relay/broadcast flows depend on
  **local in-process job dispatch running *all* handlers** (recent commits
  touched this; an EventBridge/job-delivery gap is carried-forward). The harness
  needs this path solid for async flows. **Mitigation:** a sub-agent verifies
  local dispatch for every job type a target flow exercises **before** the
  cross-UI flow phase; gaps are fixed (or the flow is scoped to what works) and
  recorded.
- **R2 — Seed determinism.** Tests assume known seed identities/units.
  **Mitigation:** pin a small, explicit seed set used by tests; `reseed` restores
  it exactly.
- **R3 — Port contention.** A stray dev server on `:8080`/`:5173` confuses
  Suite mode. **Mitigation:** `reuseExistingServer: !CI` + a clear health check;
  document checking for a running stack.
- **R4 — Windows + Docker.** DynamoDB Local container start time/availability on
  the dev box. **Mitigation:** Phase 0 proves cold boot on this machine before
  building further.
- **R5 — MCP availability in headless/CI.** The Playwright MCP is for
  interactive driving; the **written suite never depends on it** so CI is
  unaffected.

---

## 11. Phased implementation roadmap

Each phase is independently testable, bounded so a single sub-agent can complete
it without exhausting context, and ends with an explicit **verification gate**.
The detailed step list per phase is produced next by the writing-plans skill;
this is the increment structure.

### Phase 0 — Scaffold & prove cold boot (smallest viable loop)
- Create `e2e/` workspace, install Playwright + Chromium, `playwright.config.ts`
  (reporters, artifacts dir, `webServer` booting `--local` in test mode),
  `tsconfig`, root `npm run e2e` script.
- One trivial spec hitting an **unauthenticated** public page (e.g. intake
  landing) asserting it renders.
- **Verify:** `npm run e2e` cold-boots the stack on this machine, runs the spec
  green, tears down. (Proves R4.)

### Phase 1 — Config flags, gating & fail-fast (backend, no endpoints yet)
- Add `DEV_AUTH_ENABLED` to config; implement the **prod fail-fast** (§6.4) and
  the **structural `devRouter` import gate** (§6.3) — mounting an empty/no-op
  dev router for now.
- **Verify:** Vitest unit tests — fail-fast throws when
  `DEV_AUTH_ENABLED=1 && NODE_ENV=production`; devRouter mounts only when both
  gates pass; absent otherwise.

### Phase 2 — Dev-login + auth fixture
- Implement `POST /auth/dev-login` reusing `seal()`; pin seeded users per role.
- Playwright `global-setup.ts` → `storageState`; `fixtures/auth.ts`.
- **Verify:** an e2e spec logs in via dev-login and lands on an authenticated
  dashboard route; unauthenticated access still redirects.

### Phase 3 — Recording messaging driver, outbox & reseed endpoints
- `RecordingMessagingDriver` → `hc-local-dev-outbox`; wire into
  `createMessagingAdapter`. Implement `GET /__dev/outbox` and `POST /__dev/reseed`
  on the gated devRouter. `fixtures/outbox.ts`, `fixtures/reseed.ts`.
- **Verify:** Vitest for the driver; an e2e spec triggers a **synchronous**
  outbound send and asserts it appears in the outbox; `reseed` clears state.

### Phase 4 — Session mode tooling + MCP
- `e2e:session`, `e2e:restart`, `e2e:reseed`, `e2e:report` scripts;
  `reuseExistingServer: !CI`; register `@playwright/mcp` in `.mcp.json`.
- Write `e2e/README.md`: the **agent workflow** (start session → drive via MCP →
  change code → `e2e:restart` → re-check → run subset → full `npm run e2e`).
- **Verify:** start a Session stack, run a spec subset against it; MCP connects
  and drives one navigation+assertion (agent-confirmed).

### Phase 5 — Proving vertical slice (cross-UI) + R1 check
- **First:** sub-agent verifies local async job dispatch for the relay path (R1);
  fix or scope.
- Implement the flow spec: **public intake submission → appears in staff inbox →
  relay reply → lands in dev outbox**, plus selector additions where needed and
  `selectors.md`.
- **Verify:** the full flow passes in Suite mode end-to-end.

### Phase 6 — CI-readiness documentation (no CI build now)
- Document the exact GitHub Actions job needed (browser install caching, env
  profile, artifact upload) in `e2e/README.md` so it's a copy-paste away.
- **Verify:** doc reviewed; `npm run e2e` already honors `CI` env semantics.

---

## 12. Execution model (sub-agent orchestration)

To keep the orchestrating agent's context clean and reliable, **work is done by
sub-agents; the orchestrator rarely edits files itself.** **All work is serial** —
phases run in order, and the steps within a phase run in order. **No parallel
sub-agents** (parallelization has caused problems recently; the predictability is
worth more than the speed).

The orchestrator holds only the spec, the plan, and checkpoint state — not
file-level detail. Each phase moves through a fixed pipeline, every step gated
before the next:

1. **Build + test** — one focused implementation sub-agent, scoped from the
   writing-plans plan for that phase. Follows the repo's TDD/verification skills
   (writes/extends tests, runs them) and returns a **concise summary +
   verification output**, not raw file dumps.
2. **Verification gate** — the orchestrator runs (or has a sub-agent run) the
   phase's verify command and confirms green output. Evidence required, not
   assertion (verification-before-completion).
3. **Adversarial review** — a **fresh, independent** review sub-agent (no
   implementation context; given the spec + the phase diff) reviews the phase
   with a **broad, unconstrained mandate: find anything wrong, at any severity.**
   Architectural bugs, race conditions (esp. app/worker ↔ shared outbox), broken
   assumptions/invariants, security vulnerabilities (especially the dev-endpoint
   gating in §6), and integration issues are explicit areas of interest but
   **not a limit** — the reviewer is off the leash and should report whatever it
   finds. The orchestrator is **empowered to ignore pedantic or trivial
   findings** at its discretion.
4. **Triage + fix** — the orchestrator triages the findings; confirmed issues go
   to a fix sub-agent (applying receiving-code-review discipline: verify the
   finding before implementing), then re-run steps 2–3 until clean. Anything
   consciously deferred is **logged in this doc, not silently dropped.**
5. **Done = green tests + clean review.** Only then commit the phase and update
   the progress note, so a lost session resumes from the last green, reviewed
   phase.

**Investigation tasks** (e.g. R1 job-dispatch check, selector audits) go to
read-only **Explore** sub-agents that return conclusions only.

---

## 13. Out of scope (YAGNI)

- Cross-browser matrix (Firefox/WebKit) — Chromium only for now.
- Visual-regression / pixel snapshots.
- Real Twilio/Google/push integration tests (explicitly faked per D2).
- Building the CI workflow now (documented only, per D4).
- Load/performance testing.

---

## 14. Open questions for plan stage

- Exact env key for the recording driver (`MESSAGING_DRIVER=record` vs a
  separate `MESSAGING_RECORD=1`) — resolved in writing-plans.
- Whether the optional 5th safety layer (local-endpoint check) is included.
- Precise seed identities/units pinned for tests.

---

## 15. Phase review log (deferred adversarial-review findings)

Findings from each phase's §12 adversarial review that were consciously
deferred (not dropped). Each names the phase that should resolve it.

### Phase 0 (commit `1eb19fc`) — reviewed, 0 critical. Fixed inline: a missing
`typecheck` script in the e2e workspace (commit `a20c6ac`). Deferred:

- **[→ Phase 4] DynamoDB Local container is a leaked singleton.** `scripts/db.mjs`
  starts `hc-dynamodb-local` detached on fixed port 8000 and `dev.mjs` never
  stops it. After `npm run e2e` the container survives; two concurrent runs (or a
  run alongside `npm run dev`) collide on the same container/port/shared data.
  The Phase 4 dedicated non-watch test-mode launcher should own DB lifecycle
  (globalTeardown, or a dedicated e2e container name/port), and/or Phase 6 CI
  must `npm run db:stop` between runs.
- **[→ Phase 4] Windows process-tree teardown is unproven.** The webServer tree
  (`npm → dev.mjs → concurrently → tsx watch ×2 + npm → vite`) has no signal
  handling; on Windows, orphaned `node`/`vite`/watcher processes may survive
  teardown and hold :5173. The Phase 4 launcher should be validated for clean
  teardown (no surviving node/vite after a run) or add explicit tree-kill.
- **[→ Phase 4] `reuseExistingServer` + content-blind readiness can mask a wrong
  stack.** The :5173 gate only checks "does HTTP answer," so a stale orphan or a
  live-mode dev server could be silently reused and yield false greens. Add a
  stack-identity guard (e.g. a hermetic-mode assertion) before tests that touch
  real data.
- **[→ Phase 6] `webServer.timeout: 180_000` may be tight on a cold CI runner**
  (image pull + container + create + seed + cold tsx/vite). Document an image
  prewarm or bump the timeout in the CI job.
- **[→ Phase 4] No `globalSetup`/`globalTeardown` or port preflight** (overlaps
  the above) — fold into the Phase 4 launcher.
- *Ignored (trivial):* `stdout/stderr: 'pipe'` hiding live boot progress on a
  hang — acceptable; surfaces on failure.

### Phase 1 (commits `5f1e456`, `9b56611`; review fixes `aee4009`) — reviewed,
0 critical, no live backdoor. Deploy invariant confirmed: `NODE_ENV` is the
literal `"production"` across terraform/Dockerfile/compose, so both env gates +
the fail-fast bite, and `loadConfig` is the only AppConfig construction path in
prod code. All findings fixed inline (nothing deferred):

- **[fixed] `/__dev/*` fell through to the SPA `index.html` (200) in prod** when a
  dashboard dist dir is configured, because `/__dev` was not a reserved prefix —
  breaking the "absent → 404" invariant and setting a trap for later dangerous
  `/__dev/*` handlers. Added `/__dev` to the SPA-fallback reserved list + a test
  that builds the app with a real temp dist dir and asserts `/__dev/ping` → 404
  while a control SPA route → 200.
- **[fixed] Fail-fast test only covered `'1'`** — now loops all truthy tokens
  (`true/1/yes/TRUE/Yes`) asserting each throws in production.
- **[fixed/minor]** simplified the redundant `originSecret` `/__dev/` condition
  and documented the prefix-exemption blast radius.
- *Note for later phases:* every `/__dev/*` endpoint is exempt from the
  origin-secret validator, so dev-login/outbox/reseed will rely SOLELY on the
  structural absent-in-prod gate. Keep nothing prod-sensitive reachable there.

### Phase 2 (commits `f898fde`, `0776203`; review fixes `138be0f`) — reviewed,
0 critical / 0 important. dev-login reuses the production session primitives
verbatim (byte-compatible, revocable via epoch); the storageState credential is
gitignored; the gate chain holds for the new route. Fixed inline:

- **[fixed]** `express.json()` was applied to ALL dev-router traffic (mounted at
  root before the global parsers) — route-scoped it to `/auth/dev-login` to
  remove the dev/prod body-handling divergence and future-proof against a
  `rawBody` consumer.
- **[fixed]** added the missing security assertions: `HttpOnly`/`SameSite=Lax`
  on the minted cookie, and that `/auth/dev-login` 404s when the router is absent.
- *Deviations accepted (legit):* Playwright `webServer.env: { DEV_AUTH_ENABLED:
  '1' }` (— `--local` doesn't set it; env MERGES over process.env so boot is
  unaffected); setup project `testDir: '.'`; e2e tsconfig include widened.

> **⚠️ PRE-EXISTING BUG surfaced (NOT fixed here — for Cameron / the seed owner):**
> `app/scripts/db-seed.ts` seeds `founder@example.com` with `role: 'founder_admin'`,
> but `UserRole` is only `'admin' | 'va'` and `isUserRole` rejects `founder_admin`.
> Result: any login as the founder (dev-login OR real OAuth) mints a session that
> `toSessionClaims` rejects on the next request — a silent "logged in then
> immediately logged out." The e2e harness sidesteps it by using `va@example.com`.
> Fix candidate: seed the founder as `role: 'admin'` (or add `founder_admin` to
> `UserRole`). Flagging because it likely affects real founder logins too.

### Phase 3 (commits `ad7344b`, `25ef701`, `4e05f9f`, `036dce5`; review fixes
`74f4372`) — reviewed, 0 critical. Recording driver cannot run in prod (flag
fail-fast + structural gate + Terraform-pinned NODE_ENV); `resetLocalData`
cannot escape a hermetic local stack (guard runs before any destructive call,
double-gated on endpoint + exact prefix); seed extraction is byte-identical.
Fixed inline:

- **[fixed — was Important]** `/__dev/*` is unauthenticated + origin-secret-exempt
  and the outbox read exposes message bodies (PII). Added the spec's optional 5th
  safety layer: the dev router now ALSO requires `config.dynamodbEndpoint` to be
  set, so `/__dev/*` only mounts on a hermetic local stack (cloud stacks have no
  local endpoint). `requireAuth` is unsuitable here (dev-login mints the session;
  the outbox fixture has none).
- **[fixed]** `RecordingMessagingDriver.ensureTable` no longer caches a *failed*
  promise (was a silent permanently-empty-outbox / false-green risk).
- **[fixed]** `clearTable` retries `BatchWrite` `UnprocessedItems`; reset guard
  uses exact `prefix === 'hc-local-'`; removed an unused test import.
- **[→ Phase 6 / deferred]** `reuseExistingServer:!CI` can flake the outbox spec
  locally if a dev server is already running WITHOUT `MESSAGING_RECORD_OUTBOX=1`
  (CI forces a fresh boot). And the new `*.integration.test.ts` self-skip when
  DynamoDB Local is down (consistent with the existing pattern) — Phase 6 CI MUST
  start the container or those suites add zero coverage. Document both in Phase 6.

### Phase 4 (commits `46bb480`, `ac72845`, `5d80ef5`, `9711429`; review fixes
`33c130b`) — reviewed, 0 critical. One non-watch launcher (`scripts/e2e-session.mjs`)
serves both suite (Playwright `webServer`) and session mode; restart/reseed/stop/
report scripts; `.mcp.json` (Playwright MCP, `--browser chromium`); `e2e/README.md`.
Operationally verified: suite green via the launcher, ping/reseed/restart work, and
teardown leaves **zero** orphaned processes on :8080/:5173 (parent-death watch +
`e2e:stop`). Fixed inline:

- **[fixed]** mid-implementation: killing the background TASK left the reparented
  launcher tree running (Windows). Added a parent-death watch (launcher auto-exits
  when its parent dies), a PID-file self-heal on start, and an explicit
  `npm run e2e:stop`. Verified: ports empty after task-kill.
- **[fixed — Important]** `restartBackend` had no concurrency guard → rapid
  restarts double-spawned `app` and leaked an untracked process on :8080. Added a
  re-entrancy guard (verified: double-restart → exactly one app process).
- **[fixed]** child-spawn `error` handler; corrected the POSIX `killTree` (direct
  pid, not a group kill, since children aren't detached); README env-source note.

> **MCP capstone — partial (environment-blocked, capability proven):** the live
> "drive the UI via the Playwright **MCP**" step could not run in-session because
> this session's MCP is pinned to the Chrome *channel*, and `npx playwright install
> chrome` needs Administrator on Windows. Worked around in `.mcp.json`
> (`--browser chromium`, reusing the bundled build) for future sessions. The
> underlying capability — a real browser driving the live session stack,
> dev-login, and rendering the authenticated inbox — was proven by running the
> `authenticated inbox` spec against the **live background session** (2 passed,
> 1.7s, via `reuseExistingServer`). **For Cameron:** to use the interactive MCP,
> either run Claude with Administrator once for `npx playwright install chrome`, or
> rely on the `.mcp.json` `--browser chromium` setting (no admin needed).

- **[→ Phase 6 / deferred]** Linux/CI teardown of `e2e:session`/`e2e:stop` is NOT
  yet validated (children aren't reaped via process groups since they're not
  detached); the Windows path is verified and the Playwright-managed CI suite
  survives via Playwright's own group-kill, but standalone Linux session teardown
  needs finishing when CI lands. Also: same-user PID-reuse could (rarely) leak a
  session (recoverable via `e2e:stop`/self-heal); consider pinning the
  `@playwright/mcp` version. Address in Phase 6.

### Phase 5 (commits `5b5e346`, `219077b`; review fix `<this commit>`) — reviewed,
0 critical / 0 important. **R1 RESOLVED:** local in-process job dispatch runs
(immediate jobs dispatch synchronously via `InProcessOutboundQueueAdapter`), and
the chosen slice (staff 1:1 reply) is synchronous regardless — no worker, no relay
provisioning needed. The cross-UI spec drives BOTH real UIs (public form + staff
dashboard, no API shortcuts) and the outbox assertion is grounded in the real
`adapter.sendMessage` call (an outbox row cannot be faked by optimistic UI), so a
green run genuinely exercises the whole stack. Selector adjustments (both
accessibility-first, no test-ids): `getByRole('textbox',{name:'Message'})` to
disambiguate from the `role=log` "Message timeline", and scoping the reply
assertion to that log. Fixed inline:

- **[fixed/minor]** added a comment marking step 4 (thread render) as presentational
  and step 5 (outbox) as the real proof-of-send, so the test can't silently
  degrade into a tautology if step 5 is ever removed.
- *Observations (no action):* implicit cross-spec ordering vs `outbox.spec.ts`'s
  reseed is safe (per-run unique phone isolates state); `.first()` on the inbox
  match is cosmetic given dedupe-by-phone + unique name.
