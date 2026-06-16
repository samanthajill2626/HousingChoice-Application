// Unified non-watch launcher for the e2e stack — used by BOTH `npm run e2e`
// (Playwright webServer) and `npm run e2e:session` (the agent's persistent
// inner-loop stack). Spawns app, worker, and Vite as individual `node`
// processes, bakes in the hermetic test env, ensures DynamoDB Local + tables +
// seed once, waits for app health, and restarts ONLY app+worker when the
// restart sentinel changes (Vite, the DB, and any attached browser keep running
// / keep their place). Teardown is verified on Windows (taskkill /T); the POSIX
// path kills each tracked child directly — full Linux/CI teardown is validated
// separately when CI is set up.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, watchFile, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';
import { ensureS3Started, LOCAL_S3_ENDPOINT } from './s3.mjs';
import { killTree, isAlive, killPort } from './lib/killTree.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dashboardDir = path.join(repoRoot, 'dashboard');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
// The fake-phones UI is a static build served by the fake-twilio host on :8889.
// We build it once at session start (below) and point the host at its dist.
const fakeUiDistDir = path.join(repoRoot, 'fake-twilio', 'web', 'dist');
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const sentinel = path.join(artifactsDir, '.restart');
const pidFile = path.join(artifactsDir, 'session.pid');

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? 'true',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,
  TABLE_PREFIX: process.env.TABLE_PREFIX ?? 'hc-local-',
  // Local S3 (MinIO) so inbound MMS media mirrors + serves back to the dashboard.
  MEDIA_BUCKET: process.env.MEDIA_BUCKET ?? 'hc-local-media',
  MEDIA_S3_ENDPOINT: process.env.MEDIA_S3_ENDPOINT ?? LOCAL_S3_ENDPOINT,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
  DEV_AUTH_ENABLED: '1',
  MESSAGING_RECORD_OUTBOX: '1',
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
  TWILIO_API_BASE_URL: 'http://localhost:8889',
  OUR_PHONE_NUMBERS: '+15550009999',
  // Founder call-triage dial-through target: a fake E.164 so an inbound call to
  // the business number runs the FULL founder bridge through the fake (whisper →
  // press-1 → answer → record → transcribe) instead of degrading to the "text us"
  // fallback. Never a real cell. Externally-provided value wins for a real run.
  FOUNDER_CELL: process.env.FOUNDER_CELL ?? '+15550000001',
  // A2P kill-switch defaults OFF when MESSAGING_DRIVER=twilio (config.ts), which
  // makes sendMessage throw before anything reaches the fake — force it ON so the
  // hermetic stack actually exercises outbound sends against the fake host.
  SMS_SENDING_ENABLED: 'true',
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
function startVite() {
  // Run Vite's bin directly so it's a single node process we can kill cleanly.
  spawnNode('web', [viteBin], dashboardDir);
}
function startFakeTwilio() {
  // The fake-twilio host impersonates Twilio's REST API (the app's redirected
  // driver POSTs sends here) and fires correctly-signed webhooks BACK at the app.
  // Two URLs, deliberately split: it POSTs webhooks to APP_BASE_URL (:8080, the
  // app's real address) but SIGNS them against APP_PUBLIC_BASE_URL (the app's
  // PUBLIC_BASE_URL, :5173) — because the app's signature middleware reconstructs
  // the signed URL as `${PUBLIC_BASE_URL}${req.originalUrl}`. CF_ORIGIN_SECRET is
  // inherited from childEnv so the dispatcher's x-origin-verify header satisfies
  // the app's origin-secret validator (which gates /webhooks/* too).
  //
  // PREFLIGHT — reap any orphan still holding :8889. On Windows a second
  // `app.listen()` on an already-bound port does NOT raise EADDRINUSE: the listen
  // callback fires, the process exits 0 without ever owning the socket, and the
  // launcher would then track that throwaway child while an untracked orphan keeps
  // the port — un-killable by killChild/shutdown/e2e:stop. Freeing the port first
  // guarantees the child we spawn below is the real :8889 owner and a tracked
  // descendant of this launcher (so tree-kill teardown covers it).
  const reaped = killPort(8889);
  if (reaped.length) log(`reaped orphan(s) holding :8889 before start: ${reaped.join(', ')}`);
  spawnNode('fake-twilio', ['--import', 'tsx', path.join('fake-twilio', 'src', 'index.ts')], undefined, {
    FAKE_TWILIO_PORT: '8889',
    APP_BASE_URL: 'http://localhost:8080',
    APP_PUBLIC_BASE_URL: childEnv.PUBLIC_BASE_URL,
    // Serve the pre-built fake-phones UI (built once in main() before first start).
    // On a restartBackend() bounce the existing dist is reused — the UI rarely
    // changes, so we don't rebuild it.
    FAKE_TWILIO_UI_DIST: fakeUiDistDir,
  });
}

async function buildFakeUi() {
  // Build the standalone fake-phones React/Vite app once so the host can serve it
  // as a static bundle on :8889. Vite caches between runs, so this is cheap after
  // the first build. Must finish BEFORE startFakeTwilio() so dist/ exists.
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

async function waitForHealth(url = 'http://localhost:8080/health', timeoutMs = 60_000) {
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
    await waitForHealth('http://localhost:8889/health');
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
  log('starting fake-twilio (:8889)…');
  startFakeTwilio();
  await waitForHealth('http://localhost:8889/health');
  log('fake-twilio ready (:8889)');
  log('fake-phones UI → http://localhost:8889/');

  log('starting app, worker, web (non-watch)…');
  startApp();
  startWorker();
  startVite();

  await waitForHealth();
  log('ready — app :8080, web :5173, fake-twilio :8889, MinIO :9000 (MESSAGING_DRIVER=twilio → fake)');

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
