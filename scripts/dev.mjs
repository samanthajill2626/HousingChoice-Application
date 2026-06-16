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
//                           2. db:create  all tables — DROP + recreate (empty)
//                                         by default; idempotent (skip-existing)
//                                         with --seeded
//                           3. db:seed    seed data   (idempotent) — ONLY with --seeded
//                         Starts with a guaranteed-EMPTY DB by default (a prior
//                         seed is wiped); pass --seeded to load the demo
//                         fixtures instead. No AWS credentials needed. Also
//                         selected whenever DYNAMODB_ENDPOINT is set (env or .env).
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
// Flags — independent, single-purpose, compose freely:
//   --local  controls DynamoDB ONLY: hermetic DynamoDB Local (no secrets/AWS)
//            vs the live AWS dev backend (default).
//   --mock   controls Twilio ONLY: runs the fake-twilio host + fake-phones UI on
//            :8889 and redirects the app's messaging at it (real Twilio driver
//            against a local impersonator — never real Twilio). Works in either
//            DynamoDB mode.
//   --seeded controls SEED DATA ONLY (local mode): load the demo fixtures
//            (app/src/lib/seedData.ts) into DynamoDB Local and create tables
//            idempotently (no wipe). Without it the hermetic DB is dropped +
//            recreated empty each boot. No effect in live mode (never seeds AWS).
//   --no-web skip the Vite server — backend only.
// `--local --mock --seeded` is the fully self-consistent combo: the fake's
// seeded +1555… personas match the hermetic seed data. `--mock` alone redirects
// Twilio against the LIVE dev backend, where those seeded personas won't map to
// real dev contacts; `--local --mock` without --seeded starts with an empty DB,
// so those personas won't resolve to any seeded contact either. Granular escape
// hatches: npm run dev:app / dev:worker /
// dev -w @housingchoice/dashboard-legacy / db:* (those do NOT load .env/.env.dev or
// apply mode defaults).
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';
import { ensureS3Started, LOCAL_S3_ENDPOINT } from './s3.mjs';
import { killPort } from './lib/killTree.mjs';
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

// --mock runs the fake-twilio host + fake-phones UI alongside the app and points
// the app's messaging at it (the real Twilio driver against a local impersonator,
// never real Twilio). It controls ONLY Twilio — it is orthogonal to --local
// (which alone decides DynamoDB) and composes freely with either DynamoDB mode.
const mockEnabled = process.argv.includes('--mock');

// --seeded loads the demo fixtures (app/src/lib/seedData.ts) into DynamoDB Local.
// Local-only: live mode talks to the real AWS dev backend and is never seeded.
const seedEnabled = process.argv.includes('--seeded');

// Live unless --local or a DynamoDB Local endpoint is in play (mirrors
// resolveDevEnv's mode decision below). --mock does NOT affect this — it only
// redirects Twilio, not the database.
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

// In --local, point the media store at the local MinIO (the S3 counterpart of
// DynamoDB Local). Orthogonal to --mock: the store exists whenever storage is
// local; --mock only decides whether inbound MMS arrives to fill it.
const localMediaEnv =
  mode === 'local'
    ? { MEDIA_BUCKET: process.env.MEDIA_BUCKET ?? 'hc-local-media', MEDIA_S3_ENDPOINT: LOCAL_S3_ENDPOINT }
    : {};

