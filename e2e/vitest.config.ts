import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `support/` joined `performance/` when the lane lease landed there: it is
    // harness code with real unit tests, and it must run under `npm test` like
    // everything else. Playwright specs live in tests/ and are NOT matched.
    include: ['performance/**/*.test.ts', 'support/**/*.test.ts'],
  },
});
