// Unified non-watch launcher for the e2e stack — used by BOTH `npm run e2e`
// (Playwright webServer) and `npm run e2e:session` (the agent's persistent
// inner-loop stack). Spawns app, worker, and Vite as individual `node`
// processes, bakes in the hermetic test env, ensures DynamoDB Local + tables +
// seed once, waits for app health, and restarts ONLY app+worker when the
// restart sentinel changes (Vite, the DB, and any attached browser keep running
// / keep their place). Teardown is verified on Windows (taskkill /T); the POSIX
// path kills each tracked child directly — full Linux/CI teardown is validated
// separately when CI is set up.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, watchFile, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';
import { ensureS3Started, LOCAL_S3_ENDPOINT } from './s3.mjs';
import { killTree, isAlive, killPort } from './lib/killTree.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// The entity-centric dashboard the e2e specs drive.
const dashboardNextDir = path.join(repoRoot, 'dashboard');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
// The fake-phones UI is a static build served by the fake-twilio host.
// We build it once at session start (below) and point the host at its dist.
const fakeUiDistDir = path.join(repoRoot, 'fake-twilio', 'web', 'dist');
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const sentinel = path.join(artifactsDir, '.restart');
const pidFile = path.join(artifactsDir, 'session.pid');
const laneFile = path.join(artifactsDir, 'lane.json');

// ---------------------------------------------------------------------------
// Lane resolution — OBEY E2E_LANE if set (Playwright path), else free-probe.
// ---------------------------------------------------------------------------
// When Playwright spawns this script it injects E2E_LANE (the lane it resolved
// at config load). We call resolveLane() which respects E2E_LANE via its own
// env-override branch, so config and session always agree without re-probing.
// When run directly (npm run e2e:session), E2E_LANE is unset and resolveLane()
// hashes the worktree identity + free-probes to pick an available lane.
const laneMjs = path.join(repoRoot, 'e2e', 'support', 'lane.mjs');
const laneJson = JSON.parse(
  execFileSync(process.execPath, [laneMjs], { encoding: 'utf8' }).trim(),
);
const { lane, ports, tablePrefix, mediaBucket, accessKeyId } = laneJson;

// Derive all per-lane URLs. 127.0.0.1 everywhere — NEVER bare 'localhost'
// (Vite/localhost can resolve to IPv6 ::1 while the free-probe + other services
// use IPv4, causing false "port free" probes and ERR_CONNECTION_REFUSED).
const appUrl = `http://127.0.0.1:${ports.app}`;
const dashboardUrl = `http://127.0.0.1:${ports.dashboard}`;
const fakeUrl = `http://127.0.0.1:${ports.fake}`;
// publicBase is the URL the fake HMAC-signs against and the app reconstructs
// for Twilio signature verification. Must match on both sides.
const publicBaseUrl = `http://127.0.0.1:${ports.publicBase}`;

// Write the per-worktree state file so Task 3 fixtures + e2e-reseed/stop can
// read the resolved lane without re-probing. Written early (before children
// start) so any crash still leaves a readable file.
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(
  laneFile,
  JSON.stringify(
    {
      lane,
      ports,
      urls: { app: appUrl, dashboard: dashboardUrl, fake: fakeUrl, publicBase: publicBaseUrl },
      tablePrefix,
      mediaBucket,
      accessKeyId,
    },
    null,
    2,
  ),
);

