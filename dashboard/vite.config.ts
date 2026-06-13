/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local dev: the app process (npm run dev, :8080) serves /api and /auth; the
// Vite server proxies both there and stamps the DEV origin-secret placeholder
// (the app's validator middleware rejects requests without it — the value
// matches CF_ORIGIN_SECRET's local default in app/src/lib/config.ts).
// Note: the OAuth redirect URI is http://localhost:8080/auth/callback (the
// app, not Vite) — the session cookie is host-scoped to localhost, so it
// rides back through this proxy afterwards.
const appProxy = {
  target: 'http://localhost:8080',
  headers: { 'x-origin-verify': 'dev-placeholder-not-a-secret' },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Don't auto-launch a browser on start. `npm run dev` prints a clickable
    // http://localhost:5173 link in the terminal (see scripts/dev.mjs) — click
    // it to open the UI in your OS default browser when you want it.
    open: false,
    proxy: {
      '/api': appProxy,
      '/auth': appProxy,
      // Public, unauthenticated backend routes (housing-fair signup + the unit
      // flyer). No session needed, but the app's validator still requires the
      // origin-secret header — so these ride the SAME proxy (same target +
      // x-origin-verify) as /api and /auth.
      '/public': appProxy,
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