// Children also need tsx on PATH even when this script runs outside npm.
const childEnv = {
  ...process.env,
  ...overlay,
  ...localMediaEnv,
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

// --mock points the app's messaging at the local fake-twilio host on :8889 so it
// runs the REAL Twilio driver + signature middleware against an impersonator
// (never real Twilio). This is orthogonal to the DynamoDB mode: it applies in
// BOTH live and local, gated purely on --mock. Mirrors the env that
// scripts/e2e-session.mjs bakes in.
const mockRedirect = mockEnabled;
if (mockRedirect) {
  // FORCED — these define "use the mock", so they override any operator value:
  // route the driver at the local fake and accept its app-number on inbound.
  childEnv.MESSAGING_DRIVER = 'twilio';
  childEnv.TWILIO_API_BASE_URL = 'http://localhost:8889';
  // Append the fake's app-number to OUR_PHONE_NUMBERS so the app recognizes it,
  // preserving any real numbers from .env.dev in live mode (and the fake's number
  // working). Set it outright when unset.
  {
    const existing = childEnv.OUR_PHONE_NUMBERS;
    childEnv.OUR_PHONE_NUMBERS =
      existing === undefined || existing === ''
        ? '+15550009999'
        : `${existing},+15550009999`;
  }

  // ONLY-IF-ABSENT — respect live .env.dev creds/token; the fake inherits
  // TWILIO_AUTH_TOKEN from childEnv either way, so signatures still match.
  const mockDefaults = {
    TWILIO_ACCOUNT_SID: 'ACfake000000000000000000000000000',
    TWILIO_API_KEY_SID: 'SKfake000000000000000000000000000',
    TWILIO_API_KEY_SECRET: 'fake-secret',
    TWILIO_MESSAGING_SERVICE_SID: 'MGfake000000000000000000000000000',
    TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? 'hermetic-shared-twilio-token',
    SMS_SENDING_ENABLED: 'true',
    // Founder call-triage dial-through target: a fake E.164 so an inbound call to
    // the business number runs the FULL founder bridge through the fake (whisper →
    // press-1 → answer → record → transcribe) instead of degrading to the "text us"
    // fallback. Never a real cell. A real value (env/.env.dev) still wins via the
    // only-if-absent merge below.
    FOUNDER_CELL: process.env.FOUNDER_CELL ?? '+15550000001',
  };
  for (const [k, v] of Object.entries(mockDefaults)) {
    if (childEnv[k] === undefined || childEnv[k] === '') childEnv[k] = v;
  }
}

/** Run a one-shot tsx script (db:create / db:seed) and await success. */
function runTsx(scriptRelPath, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptRelPath, ...scriptArgs], {
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

/** Run a one-shot command (e.g. an npm workspace build) and await success. */
function runCommand(cmd, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: repoRoot,
      env: childEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32', // resolve npm.cmd on Windows
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`)),
    );
  });
}

// Abs path to the fake-phones UI build the fake-twilio host serves under --mock.
const fakeUiDistDir = path.join(repoRoot, 'fake-twilio', 'web', 'dist');

// Local boot steps: DB container, MinIO S3, tables+bucket, [seed only with
// --seeded], then run. MinIO is the storage counterpart of DynamoDB Local — it
// starts in --local regardless of --mock/--seeded (only inbound MMS fills it).
const localSteps = seedEnabled ? 5 : 4;
if (mode === 'local') {
  console.log('dev — mode: hermetic (DynamoDB Local + MinIO S3; no AWS touched)');
  console.log(`dev — step 1/${localSteps}: DynamoDB Local container`);
  await ensureDbStarted();
  console.log(`dev — step 2/${localSteps}: MinIO local S3 container`);
  await ensureS3Started();
  if (seedEnabled) {
    console.log(`dev — step 3/${localSteps}: tables + media bucket`);
    await runTsx('app/scripts/db-create.ts');
    await runTsx('app/scripts/s3-create.ts');
    console.log(`dev — step 4/${localSteps}: seed data (--seeded)`);
    await runTsx('app/scripts/db-seed.ts');
  } else {
    // No --seeded: DROP + recreate the tables so a previously-seeded container
    // can't leak stale fixtures — a true zero-data start. (--reset is hard-
    // gated to the localhost endpoint inside db-create.ts.) The media bucket is
    // ensured either way (s3-create is idempotent).
    console.log(`dev — step 3/${localSteps}: tables (reset — empty DB) + media bucket`);
    await runTsx('app/scripts/db-create.ts', ['--reset']);
    await runTsx('app/scripts/s3-create.ts');
    console.log('dev — seed data: SKIPPED (empty DB; pass --seeded to load demo fixtures)');
  }
} else {
  if (seedEnabled) {
    console.warn('dev — --seeded ignored in live mode (the AWS dev backend is never seeded).');
  }
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
  console.log('       logs:      messages here; full JSON saved to logs/dev-*.log (CloudWatch is the deployed server only)');
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

// --mock prep runs in EITHER mode (orthogonal to the DynamoDB decision above):
// build the fake-phones UI the host serves and free :8889 before launch.
if (mockRedirect) {
  console.log('dev — mock: building fake-phones UI (npm run build -w @housingchoice/fake-twilio-web)…');
  await runCommand('npm', ['run', 'build', '-w', '@housingchoice/fake-twilio-web'], 'fake-phones UI build');
  // Reap any orphan still holding :8889 before concurrently spawns the host
  // (a second listen on a held port silently no-ops on Windows — see killTree).
  const reaped = killPort(8889);
  if (reaped.length) console.log(`dev — mock: reaped orphan(s) on :8889 before start: ${reaped.join(', ')}`);
}

const runStep = mode === 'local' ? `step ${localSteps}/${localSteps}` : 'step 2/2';
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
if (mockRedirect) {
  // Printed as a bare URL so the terminal makes it clickable.
  console.log('  ▶ Fake phones (mock): http://localhost:8889/');
  console.log("    (the app's messaging is redirected to this local mock — no real Twilio sends)");
  console.log('');
}
if (mode === 'local') {
  console.log('  ▶ MinIO console:      http://localhost:9001/  (user: local / pass: locallocal)');
  console.log('    (local S3 for mirrored MMS media; bucket hc-local-media)');
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
    command: 'npm run dev -w @housingchoice/dashboard-legacy',
    name: 'web',
    prefixColor: 'green',
    env: childEnv,
  });
}
if (mockRedirect) {
  // The fake-twilio host impersonates Twilio's REST API (the app's redirected
  // driver POSTs sends here) and fires correctly-signed webhooks BACK at the app.
  // It POSTs to APP_BASE_URL (:8080, the app's real address) but SIGNS against
  // APP_PUBLIC_BASE_URL (the app's PUBLIC_BASE_URL) — the app's signature
  // middleware reconstructs the signed URL as `${PUBLIC_BASE_URL}${originalUrl}`.
  // CF_ORIGIN_SECRET is inherited via childEnv. Mirrors scripts/e2e-session.mjs.
  commands.push({
    command: 'tsx fake-twilio/src/index.ts',
    name: 'fake-twilio',
    prefixColor: 'yellow',
    env: {
      ...childEnv,
      FAKE_TWILIO_PORT: '8889',
      APP_BASE_URL: 'http://localhost:8080',
      APP_PUBLIC_BASE_URL: childEnv.PUBLIC_BASE_URL,
      FAKE_TWILIO_UI_DIST: fakeUiDistDir,
    },
  });
}

// --- Local dev logging -----------------------------------------------------
// The terminal shows just each line's MESSAGE (+ stack trace on error); the
// FULL pino JSON for every line is tee'd to a timestamped logs/dev-<ts>.log so
// nothing is lost (and an agent can read it back after an error). The app's
// logger is UNCHANGED — it still emits JSON to stdout (prod ships that to
// CloudWatch via the docker awslogs driver); this only reshapes what the LOCAL
// runner SHOWS vs. FILES. concurrently writes its prefixed child output to
// `outputStream` below instead of straight to the terminal, so we intercept it.
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const NAME_COLOR = { app: '\x1b[36m', worker: '\x1b[35m', web: '\x1b[32m' };
const ANSI_RESET = '\x1b[0m';
const PREFIXED = /^\[([^\]]+)\]\s?([\s\S]*)$/;
// After the message, show the DOMAIN fields (method, path, statusCode,
// conversationId, providerSid, jobName, count, …) — that's what makes a line
// useful. Skip only pino/correlation boilerplate (those stay in the file).
const DEVLOG_BOILERPLATE = new Set([
  'time', 'pid', 'hostname', 'level', 'msg', 'v', 'name',
  'correlationId', 'requestId', 'jobRunId', 'bootId', 'traceparent', 'hopCount',
  'xff', 'xffTrust', 'headers', 'err',
]);
function devLogValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  const s = String(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

let logStream;
let logRelPath;
try {
  mkdirSync(path.join(repoRoot, 'logs'), { recursive: true });
  // new Date() is fine here (a normal script, not a Workflow); make it
  // filesystem-safe (no ':' / '.'). Files are kept around on purpose.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  logRelPath = path.join('logs', `dev-${stamp}.log`);
  logStream = createWriteStream(path.join(repoRoot, logRelPath), { flags: 'a' });
} catch (err) {
  console.warn(`dev — could not open a log file (${err.message}); terminal-only logging`);
}
if (logRelPath) {
  console.log(`  ▶ Full JSON logs: ${logRelPath}`);
  console.log('');
}

function renderDevLine(line) {
  const clean = line.replace(STRIP_ANSI, '');
  if (clean.length === 0) return;
  const m = PREFIXED.exec(clean);
  const name = m ? m[1] : '';
  const payload = m ? m[2] : clean;
  // FILE: the full payload (pino JSON intact), name-prefixed for correlation.
  if (logStream) logStream.write(`${name ? `[${name}] ` : ''}${payload}\n`);
  // TERMINAL: just the message; on a pino error (level >= 50) append the stack.
  let shown = payload;
  try {
    const o = JSON.parse(payload);
    if (o && typeof o === 'object' && typeof o.msg === 'string') {
      shown = o.msg;
      const extras = [];
      for (const [k, val] of Object.entries(o)) {
        if (!DEVLOG_BOILERPLATE.has(k)) extras.push(`${k}=${devLogValue(val)}`);
      }
      if (extras.length > 0) shown += ` ${extras.join(' ')}`;
      if (typeof o.level === 'number' && o.level >= 50) {
        const trace = o.err?.stack ?? o.err?.message;
        if (trace) shown += `\n${String(trace).replace(/^/gm, '    ')}`;
      }
    }
  } catch {
    // not pino JSON (tsx/vite banner, etc.) — pass the line through unchanged
  }
  const prefix = name ? `${NAME_COLOR[name] ?? ''}[${name}]${ANSI_RESET} ` : '';
  process.stdout.write(`${prefix}${shown}\n`);
}

class DevLogStream extends Writable {
  #buf = '';
  _write(chunk, _enc, cb) {
    this.#buf += chunk.toString();
    let nl;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      renderDevLine(this.#buf.slice(0, nl));
      this.#buf = this.#buf.slice(nl + 1);
    }
    cb();
  }
}

const { result } = concurrently(commands, {
  cwd: repoRoot,
  prefix: 'name',
  killOthersOn: ['failure', 'success'],
  handleInput: false,
  outputStream: new DevLogStream(),
});

try {
  await result;
} catch {
  // Normal teardown path (Ctrl-C / one process exiting kills the other).
}
logStream?.end();
console.log(
  (mode === 'local'
    ? 'dev — stopped. DynamoDB Local container is still running (npm run db:stop to stop it). S3 mock container is still running (npm run s3:stop to stop it).'
    : 'dev — stopped.') + (logRelPath ? ` Full logs: ${logRelPath}` : ''),
);
