// Stops a running `npm run e2e:session` stack reliably (kills the launcher and
// all its children). Use this instead of just killing the background task,
// which on Windows leaks the reparented node tree.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree, isAlive } from './lib/killTree.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const pidFile = path.join(repoRoot, 'e2e', '.artifacts', 'session.pid');

if (!existsSync(pidFile)) {
  process.stdout.write('[e2e-stop] no session.pid — nothing to stop\n');
  process.exit(0);
}
const pid = Number(readFileSync(pidFile, 'utf8').trim());
if (isAlive(pid)) {
  killTree(pid);
  process.stdout.write(`[e2e-stop] stopped session launcher ${pid} (+ children)\n`);
} else {
  process.stdout.write(`[e2e-stop] session ${pid} was not running\n`);
}
try { rmSync(pidFile, { force: true }); } catch {}