// The current checkout's commit, stamped into BOTH the app and the dashboard at
// launch so the e2e preflight (e2e/support/preflight.ts) can detect a STALE
// reused stack — a long-lived session serving old code, especially a Vite that
// wasn't restarted after a backend change. Best-effort: if git is unavailable
// the stamp is empty and the preflight simply skips its freshness check.
let gitSha = '';
try {
  gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim();
} catch {
  /* no git / detached HEAD — the preflight freshness check is then skipped */
}

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? 'true',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,
  TABLE_PREFIX: tablePrefix,
  // Per-lane DynamoDB Local DATABASE (not just table prefix): without
  // -sharedDb the store is keyed by (accessKeyId, region), so this key is
  // what gives the lane its own SQLite write lock — see
  // docs/issues/dynamodb-local-cross-worktree-test-contention.md.
  // FORCED, no ?? fallback: an ambient shell AWS_ACCESS_KEY_ID would silently
  // merge every lane back into ONE database. Safe to force — the hermetic
  // stack never touches real AWS (MinIO clients pin their own fixed creds,
  // and DynamoDB Local ignores the secret's value). AWS_REGION is pinned
  // because the region is part of the store identity: a drifting region
  // would silently point the same key at a different, empty database.
  AWS_ACCESS_KEY_ID: accessKeyId,
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'us-east-1',
  // Local S3 (MinIO) so inbound MMS media mirrors + serves back to the dashboard.
  MEDIA_BUCKET: mediaBucket,
  MEDIA_S3_ENDPOINT: process.env.MEDIA_S3_ENDPOINT ?? LOCAL_S3_ENDPOINT,
  PUBLIC_BASE_URL: publicBaseUrl,
  DEV_AUTH_ENABLED: '1',
  MESSAGING_RECORD_OUTBOX: '1',
  // The public surface ships a strict per-IP abuse fence (default 5 req / 60s)
  // on its unauthenticated, SMS-spending routes. That's correct for prod, but a
  // single e2e run legitimately drives /public/* far more often than that from
  // ONE IP (every flyer teaser load + housing-fair POST + details reveal across
  // the public-pages, outbox, settings, and tenant-onboarding specs share the
  // window) — so the default trips and 429s cascade into "no longer available"
  // funnels + missing welcomes. Raise the ceiling for the hermetic suite ONLY
  // (this never touches a deployed env); an externally-set value still wins.
  PUBLIC_RATE_LIMIT_MAX: process.env.PUBLIC_RATE_LIMIT_MAX ?? '100000',
  // --- fake-twilio (HTTP-seam messaging mock) ---
  // The app runs the REAL Twilio driver (MESSAGING_DRIVER=twilio) but is pointed
  // at the in-process fake host via TWILIO_API_BASE_URL, so the production
  // messaging code path + the twilioSignature middleware run unchanged against a
  // local impersonator instead of console-faking the send. The SID/secret values
  // are Twilio-SHAPED dummies (the fake never authenticates them); the shared
  // TWILIO_AUTH_TOKEN is the HMAC key BOTH sides use — the fake signs inbound
  // webhooks with it and the app's signature middleware verifies them.
  MESSAGING_DRIVER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACfake000000000000000000000000000',
  TWILIO_API_KEY_SID: 'SKfake000000000000000000000000000',
  TWILIO_API_KEY_SECRET: 'fake-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGfake000000000000000000000000000',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? 'hermetic-shared-twilio-token',
  TWILIO_API_BASE_URL: fakeUrl,
  OUR_PHONE_NUMBERS: '+15550009999',
  // NOTE: inbound call-triage dials the seeded inbound-voice-line HOLDER's verified
  // cell. The local seed (devReset → seedInboundVoiceLineHolder) uses the hardcoded
  // SEED_INBOUND_VOICE_CELL fake, so nothing is injected here (the deprecated
  // FOUNDER_CELL env var was removed).
  // A2P kill-switch defaults OFF when MESSAGING_DRIVER=twilio (config.ts), which
  // makes sendMessage throw before anything reaches the fake — force it ON so the
  // hermetic stack actually exercises outbound sends against the fake host.
  SMS_SENDING_ENABLED: 'true',
  // Stale-stack guard (e2e/support/preflight.ts): stamp the launch commit on the
  // app (/__dev/ping → appCommit) AND the dashboard (index.html <meta>) so a
  // reused server booted at a different commit is caught with an actionable error.
  E2E_APP_COMMIT: gitSha,
  VITE_E2E_COMMIT: gitSha,
  // Pass the app port so the app process knows which port to bind.
  PORT: String(ports.app),
  // Pass the lane to child processes so they can self-identify if needed.
  E2E_LANE: String(lane),
};

