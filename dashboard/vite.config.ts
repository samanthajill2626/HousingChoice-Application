/// <reference types="vitest/config" />
import http from 'node:http';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: the app process (npm run dev, :8080) serves /api and /auth; this
// Vite server proxies both there and stamps the DEV origin-secret placeholder
// (the app's validator middleware rejects requests without it — the value
// matches CF_ORIGIN_SECRET's local default in app/src/lib/config.ts).
// In the e2e stack, APP_PORT is set per-lane by e2e-session.mjs via PORT on the
// app child; Vite reads it here to proxy to the correct lane app port.
// In `npm run dev` (lane 0), APP_PORT is unset → falls back to 8080.
const appPort = Number(process.env['APP_PORT'] ?? 8080);

// ONE keep-alive pool for every request proxied to the app. Without an agent,
// Vite's proxy opens a new TCP connection per request AND sends
// `Connection: close` upstream, so the app answers close and the browser's own
// socket to Vite is closed too: two connections churned per /api call, each
// parking a port in TIME_WAIT for 2 minutes. On 2026-09-30 three e2e scenario
// specs (1.8 min) peaked at 15,490 TIME_WAIT sockets against a ~15k Windows
// ephemeral pool, and full runs lost random late specs to ERR_ADDRESS_IN_USE /
// ERR_NO_BUFFER_SPACE. `timeout` retires an IDLE pooled socket after 30s -
// before the app's 65s keepAliveTimeout (app/src/index.ts) can close it under
// a reuse (Node 24 does not derive this from the server's Keep-Alive hint);
// it never cuts an in-flight response, so the SSE stream is unaffected.
// Dev and e2e only - production has no Vite.
const appAgent = new http.Agent({ keepAlive: true, timeout: 30_000 });
const appProxy = {
  target: `http://127.0.0.1:${appPort}`,
  headers: { 'x-origin-verify': 'dev-placeholder-not-a-secret' },
  agent: appAgent,
};

// Stamps the launch commit (set by scripts/e2e-session.mjs as VITE_E2E_COMMIT)
// into index.html as <meta name="x-app-commit">, so the e2e preflight can detect
// a STALE reused Vite server (one serving old modules at a different commit than
// the checkout — e.g. a session whose Vite wasn't restarted after a backend
// change). A no-op when the env is unset (a normal `npm run dev` / prod build).
function commitStampPlugin() {
  const commit = process.env['VITE_E2E_COMMIT'];
  return {
    name: 'e2e-commit-stamp',
    transformIndexHtml() {
      return commit
        ? [{ tag: 'meta', attrs: { name: 'x-app-commit', content: commit }, injectTo: 'head' as const }]
        : [];
    },
  };
}

// Keep-alive sockets must OUTLIVE the clients pooling against this server -
// the browser and Playwright's request contexts both reuse sockets to Vite,
// and at Node's 5s default the server FINs an idle socket a stalled client
// loop is about to write into: the request dies as a reset or hangs, with
// nothing in any log. Same mechanism reproduced 3/3 against fake-twilio on
// 2026-08-24 and applied to the app server the same day; 65s clears every
// stall a live e2e test can produce (30s per-test budget) with 2x margin,
// and headersTimeout must exceed keepAliveTimeout (Node's rule).
// See docs/issues/app-server-default-keepalive-timeout.md. (The proxy's own
// pool to the app is `appAgent` above; before 2026-09-30 it had none.)
function keepAliveHardeningPlugin(): import('vite').Plugin {
  return {
    name: 'keep-alive-hardening',
    configureServer(server) {
      const http = server.httpServer as
        | { keepAliveTimeout: number; headersTimeout: number }
        | null;
      if (http !== null) {
        http.keepAliveTimeout = 65_000;
        http.headersTimeout = 66_000;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), commitStampPlugin(), keepAliveHardeningPlugin()],
  server: {
    // In the e2e stack, DASHBOARD_PORT is set per-lane by e2e-session.mjs so each
    // worktree gets an isolated dashboard port. In `npm run dev` it's unset and we
    // fall back to the lane-0 dev default (5174). DELIBERATELY not the generic
    // `PORT`: that is the APP's port variable (set in .env / by the app contract),
    // and `npm run dev` passes ONE shared env to every child — reading PORT here
    // made Vite bind the app's 8080 instead of 5174 (2026-07-02 regression).
    // strictPort ensures Vite exits with an error rather than silently drifting
    // to a different port (which would make Playwright's webServer readiness
    // probe poll the wrong address forever).
    port: Number(process.env['DASHBOARD_PORT'] ?? 5174),
    // Bind explicitly to IPv4 loopback so the health probe (127.0.0.1:<port>)
    // always reaches it. Without this, `localhost` on some systems resolves to
    // IPv6 ::1 and the 127.0.0.1 probe gets ERR_CONNECTION_REFUSED.
    host: '127.0.0.1',
    strictPort: true,
    // Don't auto-launch a browser on start. `npm run dev` prints a clickable
    // http://localhost:5174 link in the terminal (see scripts/dev.mjs) — click
    // it to open the UI in your OS default browser when you want it.
    open: false,
    proxy: {
      '/api': appProxy,
      '/auth': appProxy,
      // Runtime identity reads are public, but the app's origin-secret
      // validator still requires the same trusted proxy header.
      '/app-identity': appProxy,
      '^/manifest\\.webmanifest(?:\\?.*)?$': appProxy,
      // Public, unauthenticated backend routes (housing-fair signup + the unit
      // flyer). No session needed, but the app's validator still requires the
      // origin-secret header — so these ride the SAME proxy (same target +
      // x-origin-verify) as /api and /auth.
      '/public': appProxy,
      // Dev-only endpoints (reseed, ping, dev-login). Only reachable
      // when the app is started with DEV_AUTH_ENABLED=1 (the hermetic dev/e2e
      // stack). Mounted on the app; Vite proxies requests through so the UI +
      // e2e specs can reach them at the baseURL (:5174).
      '/__dev': appProxy,
      // Same-origin unit-photo reads (unit-media-cloudfront design 2026-07-21):
      // the app resolves unit.media keys to RELATIVE /unit-media/... URLs, so a
      // Vite-fronted dashboard (local dev, live-mode :5174, hermetic e2e) must
      // proxy the path to the app's streaming route - otherwise the SPA
      // fallback serves index.html and every photo decodes to zero bytes. In
      // deployed envs CloudFront routes this path to S3 before the app.
      '/unit-media': appProxy,
    },
  },
  build: {
    // CSP is `script-src 'self'` (app/src/app.ts) — no inline scripts. Vite's
    // module-preload POLYFILL is an inline <script> in index.html, which that
    // CSP would block, so we disable it (modern browsers + iOS Safari support
    // <link rel=modulepreload> natively — the polyfill only matters for old
    // engines we don't target). The actual app code ships as external
    // /assets/*.js modules, which `script-src 'self'` allows.
    modulePreload: { polyfill: false },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Exercise only the dashboard's own tests — never the app workspace's.
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Headroom over the 5s asyncUtilTimeout (src/test/setup.ts) so a slow async
    // assertion under concurrent-workspace CPU load resolves instead of flaking.
    testTimeout: 15000,
  },
});
