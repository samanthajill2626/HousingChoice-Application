import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// The hermetic dev loop lives at the repo root, one level up from e2e/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './tests',
  outputDir: '.artifacts/test-results',
  // Fail fast (with an actionable message) if the stack under test is stale or
  // misconfigured — e.g. a hand-started session reused via reuseExistingServer
  // that lacks outbox recording. See support/preflight.ts.
  globalSetup: './support/preflight.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: '.artifacts/html-report', open: 'never' }],
    ['json', { outputFile: '.artifacts/results.json' }],
  ],
  use: {
    // The dashboard (:5174). Specs hit :5174, the fake-phones host (:8889), or
    // the backend API directly. Specs that need a different origin use an
    // absolute URL.
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 15_000,
    // Opt-in slow motion for watching a --headed run: each browser action is
    // delayed by E2E_SLOWMO milliseconds. Default 0 = no delay, so CI and normal
    // runs are unaffected. e.g.:
    //   E2E_SLOWMO=800 npm run e2e -w @housingchoice/e2e -- <spec> --headed
    launchOptions: { slowMo: Number(process.env.E2E_SLOWMO ?? 0) },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Boots DynamoDB Local + app(:8080) + worker + Vite (:5174) + fake-twilio
    // (:8889) in hermetic mode. No AWS creds or secrets needed; messaging
    // defaults to console. Env (DEV_AUTH_ENABLED, MESSAGING_RECORD_OUTBOX, etc.)
    // is baked into the launcher.
    command: 'node scripts/e2e-session.mjs',
    cwd: repoRoot,
    // Readiness gate: the launcher only logs 'ready' after db:start/create/seed
    // + app health; probe the new dashboard the specs hit.
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
