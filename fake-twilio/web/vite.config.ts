/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The fake-twilio host (port 8889) serves the control API + SSE + /health. This
// dev server (port 5174) proxies those there so UI iteration (`npm run dev`)
// talks to a running host, exactly as the built UI does when the host serves it.
const host = { target: 'http://localhost:8889' };

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, open: false, proxy: { '/control': host, '/health': host } },
  build: { modulePreload: { polyfill: false } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    testTimeout: 15000,
  },
});
