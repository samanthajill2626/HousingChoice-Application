<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed, merged, and frozen (2026-07-02).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.
# E2E port-lane isolation — implementation plan

Executes `docs/superpowers/specs/2026-07-01-e2e-port-lane-isolation-design.md` (source of
truth — read it). Verified touch-point map + decisions: `.superpowers/sdd/lane-audit.md`.

## Global Constraints (bind every task)
- **Lane 0 = today's EXACT ports** (app 8080 / dashboard 5174 / fake 8889 / publicBase 5173),
  RESERVED for `npm run dev`; **NEVER returned to an e2e run**. Every e2e run uses lane ≥ 1.
- **Shared containers stay:** DynamoDB Local (8000) + MinIO (9000) are single shared containers;
  isolation is the per-lane DATA NAMESPACE (`TABLE_PREFIX=hc-local-<L>-`, bucket `hc-local-media-<L>`),
  NOT separate containers. `DYNAMODB_ENDPOINT`/`MEDIA_S3_ENDPOINT` unchanged.
- **Do NOT modify `npm run dev`** (`scripts/dev.mjs`) or make shared `db`/`s3` helpers non-lane-0 for dev.
- **app↔fake consistency per-lane:** the fake signs webhooks against `PUBLIC_BASE_URL` and posts to
  `APP_BASE_URL`; the app reconstructs `${PUBLIC_BASE_URL}${originalUrl}`. All per-lane URL env vars
  (app/fake/publicBase) must be mutually consistent for a given lane. `E2E_LANE` overrides the hash lane.
- **Port scheme (from audit):** `BLOCK_BASE=9001`, `STRIDE=100`, `MAX_LANES=16`; for lane `L≥1`:
  app=`9001+L*100+0`, dashboard=`+10`, fake=`+20`, publicBase=`+30` (lane 1 = 9101/9111/9121/9131).
  Clear of 8080/5174/8889/5173 and 8000/9000 for L=1..16.
- **Commit discipline:** stage EXPLICIT paths; trailer `Co-Authored-By: Claude Opus 4.8 (1M context)
  <noreply@anthropic.com>`. NEVER deploy/secrets/terraform/.env/.docx. Do NOT merge.
- **TDD** where there's logic (the resolver). Keep typecheck + app + dashboard unit suites green.

---

## Task 1: Lane resolver module + unit tests

**Files:** create `e2e/support/lane.mjs` (pure ESM — single implementation; also runnable as a CLI),
`e2e/support/lane.d.ts` (hand-written TS types); modify `e2e/tsconfig.json` (`"allowJs": true` so `.ts`
can import the `.mjs`); test `e2e/support/lane.test.*` (mirror the repo's unit-test setup — likely runs
under the app or a node test runner; audit/implementer picks the location that runs in CI).

**Produces:** `resolveLane(opts?) → { lane, ports: { app, dashboard, fake, publicBase }, tablePrefix, mediaBucket }`.
- Preferred lane = stable hash of the worktree identity (`git rev-parse --git-common-dir` or the abs
  worktree path) mapped into `[1, MAX_LANES]`. `E2E_LANE` env (if set + valid) OVERRIDES it.
- **Free-probe:** starting at the preferred lane, check EVERY port in that lane's block; if any is held,
  advance to the next lane whose whole block is free. Exhausting `MAX_LANES` → throw/exit with a clear,
  actionable error ("all lanes 1..16 busy; set E2E_LANE").
- Ports per the scheme above. `tablePrefix='hc-local-<L>-'`, `mediaBucket='hc-local-media-<L>'`.
- Lane 0's ports (8080/5174/8889/5173) are defined for reference but NEVER returned by `resolveLane`
  (resolution starts at lane 1). `E2E_LANE=0` must be rejected (or clamped) — never let e2e use lane 0.
- **CLI mode:** when `lane.mjs` is run directly (`node lane.mjs`), it resolves (free-probe) and prints
  the result as JSON to stdout — this is the sync bridge `playwright.config.ts` calls via `execSync`.

**Tests (RED first):** hash is stable across calls for the same worktree; `E2E_LANE` override honored;
`E2E_LANE=0` rejected; free-probe bumps past a pre-bound port (bind a lane's app port in-test, assert the
resolver returns the NEXT free lane); lane 0's ports never appear in any resolved block; cap-exceeded
throws a clear error; a resolved block never contains 8080/5174/8889/5173/8000/9000.

---

## Task 2: playwright.config.ts (decider) + scripts/e2e-session.mjs (obey) + state file

**Files:** modify `e2e/playwright.config.ts`, `scripts/e2e-session.mjs`.

