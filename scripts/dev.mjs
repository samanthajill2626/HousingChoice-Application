// npm run dev — the full local dev loop (M0.3):
//
//   1. db:start   ensure the DynamoDB Local container is up (the only local container)
//   2. db:create  ensure all 9 tables exist (idempotent)
//   3. db:seed    ensure seed data exists   (idempotent)
//   4. run app (tsx watch, :8080) + worker (tsx watch) concurrently with
//      prefixed/colorized output. Ctrl-C stops both processes; the DynamoDB
//      Local container stays up (npm run db:stop to stop it).
//
// Granular escape hatches: npm run dev:app / dev:worker / db:* individually.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Children must see the local endpoint even with no .env present, and find
// tsx on PATH even when this script is run outside npm.
const childEnv = {
  ...process.env,
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,
  PATH: `${path.join(repoRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
};

/** Run a one-shot tsx script (db:create / db:seed) and await success. */
function runTsx(scriptRelPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptRelPath], {
      cwd: repoRoot,
      env: childEnv,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${scriptRelPath} exited with code ${code}`)),
    );
  });
}

console.log('dev — step 1/4: DynamoDB Local container');
await ensureDbStarted();
console.log('dev — step 2/4: tables');
await runTsx('app/scripts/db-create.ts');
console.log('dev — step 3/4: seed data');
await runTsx('app/scripts/db-seed.ts');

console.log('dev — step 4/4: app (:8080) + worker, watch mode (Ctrl-C stops both; container stays up)');
const { result } = concurrently(
  [
    {
      command: 'tsx watch --clear-screen=false app/src/index.ts',
      name: 'app',
      prefixColor: 'cyan',
      env: childEnv,
    },
    {
      command: 'tsx watch --clear-screen=false app/src/worker.ts',
      name: 'worker',
      prefixColor: 'magenta',
      env: childEnv,
    },
  ],
  {
    cwd: repoRoot,
    prefix: 'name',
    killOthersOn: ['failure', 'success'],
    handleInput: false,
  },
);

try {
  await result;
} catch {
  // Normal teardown path (Ctrl-C / one process exiting kills the other).
}
console.log('dev — stopped. DynamoDB Local container is still running (npm run db:stop to stop it).');
