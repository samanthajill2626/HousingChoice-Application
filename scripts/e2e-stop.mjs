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
