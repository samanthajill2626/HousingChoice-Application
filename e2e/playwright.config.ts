import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The hermetic dev loop lives at the repo root, one level up from e2e/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Lane resolution — synchronous, happens at config load before webServer boots.
// ---------------------------------------------------------------------------
// We use execSync so the async resolveLane() can run inside a synchronous
// defineConfig() call. The resolved lane is passed to e2e-session.mjs via
// E2E_LANE so the session NEVER re-probes and can't disagree with this config.
const laneMjs = path.join(repoRoot, 'e2e', 'support', 'lane.mjs');
const laneJson = JSON.parse(execFileSync(process.execPath, [laneMjs], { encoding: 'utf8' }).trim()) as {
  lane: number;
  ports: { app: number; dashboard: number; fake: number; publicBase: number };
  tablePrefix: string;
  mediaBucket: string;
  accessKeyId: string;
};

// Expose resolved URLs to test workers (fixtures in Task 3 read these).
// 127.0.0.1 everywhere — NEVER bare 'localhost' (IPv6 vs IPv4 mismatch).
const resolvedAppUrl = `http://127.0.0.1:${laneJson.ports.app}`;
const resolvedDashboardUrl = `http://127.0.0.1:${laneJson.ports.dashboard}`;
const resolvedFakeUrl = `http://127.0.0.1:${laneJson.ports.fake}`;
const resolvedPublicBaseUrl = `http://127.0.0.1:${laneJson.ports.publicBase}`;

process.env['E2E_LANE'] = String(laneJson.lane);
process.env['E2E_APP_URL'] = resolvedAppUrl;
process.env['E2E_DASHBOARD_URL'] = resolvedDashboardUrl;
process.env['E2E_FAKE_URL'] = resolvedFakeUrl;
process.env['PUBLIC_BASE_URL'] = resolvedPublicBaseUrl;
process.env['FAKE_TWILIO_URL'] = resolvedFakeUrl;

// Absolute path for the HTML report, so the "npx playwright show-report <path>"
// line Playwright prints at the end of a run is copy-pasteable from ANY directory
// (a relative outputFolder only resolves from inside e2e/, not the repo root).
const htmlReportDir = fileURLToPath(new URL('.artifacts/html-report', import.meta.url));

// Opt-in slow motion for WATCHING a --headed run (E2E_SLOWMO ms per browser
// action). Because every action is delayed, an action-heavy scenario blows past
// the default 30s per-test timeout — so scale the timeout up WITH the slow-motion
// (a generous per-action budget); a genuine hang still eventually fails. 0 = off.
const slowMo = Number(process.env.E2E_SLOWMO ?? 0);

export default defineConfig({
  testDir: './tests',
  outputDir: '.artifacts/test-results',
  // Default 30s; when slow-motion is on, give each delayed action headroom.
  timeout: slowMo > 0 ? 30_000 + slowMo * 150 : 30_000,
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
    ['html', { outputFolder: htmlReportDir, open: 'never' }],
    ['json', { outputFile: '.artifacts/results.json' }],
  ],
  use: {
    // The dashboard on the resolved lane port. Specs hit the dashboard, the
    // fake-phones host, or the backend API directly via resolved env vars.
    // 127.0.0.1 everywhere — never bare localhost (IPv6/IPv4 mismatch risk).
    baseURL: resolvedDashboardUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    navigationTimeout: 15_000,
    // Opt-in slow motion for watching a --headed run: each browser action is
    // delayed by E2E_SLOWMO milliseconds. Default 0 = no delay, so CI and normal
    // runs are unaffected (the per-test timeout above scales with it). e.g.:
    //   E2E_SLOWMO=800 npm run e2e -w @housingchoice/e2e -- <spec> --headed
    launchOptions: { slowMo },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Boots DynamoDB Local + app + worker + Vite + fake-twilio on the resolved
    // lane ports. E2E_LANE is injected so the session OBEYS this config's choice
    // and never re-probes — config and session always agree. The resolved URLs are
    // also forwarded so the session can skip re-derivation.
    // 127.0.0.1 everywhere — never bare localhost.
    command: `node scripts/e2e-session.mjs`,
    env: {
      E2E_LANE: String(laneJson.lane),
    },
    cwd: repoRoot,
    // Readiness gate: the launcher only logs 'ready' after db:start/create/seed
    // + app health; probe the dashboard port the specs hit.
    url: resolvedDashboardUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
