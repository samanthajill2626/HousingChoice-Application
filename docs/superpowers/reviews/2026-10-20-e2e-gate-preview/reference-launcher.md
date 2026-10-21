# e2e gate on a built dashboard - launcher reference (2026-10-20)

Branch `feat/e2e-gate-preview`, worktree `W:\tmp\e2e-gate-preview`, from main
`3df43172`. Reference only: how the dashboard child is launched, what changes
under `vite preview`, and what does not. The measured result and the verdict are
in [`findings.md`](findings.md).

## 1. How the dashboard is launched (before this branch)

- `npm run e2e` runs Playwright (`e2e/playwright.config.ts`), whose `webServer`
  runs `node scripts/e2e-session.mjs` with `E2E_LANE` and the lane token.
  `npm run e2e:session` runs the same launcher directly. One launcher, two
  callers; the only way to tell them apart is the env the webServer passes.
- The launcher builds the fake-phones UI once (`buildFakeUi`, a `runOnce` child
  run before the fake host starts), starts app + worker + fake-twilio, then
  `startViteNext()` spawns `node node_modules/vite/bin/vite.js` with cwd
  `dashboard/` and `DASHBOARD_PORT` / `APP_PORT` - the Vite DEV server.
- `dashboard/vite.config.ts` reads `DASHBOARD_PORT` for `server.port`, binds
  `127.0.0.1`, `strictPort: true`, and proxies `/api`, `/auth`,
  `/app-identity`, the manifest, `/public`, `/__dev` and `/unit-media` to the
  lane app through one keep-alive `http.Agent`. `commitStampPlugin` injects
  `<meta name="x-app-commit">` from `VITE_E2E_COMMIT` in `transformIndexHtml`;
  `keepAliveHardeningPlugin` sets 65 s keepAliveTimeout on the dev server.
- `e2e/support/preflight.ts` (globalSetup) checks `/__dev/ping` through the
  dashboard origin and compares the HTML's `x-app-commit` to the checkout.

## 2. Where the build goes

Same shape as the fake-phones UI: a `runOnce` child after `buildFakeUi()` and
before the services start. It runs `vite build --outDir
e2e/.artifacts/dashboard-dist --emptyOutDir` with cwd `dashboard/`. The output
is per worktree and gitignored, and it is never `dashboard/dist`, so a deploy
build in the same checkout is never overwritten. No `tsc` step (typecheck is
gate 1). Measured: about 2 s (1.87 s Vite, 2.1 s launcher wall clock).

`NODE_ENV` has to be forced to `production` for the build. The launcher's
childEnv sets `development` for the app, and a Vite build under
`NODE_ENV=development` bundles React's development build (StrictMode replays
included). Building in development mode is a real option of its own; see
findings section 5.

## 3. What `vite preview` honors (Vite 7.3.5, read from `resolvePreviewOptions`)

| Setting | Preview behavior | Here |
|---|---|---|
| port | `preview.port ?? 4173` - does NOT inherit `server.port` | passed as `--port <lane dashboard port>` by the launcher, so a human's `vite preview` keeps 4173 |
| strictPort | `preview.strictPort ?? server.strictPort` | inherited (`true`) |
| host | `preview.host ?? server.host` | inherited (`127.0.0.1`) |
| proxy | `preview.proxy ?? server.proxy` | inherited, same agent and `x-origin-verify` header |
| headers / cors | inherit from server | unchanged (none set) |
| SPA fallback | `htmlFallbackMiddleware` + `indexHtmlMiddleware` on `dist` for `appType: 'spa'` | deep links (`/contacts`) answer `index.html` - checked |
| keep-alive | a separate `http.Server` at Node's 5 s default; `configureServer` does not run | `configurePreviewServer` added to `keepAliveHardeningPlugin`; the response carries `Keep-Alive: timeout=65` - checked |
| identity tag | `transformIndexHtml` runs at BUILD time | the build child inherits `VITE_E2E_COMMIT`, so `dist/index.html` carries the stamp; a fresh build per launch keeps it current |

Middleware order in preview: the proxy runs before compression and static
serving, so proxied responses (the SSE stream included) are not compressed.
Static assets are served with `etag` and `Cache-Control: no-cache`.

## 4. Dev-only paths

- `/__dev/*` and `/auth/dev-login` are app-side routes, mounted only on the
  hermetic local stack. The dashboard shows dev login when `devPing()` gets
  `{dev:true}` at runtime (`dashboard/src/api/endpoints.ts`,
  `routes/Login.tsx`), not from a build-time flag. Through the preview proxy
  `/__dev/ping` answers `{"dev":true,...}` - checked.
- `dashboard/src` reads no `import.meta.env.*` at all, so `DEV` / `PROD` /
  `MODE` change nothing.
- `public/sw.js` is copied to `dist/` and registered the same way.
- CSS-module class names use the same `_<local>_<hash>_<line>` scheme in a
  build (the postcss-modules default in Vite), so the two specs that locate
  the thread scroller by `[class*="_stream_"]` still match (`._stream_2uklq_69`
  in the built CSS).
- **The one behavioral difference is React StrictMode.** `main.tsx` renders
  under `<StrictMode>`, whose double effect run exists only in React's
  development build. Several specs and many unit tests are written around it
  (e.g. `matching-blast-rules` uses a flag, not a one-shot, for that reason;
  `public-pages` asserts only "no growth after the first sign-up"). All of them
  tolerate the single run a production build does; the unit tests that
  exercise StrictMode render it themselves and are unaffected.
- Dashboard source edits are not picked up by a preview-served stack until the
  launcher restarts. That is why `e2e:session` keeps the dev server.

## 5. The launcher mode as built

- `E2E_DASHBOARD_SERVE` = `dev` (default) | `preview`; any other value throws.
- `playwright.config.ts` passes `E2E_DASHBOARD_SERVE ?? 'preview'` in the
  webServer env. So the gate, and any filtered run that boots its own stack,
  gets a build. A run that reuses a live `e2e:session` gets the session's dev
  server. `E2E_DASHBOARD_SERVE=dev npm run e2e` forces the dev server.
- `e2e:session` is unchanged, unless someone exports the variable themselves
  (that is how the measurement session was started).
- The preflight prints `[preflight] dashboard: Vite dev server` or
  `built bundle (vite preview)`, detected by the dev server's `/@vite/client`
  script in the HTML.
