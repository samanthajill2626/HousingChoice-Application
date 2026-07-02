// DynamoDB Local container lifecycle (the ONLY local container — arch doc §8.1).
//
//   npm run db:start  -> ensure the container exists + is running, wait for port
//   npm run db:stop   -> stop it (container is kept; db:start restarts it)
//
// The container runs -inMemory: ALL DATA RESETS when the container stops or
// restarts — re-run `npm run db:create && npm run db:seed` (or `npm run dev`,
// which does both) after any restart.
//
// NO -sharedDb: each (accessKeyId, region) pair gets its OWN database and its
// own SQLite write lock, so concurrent suites don't serialize through one lock
// (docs/issues/dynamodb-local-cross-worktree-test-contention.md). The e2e
// launcher injects hclane<L> per lane, app vitest injects hctest<hash> per
// worktree, and the dev loop rides the 'local' fallback in app/src/lib/dynamo.ts.
//
// Also imported by scripts/dev.mjs (ensureDbStarted).
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CONTAINER_NAME = 'hc-dynamodb-local';
export const LOCAL_ENDPOINT = 'http://localhost:8000';

async function docker(...args) {
  // docker.exe resolves via PATH on Windows without a shell.
  return execFileAsync('docker', args);
}

async function assertDaemonUp() {
  try {
    await docker('version', '--format', '{{.Server.Version}}');
  } catch {
    console.error(
      'Docker daemon is not reachable. Start Docker Desktop, wait for "Engine running", then retry.',
    );
    process.exit(1);
  }
}

/** 'running' | 'stopped' | 'absent' */
async function containerState() {
  try {
    const { stdout } = await docker('inspect', '--format', '{{.State.Running}}', CONTAINER_NAME);
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

async function waitForEndpoint(endpoint, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // DynamoDB Local answers any HTTP request (400 for a bare GET) once up.
      await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`DynamoDB Local did not answer at ${endpoint} within ${timeoutMs}ms`);
}

/**
 * True when an existing container was created with the legacy -sharedDb flag
 * (one SQLite database + ONE write lock shared by every lane — the structural
 * contention fixed by per-lane access keys; see
 * docs/issues/dynamodb-local-cross-worktree-test-contention.md). Such a
 * container must be recreated: docker start would resurrect the old args.
 * @param {string[]} args
 */
export function containerArgsAreStale(args) {
  return args.includes('-sharedDb');
}

/** JVM args the container was created with (docker inspect .Args). */
async function containerArgs() {
  const { stdout } = await docker('inspect', '--format', '{{json .Args}}', CONTAINER_NAME);
  return JSON.parse(stdout.trim());
}

/** Idempotent start: running -> no-op; stopped -> start; absent -> run.
 *  A legacy -sharedDb container is removed + recreated (WIPES its in-memory
 *  tables — every lane/dev stack must reseed; sequenced in the rollout note of
 *  docs/superpowers/plans/2026-07-02-dynamodb-lane-keys.md). */
export async function ensureDbStarted() {
  await assertDaemonUp();
  let state = await containerState();
  if (state !== 'absent' && containerArgsAreStale(await containerArgs())) {
    console.warn(
      `db:start — ${CONTAINER_NAME} was created with the legacy -sharedDb flag; ` +
        'recreating it WITHOUT -sharedDb (per-access-key databases). ' +
        'ALL in-memory tables are wiped — every lane/dev stack must reseed.',
    );
    await docker('rm', '-f', CONTAINER_NAME);
    state = 'absent';
  }
  if (state === 'running') {
    console.log(`db:start — ${CONTAINER_NAME} already running`);
  } else if (state === 'stopped') {
    console.log(`db:start — starting existing container ${CONTAINER_NAME}`);
    await docker('start', CONTAINER_NAME);
  } else {
    console.log(`db:start — creating container ${CONTAINER_NAME} (in-memory; data resets on stop)`);
    await docker(
      'run', '-d', '--name', CONTAINER_NAME, '-p', '8000:8000',
      'amazon/dynamodb-local', '-jar', 'DynamoDBLocal.jar', '-inMemory',
    );
  }
  await waitForEndpoint(LOCAL_ENDPOINT);
  console.log(`db:start — DynamoDB Local ready at ${LOCAL_ENDPOINT}`);
}

export async function stopDb() {
  await assertDaemonUp();
  const state = await containerState();
  if (state !== 'running') {
    console.log(`db:stop — ${CONTAINER_NAME} is not running (${state})`);
    return;
  }
  await docker('stop', CONTAINER_NAME);
  console.log(`db:stop — ${CONTAINER_NAME} stopped (in-memory data discarded)`);
}

// CLI dispatch (node scripts/db.mjs start|stop) — skipped when imported.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const command = process.argv[2];
  if (command === 'start') {
    await ensureDbStarted();
  } else if (command === 'stop') {
    await stopDb();
  } else {
    console.error(`Usage: node scripts/db.mjs <start|stop> (got: ${command ?? 'nothing'})`);
    process.exit(1);
  }
}
