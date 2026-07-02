// Stops a running `npm run e2e:session` stack reliably (kills the launcher and
// all its children). Use this instead of just killing the background task,
// which on Windows leaks the reparented node tree.
//
// Reads e2e/.artifacts/lane.json (written by e2e-session.mjs) to determine
// which lane's ports to kill. After stopping, removes both lane.json and
// session.pid so a stale file can't mislead the next run.
// If lane.json is missing (no running session), prints a clear message and exits.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, killPort, isAlive } from './lib/killTree.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const pidFile = path.join(artifactsDir, 'session.pid');
const laneFile = path.join(artifactsDir, 'lane.json');

// Read lane.json to know which lane we're stopping.
let laneJson = null;
if (existsSync(laneFile)) {
  try {
    laneJson = JSON.parse(readFileSync(laneFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`[e2e-stop] warning: could not parse lane.json: ${String(err)}\n`);
  }
}

// Determine whether a session appears to be running at all.
const hasPid = existsSync(pidFile);
if (!laneJson && !hasPid) {
  process.stdout.write('[e2e-stop] no running session found (lane.json and session.pid both absent) — nothing to stop\n');
  process.exit(0);
}

// Kill by PID tree (the launcher + all its spawned children), mirroring the original
// mechanism. The launcher registers pidFile on startup and removes it on shutdown;
// on an unclean exit it may linger, so we kill the tree here.
if (hasPid) {
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
if (laneJson?.ports) {
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
try { rmSync(pidFile, { force: true }); } catch {}
try { rmSync(laneFile, { force: true }); } catch {}
process.stdout.write('[e2e-stop] lane.json + session.pid removed\n');
