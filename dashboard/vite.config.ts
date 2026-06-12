import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The app process serves /api locally (wired for real in M0.3).
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
