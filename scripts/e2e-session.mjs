// Unified non-watch launcher for the e2e stack — used by BOTH `npm run e2e`
// (Playwright webServer) and `npm run e2e:session` (the agent's persistent
// inner-loop stack). Spawns app, worker, and Vite as individual `node`
// processes (clean single-process kill on any OS — no process tree), bakes in
// the hermetic test env, ensures DynamoDB Local + tables + seed once, waits for
// app health, and restarts ONLY app+worker when the restart sentinel changes
// (Vite, the DB, and any attached browser keep running / keep their place).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, watchFile } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dashboardDir = path.join(repoRoot, 'dashboard');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const sentinel = path.join(artifactsDir, '.restart');

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? 'true',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,
  TABLE_PREFIX: process.env.TABLE_PREFIX ?? 'hc-local-',
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
  DEV_AUTH_ENABLED: '1',
  MESSAGING_RECORD_OUTBOX: '1',
};

const children = new Map(); // name -> ChildProcess
let shuttingDown = false;

function log(msg) {
  process.stdout.write(`[e2e-session] ${msg}\n`);
}

function spawnNode(name, args, cwd = repoRoot) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) log(`${name} exited (code=${code} signal=${signal})`);
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

function killChild(name) {
  const child = children.get(name);
  if (!child) return;
  child.kill('SIGTERM');
  children.delete(name);
}

async function runOnce(name, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
    child.on('error', reject);
  });
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch('http://localhost:8080/health');
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('app health did not come up in time');
    await new Promise((r) => setTimeout(r, 300));
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down — stopping app, worker, web (DynamoDB container left running)');
  for (const name of [...children.keys()]) killChild(name);
  setTimeout(() => process.exit(code), 500);
}

async function restartBackend() {
  log('restart sentinel changed — restarting app + worker (Vite/DB untouched)');
  killChild('app');
  killChild('worker');
  await new Promise((r) => setTimeout(r, 200));
  startApp();
  startWorker();
  try {
    await waitForHealth();
    log('app + worker back up');
  } catch (err) {
    log(`restart health check failed: ${String(err)}`);
  }
}

async function main() {
  mkdirSync(artifactsDir, { recursive: true });
  if (!existsSync(sentinel)) writeFileSync(sentinel, '0');

  log('ensuring DynamoDB Local…');
  await ensureDbStarted();
  log('creating tables + seeding…');
  await runOnce('db-create', ['--import', 'tsx', path.join('app', 'scripts', 'db-create.ts')]);
  await runOnce('db-seed', ['--import', 'tsx', path.join('app', 'scripts', 'db-seed.ts')]);

  log('starting app, worker, web (non-watch)…');
  startApp();
  startWorker();
  startVite();

  await waitForHealth();
  log('ready — app :8080, web :5173 (DEV_AUTH_ENABLED + MESSAGING_RECORD_OUTBOX on)');

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
