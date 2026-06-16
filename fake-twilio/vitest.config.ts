import { defineConfig } from 'vitest/config';

// Scope the backend suite to test/ so a bare `vitest run` does NOT recursively
// sweep the nested web app's jsdom/React tests (fake-twilio/web/src/**/*.test.tsx),
// which run under their own workspace (`@housingchoice/fake-twilio-web`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
