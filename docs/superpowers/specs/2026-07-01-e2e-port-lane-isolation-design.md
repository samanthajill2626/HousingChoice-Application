# E2E port-lane isolation — concurrent worktree e2e without clobbering

**Date:** 2026-07-01 · **Status:** design (ready for implementation plan)
**Related:** `scripts/e2e-session.mjs`, `e2e/playwright.config.ts`,
`dashboard/vite.config.ts`, `e2e/support/preflight.ts`, `scripts/e2e-restart.mjs`,
`scripts/e2e-reseed.mjs`, `scripts/e2e-stop.mjs`.

## 1. Why

Multiple agents work in separate git worktrees concurrently. Each e2e run boots a
hermetic stack on **fixed host ports** — app `:8080`, dashboard Vite `:5174`,
fake-twilio `:8889` — plus **single shared containers** (DynamoDB Local `:8000`,
MinIO `:9000`) with a **shared `TABLE_PREFIX=hc-local-`**. So two concurrent e2e
runs (a) fight for the same ports (the boot clobber) and (b) stomp each other's
tables/seed even if ports didn't collide. This makes concurrent e2e unreliable.

Goal: any number of worktrees run e2e **concurrently, fully isolated, zero-config**,
and never collide with each other, with the human's `npm run dev`, or with any
unrelated process on the machine.

## 2. Model — lanes

A **lane** is an integer that selects a disjoint set of ports + a data namespace.

- **Lane 0 is RESERVED for `npm run dev`** — the standard dev ports (`:8080` app,
  `:5174` dashboard, `:8889` `--mock` fake-twilio, `:8000`/`:9000` local DB/S3).
  `npm run dev` (`scripts/dev.mjs`) is a SEPARATE launcher and is **not modified by
  this work**; those ports stay exactly as today. **No e2e run ever uses lane 0.**
- **Every e2e run uses a lane ≥ 1.** This covers BOTH `npm run e2e` (Playwright)
  and `npm run e2e:session` (interactive), for the human and for agents alike.
- Each worktree has a **stable, hash-derived *preferred* lane** (≥ 1) so it reuses
  its own stack across runs (Playwright `reuseExistingServer`, a kept-open MCP
  browser tab, `e2e:restart`/`reseed`). At startup the preferred lane is
  **free-probed** and bumped past any block that isn't fully free (§4).

## 3. Port + data scheme

Only the **app / dashboard-Vite / fake-twilio** need per-lane ports (they're one
process per run). DynamoDB Local and MinIO **stay single shared containers** on
their fixed ports (`:8000`/`:9000`) — cheap, and a shared DB *server* is fine for
concurrent clients; isolation comes from the **per-lane data namespace**, not
separate containers.

