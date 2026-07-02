// Triggers an app+worker restart in a running `npm run e2e:session` stack by
// rewriting the sentinel the launcher watches. Vite, DynamoDB, and any attached
// browser are untouched.
//
// Reads e2e/.artifacts/lane.json (written by e2e-session.mjs) to confirm a session
// is running and to log which lane is being restarted. If lane.json is absent
// (no session), prints a clear message and exits gracefully.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const laneFile = path.join(artifactsDir, 'lane.json');
const sentinel = path.join(artifactsDir, '.restart');

if (!existsSync(laneFile)) {
  process.stdout.write(
    `[e2e-restart] no running session found (e2e/.artifacts/lane.json is missing).\n` +
      `Start a session first with \`npm run e2e:session\`, then re-run.\n`,
  );
  process.exit(0);
}

let lane = '?';
try {
  const laneJson = JSON.parse(readFileSync(laneFile, 'utf8'));
  lane = laneJson?.lane ?? '?';
} catch {
  /* malformed lane.json — still write the sentinel; the session watches it */
}

mkdirSync(artifactsDir, { recursive: true });
writeFileSync(sentinel, String(Date.now()));
process.stdout.write(`[e2e-restart] signaled app+worker restart (lane ${lane})\n`);
