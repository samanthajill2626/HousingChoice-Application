// npm run dev — the local dev loop, two modes:
//
//   live (default)        app + worker on this machine against the REAL dev
//                         backend (hc-dev- DynamoDB tables in us-east-1,
//                         AWS profile housingchoice). Account-guarded: the
//                         script hard-fails unless the profile resolves to
//                         the pinned HousingChoice account. Inbound Twilio
//                         webhooks still hit the DEPLOYED dev stack — they
//                         can't reach localhost.
//   --local (hermetic)    npm run dev -- --local:
//                           1. db:start   DynamoDB Local container
//                           2. db:create  all tables (idempotent)
//                           3. db:seed    seed data   (idempotent)
//                         No AWS credentials needed. Also selected whenever
//                         DYNAMODB_ENDPOINT is set (env or .env).
//
// Either way, step "run": app (tsx watch, :8080) + worker (tsx watch)
// concurrently with prefixed output. Ctrl-C stops both. `.env` at the repo
// root is loaded here (real environment variables win over the file).
//
// Granular escape hatches: npm run dev:app / dev:worker / db:* individually
// (note: those do NOT load .env or apply mode defaults).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';
import { assertHousingChoiceAccount } from './lib/hcAws.mjs';
import { resolveDevEnv } from './lib/devMode.mjs';
import { parseDotenv } from './lib/secretsCore.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const dotenvPath = path.join(repoRoot, '.env');
let fileEnv = {};
if (existsSync(dotenvPath)) {
  try {
    fileEnv = parseDotenv(readFileSync(dotenvPath, 'utf8'));
  } catch (err) {
    console.error(`dev — .env is not valid dotenv: ${err.message}`);
    process.exit(1);
  }
}

let resolved;
try {
  resolved = resolveDevEnv({
    local: process.argv.includes('--local'),
    processEnv: process.env,
    fileEnv,
    localEndpoint: LOCAL_ENDPOINT,
  });
} catch (err) {
  console.error(`dev — ${err.message}`);
  process.exit(1);
}
const { mode, overlay } = resolved;

// Children also need tsx on PATH even when this script runs outside npm.
const childEnv = {
  ...process.env,
  ...overlay,
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

if (mode === 'local') {
  console.log('dev — mode: hermetic (DynamoDB Local; no AWS touched)');
  console.log('dev — step 1/4: DynamoDB Local container');
  await ensureDbStarted();
  console.log('dev — step 2/4: tables');
  await runTsx('app/scripts/db-create.ts');
  console.log('dev — step 3/4: seed data');
  await runTsx('app/scripts/db-seed.ts');
} else {
  console.log(
    `dev — mode: live dev backend (tables ${childEnv.TABLE_PREFIX}*, profile ${childEnv.AWS_PROFILE}; ` +
      'use `npm run dev -- --local` for the hermetic DynamoDB Local loop)',
  );
  console.log('dev — step 1/2: account guard');
  try {
    const identity = await assertHousingChoiceAccount();
    console.log(`dev — account guard OK: ${identity.Arn} (${identity.Account})`);
  } catch (err) {
    console.error(`dev — ${err.message}`);
    process.exit(1);
  }
}

const runStep = mode === 'local' ? 'step 4/4' : 'step 2/2';
console.log(
  `dev — ${runStep}: app (:8080) + worker, watch mode (Ctrl-C stops both${
    mode === 'local' ? '; container stays up' : ''
  })`,
);
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
console.log(
  mode === 'local'
    ? 'dev — stopped. DynamoDB Local container is still running (npm run db:stop to stop it).'
    : 'dev — stopped.',
);
