import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// The hermetic dev loop lives at the repo root, one level up from e2e/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './tests',
  outputDir: '.artifacts/test-results',
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
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 15_000,
  },
  projects: [
    { name: 'setup', testDir: '.', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    // Boots DynamoDB Local + app(:8080) + worker + Vite(:5173) in hermetic
    // mode. No AWS creds or secrets needed; messaging defaults to console.
    // Env (DEV_AUTH_ENABLED, MESSAGING_RECORD_OUTBOX, etc.) is baked into the
    // launcher — no env block needed here.
    command: 'node scripts/e2e-session.mjs',
    cwd: repoRoot,
    // Readiness gate: the Vite server is the surface the spec hits, and the
    // launcher only logs 'ready' after db:start/create/seed + app health.
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
