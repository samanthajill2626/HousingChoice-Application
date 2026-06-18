<!-- HISTORICAL-RECORD -->
> ⚠️ **HISTORICAL RECORD — completed task, merged to `main`.** This document describes the
> dashboard-legacy rename as *designed/planned at the time of writing*. The rename shipped and
> is live on `main` (the old UI moved to the `dashboard-legacy` workspace /
> `@housingchoice/dashboard-legacy`; `dashboard/` now holds the new app). **This file is
> NOT current documentation and may have drifted from the live code. Do not treat it as
> authoritative guidance on how the system is built or behaves today.** For current truth read
> the code and the living docs (e.g. `RUNBOOK.md`, `documentation/GLOSSARY.md`). Kept only
> as a point-in-time record of intent.
# Design — Preserve & rename the old dashboard (sub-project A)

**Date:** 2026-06-16
**Status:** Approved (design); pending spec review → implementation plan

## Context

We are replacing the dashboard web UI — the entire end-user interface — with a
brand-new app built from scratch. Before building the new one, we move the
existing dashboard out of the way into a clearly-marked **legacy** workspace and
free up the canonical `dashboard/` name (and the future :5174 slot) for the new
build.

This is the first of two sub-projects:

- **A (this spec):** rename the existing dashboard → `dashboard-legacy`, keep it
  fully functional (dev, prod, e2e) on its current port **:5173**.
- **B (separate brainstorm afterwards):** build the new dashboard from scratch in
  a fresh `dashboard/` on **:5174**.

The existing dashboard is `@housingchoice/dashboard` — a React 19 + Vite 7 SPA,
dev server on :5173, served statically by the app in prod. It is referenced in
five places: root `package.json` workspaces, `scripts/dev.mjs`,
`dashboard/vite.config.ts`, the `Dockerfile`, and the e2e harness.

## Goal

Move the existing dashboard into `dashboard-legacy/` on the **same port :5173**,
preserving its behavior exactly (dev launch, prod static-serving, e2e), so the
`dashboard/` name and the :5174 dev slot are clear for the new app. This is a
**pure rename** — no behavior change.

## Non-goals

- Any change to the dashboard's runtime behavior, UI, or API surface.
- Building or scaffolding the new app (that is sub-project B).
- Backend OAuth changes (the new dash will own Google login; see Carry-forward).

## Design

### 1. Rename the workspace (history-preserving), port unchanged

- `git mv dashboard dashboard-legacy` (preserves git history).
- `dashboard-legacy/package.json`: name `@housingchoice/dashboard` →
  `@housingchoice/dashboard-legacy`.
- Root `package.json` `workspaces`: `"dashboard"` → `"dashboard-legacy"`.
- `dashboard-legacy/vite.config.ts`: **port stays 5173.** Add
  `strictPort: true` (small hardening) so it can never auto-increment onto :5174
  and collide with the future new app — if :5173 is taken it should fail loudly,
  not drift.

### 2. `scripts/dev.mjs`

- Launch the dashboard workspace as `-w @housingchoice/dashboard-legacy` (was
  `@housingchoice/dashboard`), line ~362.
- Banner URLs and the `PUBLIC_BASE_URL` dev default: **unchanged** — still
  :5173. Legacy keeps working (including its existing Google login on :5173) in
  the interim, until sub-project B repoints `PUBLIC_BASE_URL` to :5174.

### 3. `Dockerfile` (production — behavior unchanged)

Repoint every `dashboard` path/workspace at `dashboard-legacy` so prod keeps
building and serving the legacy UI to real users until sub-project B flips it:

- L14, L41: `COPY dashboard/package.json` → `COPY dashboard-legacy/package.json ./dashboard-legacy/`
- L18: `npm ci --workspace app --workspace dashboard ...` → `--workspace dashboard-legacy ...`
- L28–L30: `COPY dashboard/...` source copies → `dashboard-legacy/...`
- L31: `npm run build -w dashboard` → `-w dashboard-legacy`
- L49: `COPY --from=build /srv/app/dashboard/dist ./public` →
  `/srv/app/dashboard-legacy/dist ./public`

`DASHBOARD_DIST_DIR=/srv/app/public` (L50) is unchanged — the runtime path is the
same; only the build-stage source moves.

### 4. e2e — no change

The harness targets :5173, which legacy still owns. The existing dashboard specs
keep passing. (Verify references during implementation; repoint only if any
literal `@housingchoice/dashboard` workspace name appears.)

## Verification

- `npm run dev` launches `dashboard-legacy` on :5173; the UI loads and is
  fully functional (API calls, SSE, dev-login button, existing Google login).
- `npm ci`/workspace resolution succeeds with the renamed workspace.
- e2e suite (`npm run e2e`) stays green.
- `docker build` (or a Dockerfile review) confirms the legacy build/serve paths
  resolve. Spot-check that no stray `@housingchoice/dashboard` (old name) or
  `dashboard/` (old folder) reference remains via a repo-wide grep.

## Carry-forward to sub-project B (new dashboard on :5174)

Validated by adversarial architecture review (2026-06-16). The backend is
origin-agnostic; the new app on :5174 will be fully functional. Record these so
B's brainstorm/plan picks them up:

1. **New `vite.config.ts`** clones the legacy `appProxy` block verbatim — same
   `target: http://localhost:8080`, same `x-origin-verify:
   dev-placeholder-not-a-secret` header, same `/api /auth /public /__dev` proxy
   map — and pins `port: 5174, strictPort: true`.
2. **Google OAuth belongs to the NEW dashboard.** When B wires `dev.mjs` to
   launch both, set `PUBLIC_BASE_URL=http://localhost:5174` and register
   `http://localhost:5174/auth/callback` on the dev Google OAuth client (Cameron).
   No multi-origin backend change is needed because only one dashboard (the new
   one) uses Google login.
3. **dev-login button works on BOTH** dashboards unchanged (origin-relative;
   `POST /auth/dev-login`). Legacy logs in via the button only.
4. **Already fine, no work:** CSRF origin check accepts any localhost port
   (`csrfOrigin.ts:24-31`); origin-secret is value-based not origin-based;
   API/SSE/push calls are origin-relative; SSE has no buffering middleware so it
   streams through a second proxy; webhooks hit the app directly (port-agnostic);
   the session cookie is host-scoped so it already crosses :5173/:5174.
5. **Prod (later):** the app serves one `DASHBOARD_DIST_DIR`. Cutting prod over
   to the new app = repoint the Dockerfile build back at `dashboard/` (the new
   workspace). Two dashboards in prod simultaneously would need a routing change —
   out of scope.
6. **`dev.mjs` concurrency:** `killOthersOn: ['failure','success']` couples all
   processes to one lifecycle (fine). Add a second Vite command for the new
   workspace; pin its port with `strictPort: true` so it can't drift off the
   registered callback port.
