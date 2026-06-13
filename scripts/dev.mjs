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
// Either way, step "run": app (tsx watch, :8080) + worker (tsx watch) + the
// dashboard Vite dev server (:5173, HMR) concurrently with prefixed output.
// Open http://localhost:5173 for the UI — Vite serves the React app and
// proxies /api + /auth to the app on :8080 (which serves the API only in
// local dev, not the built UI). Ctrl-C stops all three.
//
// Config layering (later wins): .env.dev (the dev stack's operator secrets —
// Twilio, Google OAuth, VAPID — loaded in LIVE mode only) < .env (optional
// local overrides) < real environment variables < mode defaults that must
// hold locally (NODE_ENV=development, OTel off, PUBLIC_BASE_URL=:5173). So a
// local live run is a true mirror of deployed dev: real dev data AND real
// Google login / Twilio / push — except logs go to THIS terminal (pino
// stdout), never CloudWatch (that's the deployed server's awslogs driver).
//
// Flags: --local (hermetic DynamoDB Local; no secrets/AWS), --no-web (skip the
// Vite server — backend only). Granular escape hatches: npm run dev:app /
// dev:worker / dev -w @housingchoice/dashboard / db:* (those do NOT load
// .env/.env.dev or apply mode defaults).
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

function readDotenv(file, label) {
  const p = path.join(repoRoot, file);
  if (!existsSync(p)) return undefined;
  try {
    return parseDotenv(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`dev — ${label} is not valid dotenv: ${err.message}`);
    process.exit(1);
  }
}

// Optional local overrides.
const localEnv = readDotenv('.env', '.env') ?? {};

// Live unless --local or a DynamoDB Local endpoint is in play (mirrors
// resolveDevEnv's mode decision below).
const liveMode =
  !process.argv.includes('--local') &&
  process.env.DYNAMODB_ENDPOINT === undefined &&
  localEnv.DYNAMODB_ENDPOINT === undefined;

// In live mode, load the dev stack's operator secrets so the local app can do
// everything deployed dev can (real Google login, Twilio, push). These are the
// SAME values pushed to Parameter Store for the dev deployment.
let secretsEnv = {};
if (liveMode) {
  const loaded = readDotenv('.env.dev', '.env.dev');
  if (loaded === undefined) {
    console.warn(
      'dev — .env.dev not found: the local app will run WITHOUT the dev operator\n' +
        '       secrets, so Google login, Twilio, and web push are OFF. Copy\n' +
        '       .env.dev.example → .env.dev and fill it in.',
    );
  } else {
    secretsEnv = loaded;
  }
}

// .env (local overrides) wins over .env.dev (dev secrets).
const fileEnv = { ...secretsEnv, ...localEnv };

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

// Whether to also run the dashboard Vite server (default yes; --no-web skips).
const webEnabled = !process.argv.includes('--no-web');

// Children also need tsx on PATH even when this script runs outside npm.
const childEnv = {
  ...process.env,
  ...overlay,
  PATH: `${path.join(repoRoot, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
};

// Local Google login must ride the Vite proxy: a direct hit on the app's
// :8080 carries no x-origin-verify header (the origin-secret validator 403s
// it), but Vite (:5173) stamps it on proxied /auth + /api. So the OAuth
// redirect_uri has to target :5173 — point the app there unless the operator
// set PUBLIC_BASE_URL explicitly. (Register http://localhost:5173/auth/callback
// on the dev Google OAuth client.) Skipped with --no-web — no UI to log in via.
if (webEnabled && (childEnv.PUBLIC_BASE_URL === undefined || childEnv.PUBLIC_BASE_URL === '')) {
  childEnv.PUBLIC_BASE_URL = 'http://localhost:5173';
}

// Local-dev invariants: development NODE_ENV (console messaging driver, non-
// secure cookies) and OTel disabled — so app logs go to THIS terminal only
// (pino stdout). CloudWatch is the deployed server's docker awslogs driver and
// is never wired locally. Both are defaults: an explicit env value still wins.
if (childEnv.NODE_ENV === undefined) childEnv.NODE_ENV = 'development';
if (childEnv.OTEL_SDK_DISABLED === undefined) childEnv.OTEL_SDK_DISABLED = 'true';

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
  const driver =
    childEnv.MESSAGING_DRIVER ?? (childEnv.NODE_ENV === 'production' ? 'twilio' : 'console');
  const secretCount = Object.keys(secretsEnv).length;
  console.log('dev — mode: live dev backend (real dev data + tools, run locally)');
  console.log(`       tables:    ${childEnv.TABLE_PREFIX}*  (DynamoDB, us-east-1)`);
  console.log(`       profile:   ${childEnv.AWS_PROFILE}  (account-guarded)`);
  console.log(
    secretCount > 0
      ? `       secrets:   ${secretCount} keys from .env.dev (Google login, Twilio, push)`
      : '       secrets:   .env.dev MISSING — login/Twilio/push OFF (see warning above)',
  );
  console.log(
    `       messaging: ${driver}` +
      (driver === 'console'
        ? ' (simulated; set MESSAGING_DRIVER=twilio in .env for real sends)'
        : ' (REAL Twilio sends)'),
  );
  console.log('       logs:      this terminal (CloudWatch only on the deployed server)');
  console.log('       (`npm run dev -- --local` for the offline DynamoDB Local loop)');
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
  `dev — ${runStep}: app (:8080) + worker${webEnabled ? ' + dashboard (:5173)' : ''}, ` +
    `watch mode (Ctrl-C stops all${mode === 'local' ? '; DB container stays up' : ''})`,
);
if (webEnabled) {
  // Printed as bare URLs so the terminal makes them clickable.
  console.log('');
  console.log('  ▶ Open the dashboard:  http://localhost:5173');
  console.log('    (UI with hot-reload; proxies /api + /auth to the app on http://localhost:8080)');
  console.log('    Google sign-in works here once http://localhost:5173/auth/callback is');
  console.log('    registered on the dev OAuth client (PUBLIC_BASE_URL set to :5173 for you).');
  console.log('');
}

const commands = [
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
];
if (webEnabled) {
  // The dashboard workspace's own `dev` script = Vite (:5173, vite.config.ts).
  commands.push({
    command: 'npm run dev -w @housingchoice/dashboard',
    name: 'web',
    prefixColor: 'green',
    env: childEnv,
  });
}

const { result } = concurrently(commands, {
  cwd: repoRoot,
  prefix: 'name',
  killOthersOn: ['failure', 'success'],
  handleInput: false,
});

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
