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
    proxy: {
      '/api': appProxy,
      '/auth': appProxy,
    },
  },
});