const children = new Map(); // name -> ChildProcess
let shuttingDown = false;
let restarting = false;
let parentWatchInterval = null;

function log(msg) {
  process.stdout.write(`[e2e-session] ${msg}\n`);
}

function spawnNode(name, args, cwd = repoRoot, envOverride = undefined) {
  const env = envOverride ? { ...childEnv, ...envOverride } : childEnv;
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) log(`${name} exited (code=${code} signal=${signal})`);
  });
  child.on('error', (err) => {
    log(`${name} failed to spawn: ${String(err)}`);
    if (!shuttingDown) shutdown(1);
  });
  children.set(name, child);
  return child;
}

function startApp() {
  spawnNode('app', ['--import', 'tsx', path.join('app', 'src', 'index.ts')]);
}
function startWorker() {
  spawnNode('worker', ['--import', 'tsx', path.join('app', 'src', 'worker.ts')]);
}
function startViteNext() {
  // PREFLIGHT — reap any orphan holding the dashboard port before spawning Vite.
  // It pins `strictPort: true` (dashboard/vite.config.ts), so a held port makes
  // Vite exit non-zero instead of drifting to another port — which here lands in
  // `child.on('exit')` (logged, not a shutdown), so `web-next` silently vanishes
  // and Playwright's webServer polls a stale server or times out. Freeing the
  // port first guarantees the child we spawn owns it.
  const reaped = killPort(ports.dashboard);
  if (reaped.length) log(`reaped orphan(s) holding :${ports.dashboard} before start: ${reaped.join(', ')}`);
  // DASHBOARD_PORT (not the generic PORT — that's the APP's variable, and a
  // shared env would leak it into Vite: the 2026-07-02 `npm run dev` regression
  // where Vite bound the app's 8080). vite.config.ts reads DASHBOARD_PORT.
  spawnNode('web-next', [viteBin], dashboardNextDir, {
    DASHBOARD_PORT: String(ports.dashboard),
    APP_PORT: String(ports.app),
  });
}
function startFakeTwilio() {
  // The fake-twilio host impersonates Twilio's REST API (the app's redirected
  // driver POSTs sends here) and fires correctly-signed webhooks BACK at the app.
  // Two URLs, deliberately split: it POSTs webhooks to APP_BASE_URL (the app's
  // real address) but SIGNS them against APP_PUBLIC_BASE_URL (the app's
  // PUBLIC_BASE_URL) — because the app's signature middleware reconstructs
  // the signed URL as `${PUBLIC_BASE_URL}${req.originalUrl}`. CF_ORIGIN_SECRET is
  // inherited from childEnv so the dispatcher's x-origin-verify header satisfies
  // the app's origin-secret validator (which gates /webhooks/* too).
  //
  // PREFLIGHT — reap any orphan still holding the fake port. On Windows a second
  // `app.listen()` on an already-bound port does NOT raise EADDRINUSE: the listen
  // callback fires, the process exits 0 without ever owning the socket, and the
  // launcher would then track that throwaway child while an untracked orphan keeps
  // the port — un-killable by killChild/shutdown/e2e:stop. Freeing the port first
  // guarantees the child we spawn below is the real owner and a tracked
  // descendant of this launcher (so tree-kill teardown covers it).
  const reaped = killPort(ports.fake);
  if (reaped.length) log(`reaped orphan(s) holding :${ports.fake} before start: ${reaped.join(', ')}`);
  spawnNode('fake-twilio', ['--import', 'tsx', path.join('fake-twilio', 'src', 'index.ts')], undefined, {
    FAKE_TWILIO_PORT: String(ports.fake),
    APP_BASE_URL: appUrl,
    APP_PUBLIC_BASE_URL: publicBaseUrl,
    // The base the fake mints RecordingUrl/MediaUrl from (recordingServeBase in
    // callEngine). The app fetches recordings from the fake at TWILIO_API_BASE_URL
    // (= fakeUrl) and its media-SSRF allowlist accepts ONLY that exact origin. The
    // fake otherwise defaults this to http://localhost:<port>, whose origin differs
    // from the lane's 127.0.0.1 fakeUrl → MediaFetchRefusedError 'host_not_allowed'
    // (recording never mirrors). Pin it to fakeUrl so the origins match. 127.0.0.1
    // everywhere — do NOT use localhost (the deliberate IPv4-consistency choice).
    FAKE_TWILIO_PUBLIC_URL: fakeUrl,
    // Serve the pre-built fake-phones UI (built once in main() before first start).
    // On a restartBackend() bounce the existing dist is reused — the UI rarely
    // changes, so we don't rebuild it.
    FAKE_TWILIO_UI_DIST: fakeUiDistDir,
  });
}