For a lane `L ≥ 1`, derive a contiguous block from a base + stride (exact numbers
are the implementer's, subject to these invariants):
- `app`, `dashboard` (Vite), `fake-twilio`, and the `PUBLIC_BASE_URL` signing base
  each get a distinct port within the lane's block (e.g. `BLOCK_BASE + L*STRIDE + offset`).
- The whole scheme stays clear of the lane-0 ports (`8080/5174/8889/5173`) and of
  the shared container ports (`8000/9000`), for the supported lane count (cap at a
  sane N, e.g. 16, with a clear error past it — §4).
- **Data namespace per lane:** `TABLE_PREFIX=hc-local-<L>-` and media bucket
  `hc-local-media-<L>` (on the shared containers). `db-create`/`db-seed`/`/__dev/reseed`
  already key off `TABLE_PREFIX`, so per-lane tables fall out for free.

`PUBLIC_BASE_URL`, `APP_BASE_URL`, and `TWILIO_API_BASE_URL` are derived per-lane and
must stay consistent between the app and the fake (the fake signs webhooks against
`PUBLIC_BASE_URL` and posts them to `APP_BASE_URL`; the app's signature middleware
reconstructs `${PUBLIC_BASE_URL}${originalUrl}`). `DYNAMODB_ENDPOINT` /
`MEDIA_S3_ENDPOINT` are unchanged (shared containers).

## 4. Resolution, sync, and free-probe

One resolver (a small shared module, e.g. `e2e/support/lane.(ts|mjs)`), used by both
entry points, returns `{ lane, ports, tablePrefix, mediaBucket }`:

1. Compute the **preferred lane** from the worktree — a hash of its absolute path
   (or `git rev-parse --git-common-dir`) mapped into `[1, N]`. An explicit
   **`E2E_LANE` env overrides** it (escape hatch for the rare hash collision).
2. **Free-probe:** starting at the preferred lane, check EVERY port in that lane's
   block; if any is held (another worktree's stack, a leftover, or an unrelated
   process), advance to the next lane whose whole block is free. Exhausting the cap
   → exit with a clear, actionable error.

**Playwright is the decider for `npm run e2e`:** because `webServer` boots the
session and `baseURL` must be known before it starts, the resolver runs **once,
synchronously, at `playwright.config.ts` load**. It sets `baseURL` + the `webServer`
`url` to the chosen dashboard port and passes the chosen lane to the session via
`E2E_LANE` in the `webServer` command's env. `e2e-session.mjs` then simply **obeys
`E2E_LANE`** (no re-resolution → the two never disagree).

**`e2e:session`** (no Playwright) runs the resolver itself, boots on the chosen
lane, and **logs the resulting URLs** (app/dashboard/fake) for the MCP browser.

The running session writes its resolved lane + ports to a per-worktree state file
(e.g. `e2e/.artifacts/lane.json` — `.artifacts` is already per-worktree) so
`e2e:restart` / `e2e:reseed` / `e2e:stop` and any fixture target the SAME stack.

## 5. Touch points

- **`scripts/e2e-session.mjs`** — replace the hardcoded `8080/5174/8889/5173` (and
  the health/reseed/reset URLs, `killPort(5174/8889)`, `TWILIO_API_BASE_URL`,
  `APP_BASE_URL`, `FAKE_TWILIO_PORT`, `TABLE_PREFIX`, `MEDIA_BUCKET`, log lines) with
  values from the resolver / `E2E_LANE`; write the state file.
- **`e2e/playwright.config.ts`** — resolve at load; set `baseURL`, `webServer.url`,
  and `webServer` env (`E2E_LANE`).
- **`dashboard/vite.config.ts`** — `server.port` from env (keep `strictPort: true`
  on the resolved port; drop the hardcoded `5174`).
- **App** (`app/src/index.ts`) — bind a configurable `PORT` from env (confirm/add).
- **e2e fixtures + support** — anything hardcoding `:8080` / `:8889` (preflight
  poll, dev endpoints, `fakeTwilio`/`fakeVoice` fixtures) reads the app/fake URLs
  from a single central module (env / the state file), not literals.
- **`scripts/e2e-restart.mjs` / `e2e-reseed.mjs` / `e2e-stop.mjs`** — target the
  running lane via the state file.
- **`e2e/support/preflight.ts`** — the existing stale-stack guard works against the
  resolved app URL + keeps the commit-stamp freshness check.

## 6. Non-goals

- `npm run dev` is **unchanged** (lane-0 ports; separate launcher).
- No separate DB/MinIO containers per lane (shared containers + per-lane data
  namespace is sufficient and cheaper).
- CI is single-lane — behavior there is unaffected (it can just use the default
  preferred lane; nothing concurrent).

## 7. Testing

- **Two concurrent `npm run e2e` runs from two different worktrees** both go green,
  on different lanes, with no port or data collision (the core acceptance test —
  can be a scripted harness check, not a Playwright spec).
- The free-probe **bumps past a held block**: pre-bind a lane's app port, confirm
  the resolver picks the next free lane.
- **Lane 0 is never selected** by an e2e run; `E2E_LANE` override is honored.
- `npm run dev` (lane 0) running + an agent `npm run e2e` (lane ≥ 1) coexist with no
  interference (ports AND data).
- Existing single-run e2e (`npm run e2e`) stays green unchanged.

## 8. Rollout

Pure dev-infra; no product/runtime/prod impact (deployed envs don't run this
harness). Merges to main and every worktree picks it up on next rebase. Update
`e2e/README.md` with the lane model + `E2E_LANE` override.
