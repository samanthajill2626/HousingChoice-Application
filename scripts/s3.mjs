// MinIO (local S3-compatible) container lifecycle — the storage sibling of
// scripts/db.mjs (DynamoDB Local). Mirrors that pattern exactly.
//
//   npm run s3:start  -> ensure the container exists + is running, wait for health
//   npm run s3:stop   -> stop it (container is kept; s3:start restarts it)
//
// The container has no volume mount: its /data is EPHEMERAL — removing the
// container (docker rm) discards mirrored media. Stop/start preserves it. Used
// only by --local dev and the e2e harness; production uses real AWS S3.
//
// Also imported by scripts/dev.mjs and scripts/e2e-session.mjs (ensureS3Started).
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const CONTAINER_NAME = 'hc-s3-local';
export const LOCAL_S3_ENDPOINT = 'http://localhost:9000';
// Dev-only, not secret. Must match LOCAL_S3_ACCESS_KEY/SECRET in
// app/src/adapters/mediaStore.ts (MinIO validates credentials).
export const MINIO_ROOT_USER = 'local';
export const MINIO_ROOT_PASSWORD = 'locallocal';

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

async function waitForHealthy(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `${LOCAL_S3_ENDPOINT}/minio/health/live`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`MinIO did not become healthy at ${url} within ${timeoutMs}ms`);
}

/** Idempotent start: running -> no-op; stopped -> start; absent -> run. */
export async function ensureS3Started() {
  await assertDaemonUp();
  const state = await containerState();
  if (state === 'running') {
    console.log(`s3:start — ${CONTAINER_NAME} already running`);
  } else if (state === 'stopped') {
    console.log(`s3:start — starting existing container ${CONTAINER_NAME}`);
    await docker('start', CONTAINER_NAME);
  } else {
    console.log(`s3:start — creating container ${CONTAINER_NAME} (ephemeral; data lost on docker rm)`);
    await docker(
      'run', '-d', '--name', CONTAINER_NAME,
      '-p', '9000:9000', '-p', '9001:9001',
      '-e', `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
      '-e', `MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}`,
      'minio/minio', 'server', '/data', '--console-address', ':9001',
    );
  }
  await waitForHealthy();
  console.log(`s3:start — MinIO ready at ${LOCAL_S3_ENDPOINT} (console :9001)`);
}

export async function stopS3() {
  await assertDaemonUp();
  const state = await containerState();
  if (state !== 'running') {
    console.log(`s3:stop — ${CONTAINER_NAME} is not running (${state})`);
    return;
  }
  await docker('stop', CONTAINER_NAME);
  console.log(`s3:stop — ${CONTAINER_NAME} stopped`);
}

// CLI dispatch (node scripts/s3.mjs start|stop) — skipped when imported.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const command = process.argv[2];
  if (command === 'start') {
    await ensureS3Started();
  } else if (command === 'stop') {
    await stopS3();
  } else {
    console.error(`Usage: node scripts/s3.mjs <start|stop> (got: ${command ?? 'nothing'})`);
    process.exit(1);
  }
}