async function buildFakeUi() {
  // Build the standalone fake-phones React/Vite app once so the host can serve it
  // as a static bundle on the fake port. Vite caches between runs, so this is
  // cheap after the first build. Must finish BEFORE startFakeTwilio() so dist/ exists.
  const started = Date.now();
  log('building fake-phones UI (npm run build -w @housingchoice/fake-twilio-web)…');
  // npm-cli.js ships alongside the node binary (…/node_modules/npm/bin/npm-cli.js),
  // so we run it through process.execPath rather than relying on a PATH lookup.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await runOnce('fake-ui-build', [npmCli, 'run', 'build', '-w', '@housingchoice/fake-twilio-web']);
  log(`fake-phones UI built in ${((Date.now() - started) / 1000).toFixed(1)}s → ${fakeUiDistDir}`);
}

function killChild(name) {
  const child = children.get(name);
  if (!child) return;
  killTree(child.pid);
  children.delete(name);
}

async function runOnce(name, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
    child.on('error', reject);
  });
}

async function waitForHealth(url = `${appUrl}/health`, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`health did not come up in time: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function cleanSlate() {
  // Reseed the backend so every session boots HERMETIC. The DynamoDB container is
  // REUSED across boots for speed and `db-seed` only idempotently re-PutItems fixed-ID
  // rows — it never CLEARS — so dynamically-created rows (contacts, messages, and the
  // `sid#<providerSid>` inbound-dedup pointers) accumulate across boots forever.
  // /__dev/reseed clears + re-seeds, wiping those stale pointers. (Together with
  // fake-twilio's now-randomized SID base this keeps interactive `e2e:session` driving
  // clean and collision-free. `npm run e2e` ALSO reseeds in globalSetup — the extra
  // reseed there is a cheap, harmless no-op.)
  const res = await fetch(`${appUrl}/__dev/reseed`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`clean-slate reseed failed (HTTP ${res.status}) at ${appUrl}/__dev/reseed`);
  }
  // Best-effort: also clear the fake's threads + any in-flight status-callback timers.
  await fetch(`${fakeUrl}/control/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {
    /* the fake may be momentarily unavailable — never fail boot over its reset */
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatchInterval !== null) {
    clearInterval(parentWatchInterval);
    parentWatchInterval = null;
  }
  log('shutting down — stopping app, worker, web, fake-twilio (DynamoDB + MinIO containers left running)');
  for (const name of [...children.keys()]) killChild(name);
  try { rmSync(pidFile, { force: true }); } catch { /* best-effort */ }
  setTimeout(() => process.exit(code), 500);
}

async function restartBackend() {
  if (restarting) {
    log('restart already in progress — ignoring this trigger');
    return;
  }
  restarting = true;
  try {
    log('restart sentinel changed — restarting app + worker + fake-twilio (Vite/DB untouched)');
    killChild('app');
    killChild('worker');
    // Also bounce fake-twilio so a code change to it is picked up on restart.
    killChild('fake-twilio');
    await new Promise((r) => setTimeout(r, 200));
    startFakeTwilio();
    await waitForHealth(`${fakeUrl}/health`);
    startApp();
    startWorker();
    await waitForHealth();
    log('app + worker + fake-twilio back up');
  } catch (err) {
    log(`restart health check failed: ${String(err)}`);
  } finally {
    restarting = false;
  }
}

async function main() {
  const parentPid = process.ppid;

  mkdirSync(artifactsDir, { recursive: true });

  // SELF-HEAL: if a stale session.pid exists, kill that launcher tree first.
  if (existsSync(pidFile)) {
    const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid && isAlive(oldPid)) {
      log(`reaping stale session launcher (pid=${oldPid})…`);
      killTree(oldPid);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  writeFileSync(pidFile, String(process.pid));

  if (!existsSync(sentinel)) writeFileSync(sentinel, '0');

  // Log the resolved lane so the MCP browser (and humans) can see which ports
  // are in use — critical for debugging and for the MCP to navigate the right URL.
  log(`resolved lane ${lane}: app=${appUrl} dashboard=${dashboardUrl} fake=${fakeUrl} publicBase=${publicBaseUrl}`);
  log(`tablePrefix=${tablePrefix} mediaBucket=${mediaBucket} accessKeyId=${accessKeyId}`);

  log('ensuring DynamoDB Local…');
  await ensureDbStarted();
  log('ensuring MinIO local S3…');
  await ensureS3Started();
  log('creating tables + media bucket + seeding…');
  await runOnce('db-create', ['--import', 'tsx', path.join('app', 'scripts', 'db-create.ts')]);
  await runOnce('s3-create', ['--import', 'tsx', path.join('app', 'scripts', 's3-create.ts')]);
  await runOnce('db-seed', ['--import', 'tsx', path.join('app', 'scripts', 'db-seed.ts')]);

  // Build the fake-phones UI BEFORE starting the host, so its dist/ exists when
  // the host wires up static serving (FAKE_TWILIO_UI_DIST).
  await buildFakeUi();

  // Start fake-twilio FIRST so the app's very first outbound send has a host to
  // reach (the app only calls it on send, but this avoids a race on boot).
  log(`starting fake-twilio (:${ports.fake})…`);
  startFakeTwilio();
  await waitForHealth(`${fakeUrl}/health`);
  log(`fake-twilio ready (:${ports.fake})`);
  log(`fake-phones UI → ${fakeUrl}/`);

  log(`starting app, worker, web :${ports.dashboard} (non-watch)…`);
  startApp();
  startWorker();
  startViteNext();

  await waitForHealth();

  // Clean slate: clear any rows accumulated in the reused DynamoDB container (incl.
  // stale fake-SID dedup pointers) so this session starts hermetic. See cleanSlate().
  log('clean-slate reseed (hermetic session start)…');
  await cleanSlate();

  log(`ready — app :${ports.app} (${appUrl}), web :${ports.dashboard} (${dashboardUrl}), fake-twilio :${ports.fake} (${fakeUrl}), MinIO :9000 (MESSAGING_DRIVER=twilio → fake)`);

  // PARENT-DEATH WATCH: if the parent process (the task shell or Playwright) dies,
  // shut down automatically. This fires only when the parent is genuinely gone —
  // during Playwright suite runs, Playwright stays alive, so the interval is dormant.
  parentWatchInterval = setInterval(() => {
    if (!isAlive(parentPid)) {
      log('parent process exited — shutting down session');
      shutdown(0);
    }
  }, 1000);

  // Restart only app+worker when the sentinel file is rewritten.
  watchFile(sentinel, { interval: 300 }, () => {
    void restartBackend();
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => {
    for (const name of [...children.keys()]) killChild(name);
  });
}

main().catch((err) => {
  log(`fatal: ${String(err)}`);
  shutdown(1);
});