**playwright.config.ts:** at config LOAD, resolve the lane SYNCHRONOUSLY via
`execSync('node <path>/lane.mjs')` → parse JSON. Set `baseURL` + `webServer.url` to the chosen
dashboard port; pass the chosen lane to the session via `E2E_LANE` (and any needed URLs) in the
`webServer.command` env. Keep `reuseExistingServer: !CI`. (Optionally also set the resolved
app/fake URLs into `process.env` so test workers/fixtures inherit them — see Task 3.)

**scripts/e2e-session.mjs:** if `E2E_LANE` is set (the Playwright path), OBEY it — resolve ports from
that lane, do NOT re-resolve/re-probe (so config + session never disagree). If unset (interactive
`e2e:session`), run the resolver itself. Then replace ALL hardcoded values (per the audit) with resolved
ones: the `8080/5174/8889/5173` ports, health/reseed/reset/ping URLs, `killPort` targets,
`TWILIO_API_BASE_URL`, `APP_BASE_URL`, `PUBLIC_BASE_URL`, `FAKE_TWILIO_PORT`, `TABLE_PREFIX`,
`MEDIA_BUCKET`, and the log lines. LOG the resolved app/dashboard/fake URLs (for the MCP browser).
Write the resolved `{ lane, ports, urls, tablePrefix, mediaBucket }` to `e2e/.artifacts/lane.json`
(the per-worktree state file) after resolution; clean it up on stop (Task 4).

**Constraint:** keep app↔fake URL consistency (PUBLIC_BASE_URL == the fake's signing base == what the
app reconstructs). Do NOT change `scripts/dev.mjs`.

**Verify:** `npm run e2e` boots on lane ≥ 1 (dashboard/app/fake on 91xx ports), preflight passes, and the
suite runs (feature specs green — the pre-existing rotating scenario flakes are not this task's concern).

---

## Task 3: dashboard/vite.config.ts + central fixtures/support URL module

**Files:** modify `dashboard/vite.config.ts`, `e2e/support/preflight.ts`, `e2e/fixtures/fakeTwilio.ts`,
`e2e/fixtures/fakeVoice.ts` (+ any other fixture/support file with a hardcoded `:8080`/`:8889`); create a
small central module (e.g. `e2e/support/urls.ts`) that resolves the app/fake/dashboard URLs ONCE from the
state file (`e2e/.artifacts/lane.json`) and/or env, and have all fixtures/support import it. NOTE:
`app/src/index.ts` already binds `PORT` from env (config.ts) — confirm, no change needed.

- `vite.config.ts`: `server.port` from env (the resolved dashboard port), keep `strictPort: true`; drop
  the hardcoded 5174. Default to lane-0 (5174) only when no env is set so `npm run dev` is unaffected.
- The central module is the SINGLE place fixtures read URLs; replace every literal `http://localhost:8080`
  / `:8889` in preflight + fixtures with it. Keep preflight's commit-stamp freshness (stale-stack) check,
  now against the resolved app URL.

**Verify:** `npm run e2e` fixtures hit the lane's app/fake URLs (green); typecheck clean (allowJs import
of lane.mjs from .ts resolves).

---

## Task 4: e2e-restart / e2e-reseed / e2e-stop target the running lane + README

**Files:** modify `scripts/e2e-restart.mjs`, `scripts/e2e-reseed.mjs`, `scripts/e2e-stop.mjs`,
`e2e/README.md`.

- Each script reads `e2e/.artifacts/lane.json` to target the RUNNING lane's ports/URLs (reseed → the
  lane's `/__dev/reseed`; restart → the lane's app+worker; stop → the lane's ports + remove the state
  file). Fall back gracefully (clear message) if no state file (no running session).
- `e2e/README.md`: document the lane model, the hash→preferred-lane + free-probe behavior, the `E2E_LANE`
  override, that lane 0 is dev-only, and the concurrent-worktree workflow.

**Verify:** boot a session, `e2e:reseed`/`e2e:restart` hit the right lane, `e2e:stop` tears it down +
removes lane.json.

---

## Task 5: Verification (orchestrator + final review)

- `npm run e2e` in this worktree green on a lane ≥ 1 (end-to-end exercise).
- **Concurrency smoke:** boot two stacks on two lanes (`E2E_LANE=1` and `E2E_LANE=2`), confirm BOTH
  app+dashboard+fake health endpoints respond on their distinct ports with no cross-talk; tear both down.
- Resolver unit tests green (Task 1). typecheck + app + dashboard unit suites green.
- Final whole-branch review; leave branch ready (do NOT merge).
