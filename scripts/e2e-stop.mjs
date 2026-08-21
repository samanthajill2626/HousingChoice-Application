// Stops a running `npm run e2e:session` stack reliably (kills the launcher and
// all its children). Use this instead of just killing the background task,
// which on Windows leaks the reparented node tree.
//
// Reads e2e/.artifacts/lane.json (written by e2e-session.mjs) to determine
// which lane's ports to kill. It verifies a live launcher or matching app owner
// before reaping ports, then removes only unchanged stale state files.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, killPort, isAlive } from './lib/killTree.mjs';
import { inspectSessionLiveness } from './lib/sessionState.mjs';
import { releaseLane } from '../e2e/support/laneLease.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const pidFile = path.join(artifactsDir, 'session.pid');
const laneFile = path.join(artifactsDir, 'lane.json');
const profilerMarkerFile = path.join(artifactsDir, 'performance-session.json');
function readText(pathName) {
  try { return readFileSync(pathName, 'utf8'); } catch { return null; }
}
const originalPidText = readText(pidFile);
const originalLaneText = readText(laneFile);

// Read lane.json to know which lane we're stopping.
let laneJson = null;
if (existsSync(laneFile)) {
  try {
    laneJson = JSON.parse(readFileSync(laneFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`[e2e-stop] warning: could not parse lane.json: ${String(err)}\n`);
  }
}

const hasPid = originalPidText !== null;
const liveness = laneJson === null
  ? { launcherAlive: false, ownerConfirmed: false, live: false }
  : await inspectSessionLiveness({ laneState: laneJson, pidText: originalPidText });

if (!liveness.live) {
  process.stdout.write('[e2e-stop] no running session found; retained state is stale or absent - nothing to stop\n');
  try {
    const pid = Number(originalPidText?.trim());
    if (originalPidText !== null && !isAlive(pid) && readFileSync(pidFile, 'utf8') === originalPidText) rmSync(pidFile);
  } catch {}
  try {
    if (originalLaneText !== null && readFileSync(laneFile, 'utf8') === originalLaneText) rmSync(laneFile);
  } catch {}
  process.exit(0);
}

if (!liveness.launcherAlive && liveness.ownerConfirmed) {
  process.stdout.write('[e2e-stop] stale launcher record; confirmed the lane app owner and will reap orphan ports\n');
}

// Kill by PID tree (the launcher + all its spawned children), mirroring the original
// mechanism. The launcher registers pidFile on startup and removes it on shutdown;
// on an unclean exit it may linger, so we kill the tree here.
if (hasPid && liveness.launcherAlive) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (isAlive(pid)) {
    killTree(pid);
    process.stdout.write(`[e2e-stop] stopped session launcher ${pid} (+ children)\n`);
  } else {
    process.stdout.write(`[e2e-stop] session ${pid} was not running\n`);
  }
}

// Also kill any process still holding the lane's ports — catches orphans that
// survived a non-clean shutdown (on Windows: reparented Node children the
// launcher tree-kill didn't reach; on POSIX: processes that ignored SIGTERM).
if (liveness.live && laneJson?.ports) {
  const { app, dashboard, fake, publicBase } = laneJson.ports;
  const lane = laneJson.lane ?? '?';
  for (const [name, port] of [['app', app], ['dashboard', dashboard], ['fake', fake], ['publicBase', publicBase]]) {
    const reaped = killPort(port);
    if (reaped.length) {
      process.stdout.write(`[e2e-stop] killed orphan(s) on lane ${lane} :${port} (${name}): ${reaped.join(', ')}\n`);
    }
  }
}

// Reclaim this lane's DynamoDB Local tables now that the stack is down.
//
// Nothing used to do this. DynamoDB Local runs -inMemory WITHOUT -sharedDb, so
// it keeps a separate database per (accessKeyId, region): every lane key
// (hclane<L>) and every worktree's vitest key kept its ~23 tables until an
// operator stopped the container. A container left up for days accumulated
// enough to degrade every suite touching it - integration tests timing out at
// their budget in full runs and passing solo in milliseconds (2026-08-16; see
// docs/issues/dynamodb-local-cross-worktree-test-contention.md for the earlier
// -sharedDb variant of the same symptom).
//
// SAFE HERE SPECIFICALLY: we only reach this line after confirming the session
// was live and killing it, so nothing is using the lane. Per-key isolation means
// this can only ever touch THIS lane's database, never a neighbour's.
//
// Best-effort: a failure only leaves the tables behind (exactly the old
// behaviour), so it must never fail the stop.
if (laneJson?.accessKeyId && laneJson?.tablePrefix) {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [
      path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(repoRoot, 'app', 'scripts', 'db-create.ts'),
      '--drop',
    ], {
      cwd: repoRoot,
      stdio: 'ignore',
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: laneJson.accessKeyId,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
        AWS_REGION: 'us-east-1',
        TABLE_PREFIX: laneJson.tablePrefix,
        DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8000',
      },
    });
    process.stdout.write(`[e2e-stop] dropped lane ${laneJson.lane ?? '?'} tables (${laneJson.tablePrefix}*)\n`);
  } catch (err) {
    process.stdout.write(
      `[e2e-stop] lane table cleanup skipped (harmless, tables persist): ${String(err)}\n`,
    );
  }
}

// Release the lane lease so the next run can take this lane immediately instead
// of waiting for pid-liveness to notice the launcher is gone. Compares on the
// token, so stopping a stale session can never free a lane another worktree has
// since claimed.
if (laneJson !== null && typeof laneJson.ownerToken === 'string') {
  try {
    if (releaseLane(laneJson.lane, laneJson.ownerToken)) {
      process.stdout.write(`[e2e-stop] released lane ${laneJson.lane} lease\n`);
    }
  } catch (err) {
    process.stdout.write(`[e2e-stop] lane lease release skipped (harmless): ${String(err)}\n`);
  }
}

// Remove the state files so a stale lane.json / session.pid can't mislead the next run.
try {
  if (originalPidText !== null && readFileSync(pidFile, 'utf8') === originalPidText) rmSync(pidFile);
} catch {}
try {
  if (originalLaneText !== null && readFileSync(laneFile, 'utf8') === originalLaneText) rmSync(laneFile);
} catch {}
try {
  const markerText = readFileSync(profilerMarkerFile, 'utf8');
  const marker = JSON.parse(markerText);
  if (Number.isSafeInteger(marker?.pid) && marker.pid > 0 && !isAlive(marker.pid)) {
    if (readFileSync(profilerMarkerFile, 'utf8') === markerText) rmSync(profilerMarkerFile);
  }
} catch {}
process.stdout.write('[e2e-stop] stale owned session state cleanup complete\n');
