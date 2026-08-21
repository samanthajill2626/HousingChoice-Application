import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { holdsLane } from './support/laneLease.mjs';

// The hermetic dev loop lives at the repo root, one level up from e2e/.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Reuse a LIVE e2e:session's lane instead of free-probing a second one.
// ---------------------------------------------------------------------------
// The documented inner loop is `npm run e2e:session` + a filtered
// `npx playwright test <file>`. Those did not compose: this config resolved its
// OWN lane, landed one lane over, and booted a SECOND full stack while a warm
// session sat idle - ~40-60s of boot per filtered run, and an agent watching
// the session's log saw no traffic and concluded the run was wedged.
//
// e2e/.artifacts/lane.json is per-worktree, which is exactly right here: we are
// asking "is THIS worktree running a session?", not arbitrating between
// worktrees. Both proofs are required - a live launcher pid AND a lease that
// still matches - so a crashed session's stale lane.json cannot capture a run.
// See docs/issues/e2e-session-lane-mismatch.md.
function liveSessionLane(): { lane: number; ownerToken: string | null } | null {
  try {
    const state = JSON.parse(
      readFileSync(path.join(repoRoot, 'e2e', '.artifacts', 'lane.json'), 'utf8'),
    ) as { lane?: number; launcherPid?: number; ownerToken?: string | null };
    if (!Number.isInteger(state.lane) || !Number.isInteger(state.launcherPid)) return null;
    try {
      process.kill(state.launcherPid!, 0); // throws ESRCH when the launcher is gone
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    if (typeof state.ownerToken !== 'string' || !holdsLane(state.lane!, state.ownerToken)) return null;
    return { lane: state.lane!, ownerToken: state.ownerToken };
  } catch {
    return null;
  }
}

const reusable = process.env['E2E_LANE'] ? null : liveSessionLane();
if (reusable !== null) {
  process.env['E2E_LANE'] = String(reusable.lane);
  process.env['E2E_LANE_TOKEN'] = reusable.ownerToken ?? '';
  process.stdout.write(
    `[playwright] reusing the live e2e:session on lane ${reusable.lane} (set E2E_LANE to override)\n`,
  );
}

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
  ownerToken: string | null;
  needsReap: boolean;
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
      // The lane lease this config RESERVED, handed to the session so it can
      // ADOPT rather than re-reserve. This process exits long before the suite
      // ends, so it can never be the lease holder itself - the session claims
      // it and becomes the owner. Without this the session would refuse its own
      // parent's lease and no `npm run e2e` would boot.
      ...(laneJson.ownerToken ? { E2E_LANE_TOKEN: laneJson.ownerToken } : {}),
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
