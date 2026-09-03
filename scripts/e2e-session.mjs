// Unified non-watch launcher for the e2e stack — used by BOTH `npm run e2e`
// (Playwright webServer) and `npm run e2e:session` (the agent's persistent
// inner-loop stack). Spawns app, worker, and Vite as individual `node`
// processes, bakes in the hermetic test env, ensures DynamoDB Local + tables +
// seed once, waits for app health, and restarts ONLY app+worker when the
// restart sentinel changes (Vite, the DB, and any attached browser keep running
// / keep their place). Teardown is verified on Windows (taskkill /T); the POSIX
// path kills each tracked child directly — full Linux/CI teardown is validated
// separately when CI is set up.
import { spawn, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  watchFile,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDbStarted, LOCAL_ENDPOINT } from './db.mjs';
import { ensureS3Started, LOCAL_S3_ENDPOINT } from './s3.mjs';
import { killTree, isAlive, killPort } from './lib/killTree.mjs';
import { defaultProbe } from '../e2e/support/lane.mjs';
import { claimLane, holdsLane, releaseLane } from '../e2e/support/laneLease.mjs';
import {
  assertProfilerPingIdentity,
  profilerOwnerToken as parseProfilerOwnerToken,
  sendProfilerFailure,
  sendProfilerReady,
} from './lib/profilerOwnership.mjs';
import { removeOwnedSessionState } from './lib/sessionState.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// The entity-centric dashboard the e2e specs drive.
const dashboardNextDir = path.join(repoRoot, 'dashboard');
const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
// The fake-phones UI is a static build served by the fake-twilio host.
// We build it once at session start (below) and point the host at its dist.
const fakeUiDistDir = path.join(repoRoot, 'fake-twilio', 'web', 'dist');
const artifactsDir = path.join(repoRoot, 'e2e', '.artifacts');
const sentinel = path.join(artifactsDir, '.restart');
const pidFile = path.join(artifactsDir, 'session.pid');
const laneFile = path.join(artifactsDir, 'lane.json');
const rawProfilerOwnerToken = process.env.E2E_PROFILER_OWNER_TOKEN;
let activeProfilerOwnerToken = null;

// ---------------------------------------------------------------------------
// Lane resolution — OBEY E2E_LANE if set (Playwright path), else free-probe.
// ---------------------------------------------------------------------------
// When Playwright spawns this script it injects E2E_LANE (the lane it resolved
// at config load). We call resolveLane() which respects E2E_LANE via its own
// env-override branch, so config and session always agree without re-probing.
// When run directly (npm run e2e:session), E2E_LANE is unset and resolveLane()
// hashes the worktree identity + free-probes to pick an available lane.
const laneMjs = path.join(repoRoot, 'e2e', 'support', 'lane.mjs');
const laneJson = JSON.parse(
  execFileSync(process.execPath, [laneMjs], { encoding: 'utf8' }).trim(),
);
const { lane, ports, tablePrefix, mediaBucket, accessKeyId, ownerToken, needsReap } = laneJson;

// Derive all per-lane URLs. 127.0.0.1 everywhere — NEVER bare 'localhost'
// (Vite/localhost can resolve to IPv6 ::1 while the free-probe + other services
// use IPv4, causing false "port free" probes and ERR_CONNECTION_REFUSED).
const appUrl = `http://127.0.0.1:${ports.app}`;
const dashboardUrl = `http://127.0.0.1:${ports.dashboard}`;
const fakeUrl = `http://127.0.0.1:${ports.fake}`;
// publicBase is the URL the fake HMAC-signs against and the app reconstructs
// for Twilio signature verification. Must match on both sides.
const publicBaseUrl = `http://127.0.0.1:${ports.publicBase}`;

function laneStateText() {
  return JSON.stringify(
    {
      launcherPid: process.pid,
      lane,
      ports,
      urls: { app: appUrl, dashboard: dashboardUrl, fake: fakeUrl, publicBase: publicBaseUrl },
      tablePrefix,
      mediaBucket,
      accessKeyId,
      // Recorded so `npm run e2e:stop` can RELEASE the lane rather than leave
      // it waiting on pid-liveness to notice this launcher is gone.
      ownerToken: ownerToken ?? null,
    },
    null,
    2,
  );
}

function writeOwnedSessionState() {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(pidFile, String(process.pid));
  writeFileSync(laneFile, laneStateText());
}

// The current checkout's commit, stamped into BOTH the app and the dashboard at
// launch so the e2e preflight (e2e/support/preflight.ts) can detect a STALE
// reused stack — a long-lived session serving old code, especially a Vite that
// wasn't restarted after a backend change. Best-effort: if git is unavailable
// the stamp is empty and the preflight simply skips its freshness check.
let gitSha = '';
try {
  gitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot }).toString().trim();
} catch {
  /* no git / detached HEAD — the preflight freshness check is then skipped */
}

const childEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  OTEL_SDK_DISABLED: process.env.OTEL_SDK_DISABLED ?? 'true',
  DYNAMODB_ENDPOINT: process.env.DYNAMODB_ENDPOINT ?? LOCAL_ENDPOINT,
  TABLE_PREFIX: tablePrefix,
  // Per-lane DynamoDB Local DATABASE (not just table prefix): without
  // -sharedDb the store is keyed by (accessKeyId, region), so this key is
  // what gives the lane its own SQLite write lock — see
  // docs/issues/dynamodb-local-cross-worktree-test-contention.md.
  // FORCED, no ?? fallback: an ambient shell AWS_ACCESS_KEY_ID would silently
  // merge every lane back into ONE database. Safe to force — the hermetic
  // stack never touches real AWS (MinIO clients pin their own fixed creds,
  // and DynamoDB Local ignores the secret's value). AWS_REGION is pinned
  // because the region is part of the store identity: a drifting region
  // would silently point the same key at a different, empty database.
  AWS_ACCESS_KEY_ID: accessKeyId,
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'us-east-1',
  // Local S3 (MinIO) so inbound MMS media mirrors + serves back to the dashboard.
  MEDIA_BUCKET: mediaBucket,
  MEDIA_S3_ENDPOINT: process.env.MEDIA_S3_ENDPOINT ?? LOCAL_S3_ENDPOINT,
  PUBLIC_BASE_URL: publicBaseUrl,
  DEV_AUTH_ENABLED: '1',
  // The public surface ships a strict per-IP abuse fence (default 5 req / 60s)
  // on its unauthenticated, SMS-spending routes. That's correct for prod, but a
  // single e2e run legitimately drives /public/* far more often than that from
  // ONE IP (every flyer teaser load + housing-fair POST + details reveal across
  // the public-pages, proof-of-send, settings, and tenant-onboarding specs share
  // the window) — so the default trips and 429s cascade into "no longer available"
  // funnels + missing welcomes. Raise the ceiling for the hermetic suite ONLY
  // (this never touches a deployed env); an externally-set value still wins.
  PUBLIC_RATE_LIMIT_MAX: process.env.PUBLIC_RATE_LIMIT_MAX ?? '100000',
  // Same story for the per-USER limits on the authenticated send/call-cost
  // routes (manual send / broadcast send / originate / cell verify-start):
  // production defaults are right for humans, but the whole e2e suite drives
  // those routes as the ONE seeded dev-login user within minutes — so the
  // suite would trip ceilings a real staffer never could. Raise them for the
  // hermetic stack ONLY; an externally-set value still wins (that's how a
  // focused rate-limit spec would pin a tiny ceiling). Window vars keep their
  // code defaults — the max is what matters at 100000.
  RATE_LIMIT_MANUAL_SEND_PER_MIN: process.env.RATE_LIMIT_MANUAL_SEND_PER_MIN ?? '100000',
  RATE_LIMIT_BROADCAST_SEND_PER_MIN: process.env.RATE_LIMIT_BROADCAST_SEND_PER_MIN ?? '100000',
  RATE_LIMIT_ORIGINATE_PER_MIN: process.env.RATE_LIMIT_ORIGINATE_PER_MIN ?? '100000',
  RATE_LIMIT_VERIFY_START_MAX: process.env.RATE_LIMIT_VERIFY_START_MAX ?? '100000',
  // --- fake-twilio (HTTP-seam messaging mock) ---
  // The app runs the REAL Twilio driver (MESSAGING_DRIVER=twilio) but is pointed
  // at the in-process fake host via TWILIO_API_BASE_URL, so the production
  // messaging code path + the twilioSignature middleware run unchanged against a
  // local impersonator instead of console-faking the send. The SID/secret values
  // are Twilio-SHAPED dummies (the fake never authenticates them); the shared
  // TWILIO_AUTH_TOKEN is the HMAC key BOTH sides use — the fake signs inbound
  // webhooks with it and the app's signature middleware verifies them.
  MESSAGING_DRIVER: 'twilio',
  TWILIO_ACCOUNT_SID: 'ACfake000000000000000000000000000',
  TWILIO_API_KEY_SID: 'SKfake000000000000000000000000000',
  TWILIO_API_KEY_SECRET: 'fake-secret',
  TWILIO_MESSAGING_SERVICE_SID: 'MGfake000000000000000000000000000',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN ?? 'hermetic-shared-twilio-token',
  TWILIO_API_BASE_URL: fakeUrl,
  BUSINESS_PHONE_NUMBER: '+15550009999',
  // The hermetic org owns exactly that one number - assert it (the `none`
  // literal) so the group-identity boot check is satisfied deliberately rather
  // than by omission, and every lane derives group ids from the same set.
  GROUP_IDENTITY_EXCLUDED_NUMBERS: 'none',
  // --- Voice Intelligence (voice-transcription feature) ---
  // The fake-twilio host also impersonates the VI REST API and fires the signed
  // completion webhook. TWILIO_VI_SERVICE_SID turns transcription ON and MUST equal
  // the fake's viServiceSid; the fake process inherits THIS same childEnv, so pinning
  // both to 'GAfakeservice' aligns the two sides automatically. The reconcile
  // self-heal delay is tiny in the lane so the viWebhook:'drop' spec proves the
  // reconcile leg fast without a long wait. NOTE: '0' would coerce back to the 600s
  // default (Number('0') is falsy in the config parse), so 2 is the intended value.
  TWILIO_VI_SERVICE_SID: process.env.TWILIO_VI_SERVICE_SID ?? 'GAfakeservice',
  VOICE_TRANSCRIPT_RECONCILE_SECONDS: process.env.VOICE_TRANSCRIPT_RECONCILE_SECONDS ?? '2',
  // --- Native group texting: the Conversations SERVICE rails are created under ---
  // Pinned so the lane exercises the SERVICE-SCOPED wire shape
  // (/v1/Services/<sid>/Conversations...), which is what a deployed env sharing a
  // Twilio account with another env must use - not the account-default shape.
  // fake-twilio mounts its Conversations REST router at BOTH prefixes, so the REST
  // half needs no counterpart. The WEBHOOK half does: with this set the app fences
  // out events whose ChatServiceSid differs, so the fake's signer reads this SAME
  // var (it inherits childEnv) to stamp its Conversations webhooks - the
  // TWILIO_VI_SERVICE_SID alignment pattern.
  // `||` after a trim, NOT `??`: `??` preserves an ambient '' or whitespace, and
  // the two sides then DISAGREE - loadConfig normalizes blank to undefined (fence
  // off, default-scope REST) while the fake signer falls back to its own literal.
  // The lane would pass while exercising neither the service-scoped path nor the
  // fence, with these comments still claiming it did. A blank ambient value means
  // "not set", so treat it that way.
  TWILIO_CONVERSATIONS_SERVICE_SID:
    (process.env.TWILIO_CONVERSATIONS_SERVICE_SID ?? '').trim() ||
    'ISfake000000000000000000000000000',
  // NOTE: inbound call-triage dials the seeded inbound-voice-line HOLDER's verified
  // cell. The local seed (devReset → seedInboundVoiceLineHolder) uses the hardcoded
  // SEED_INBOUND_VOICE_CELL fake, so nothing is injected here (the deprecated
  // FOUNDER_CELL env var was removed).
  // A2P kill-switch defaults OFF when MESSAGING_DRIVER=twilio (config.ts), which
  // makes sendMessage throw before anything reaches the fake — force it ON so the
  // hermetic stack actually exercises outbound sends against the fake host.
  SMS_SENDING_ENABLED: 'true',
  // Conversation fact extraction (Phase 2): run the deterministic FAKE driver so
  // specs drive extraction via inbound `EXTRACT:{...}` texts with no real
  // Anthropic call. NODE_ENV here is 'development' (above), so AI_EXTRACTION_ENABLED
  // already defaults ON and 'fake' is a legal driver (config refuses 'fake' only
  // under NODE_ENV=production). This childEnv is passed to BOTH the app and worker
  // processes (spawnNode) and is the SAME path the full `npm run e2e` suite boots
  // (playwright.config webServer.command = node scripts/e2e-session.mjs), so it
  // covers the fake driver in both e2e modes.
  EXTRACTION_DRIVER: 'fake',
  // --- fake-SES (email-channel v1) ---
  // The app runs the REAL SES driver (EMAIL_DRIVER=ses) but is pointed at the
  // in-process fake host via SES_API_BASE_URL (= fakeUrl, exactly like
  // TWILIO_API_BASE_URL) - so the production @aws-sdk/client-sesv2 send path runs
  // unchanged against the fake's /v2/email/outbound-emails surface. The kill-switch
  // is forced ON so sends actually reach the fake; the sender identity satisfies the
  // ses-driver boot gate (EMAIL_SENDER_DOMAIN + EMAIL_FROM_ADDRESS required). The
  // fake process inherits this SAME childEnv, so both sides agree automatically.
  EMAIL_DRIVER: 'ses',
  EMAIL_SENDING_ENABLED: 'true',
  SES_API_BASE_URL: fakeUrl,
  EMAIL_SENDER_DOMAIN: 'mail.local.test',
  EMAIL_FROM_ADDRESS: 'team@mail.local.test',
  // Inbound email (email-channel B4): the per-lane MinIO bucket the fake writes raw
  // inbound MIME to (the SES receipt-rule S3 target). Composed from the lane number -
  // ONE shared MinIO :9000, per-lane bucket is the isolation boundary for inbound MIME
  // (review F22). The fake inherits this SAME childEnv, so both sides agree. Note
  // INBOUND_MAIL_QUEUE_URL is deliberately UNSET locally (ADJ-11: no local SQS - inbound
  // arrives via the fake POST to /webhooks/ses/inbound, so the worker's second consumer
  // stays dormant here).
  INBOUND_MAIL_BUCKET: `hc-local-inbound-mail-${lane}`,
  // Stale-stack guard (e2e/support/preflight.ts): stamp the launch commit on the
  // app (/__dev/ping → appCommit) AND the dashboard (index.html <meta>) so a
  // reused server booted at a different commit is caught with an actionable error.
  E2E_APP_COMMIT: gitSha,
  VITE_E2E_COMMIT: gitSha,
  // Pass the app port so the app process knows which port to bind.
  PORT: String(ports.app),
  // Cross-process event bridge: the worker process forwards its bus emits to
  // the app's POST /internal/events so SSE clients see worker-side writes live
  // (the event-bridge e2e spec proves this path). WORKER_POLL_INTERVAL_MS is
  // deliberately NOT lowered here: in-app dev ticks jump their clock past the
  // debounce, the worker polls real time - a fast cadence would let the worker
  // race tick-driven specs for due rows (tick.processed assertions).
  EVENT_BRIDGE_URL: `http://127.0.0.1:${ports.app}`,
  // Relay 30003 retry ladder (spec Sec 7): shorten rung 1 from 60s to 10s so the
  // browser proof can watch a leg go retrying and then deliver inside its budget.
  // LANE-ONLY - never set in dev or prod, and absent from every .env*.example.
  // Read by app/src/jobs/relayRetryLeg.ts (resolveRelayRetryBackoff), which
  // ignores anything that does not parse to a positive integer, so production
  // keeps 60/120/240. This is CONFIGURATION, not structural absence: the seam
  // ships, the value does not.
  //
  // TEN seconds, not three (code review R1, F6). This value IS the observation
  // window for the spec's D16 assertion: the chip reads `1 retrying` only
  // between the claim's SSE and the rung landing, and the window is this number
  // MINUS the SSE round trip and the dashboard's debounced refetch. At 3000 the
  // one real assertion in the file was racing render latency of the same order;
  // at 10000 the window dwarfs it. It costs the suite about seven seconds, and
  // the spec's own 60s settle budget absorbed a 3.3s reality with room to spare.
  E2E_RELAY_RETRY_BACKOFF_MS: '10000',
  // Pass the lane to child processes so they can self-identify if needed.
  E2E_LANE: String(lane),
};

const children = new Map(); // name -> ChildProcess
let shuttingDown = false;
let restarting = false;
let parentWatchInterval = null;

function log(msg) {
  process.stdout.write(`[e2e-session] ${msg}\n`);
}

/**
 * Where to persist each child's stdout/stderr, or '' for the default.
 *
 * WHY THIS EXISTS: children run with stdio 'inherit', so their output goes to
 * this launcher's stdout - and under `npm run e2e` Playwright's webServer does
 * not capture that, so the app log is DISCARDED. A failing spec therefore
 * preserves browser-side artifacts only, which is precisely why three sightings
 * of an empty inbox read could not be told apart from a healthy one
 * (docs/issues/call-inbox-unread-detached-node-flake.md).
 *
 * OPT-IN, so a normal run behaves exactly as before: set E2E_CHILD_LOG_DIR to a
 * directory and each child also appends to <dir>/<name>.log. Output is still
 * forwarded to this process's stdout either way.
 *
 * TWO LIMITS, stated so nobody trusts this further than it goes:
 *
 * - THE LAST FEW LINES CAN BE LOST. Under `npm run e2e` Playwright tears the
 *   webServer down with a tree-kill, so `shutdown()` below never runs (see its
 *   own comment) and nothing flushes what is still in the sink's queue or in
 *   the unread OS pipe buffer. With plain 'inherit' the child writes to the
 *   inherited fd and no intermediary can lose anything; this path adds a buffer
 *   that dies with the process. For a hang or a timeout - the cases this exists
 *   for - the interesting lines are seconds old and already on disk. For a
 *   crash in the final instant, prefer `npm run e2e:session`, which shuts down
 *   properly.
 * - `runOnce()` children (db-create, db-seed, the builds) still use 'inherit'
 *   and are NOT captured. Only the long-lived services are.
 *
 * NOT OBSERVATIONALLY NEUTRAL, either: switching a child from 'inherit' to
 * 'pipe' makes its stdout a pipe rather than a TTY, so `isTTY` goes false and
 * stdout becomes block-buffered. Pino already emits JSON here so the FORMAT does
 * not change, but a tool that pretty-prints for a TTY would, and buffering
 * shifts when lines appear. Do not use this variable to reproduce a
 * timing-sensitive symptom and then reason from the timings.
 */
const childLogDir = process.env['E2E_CHILD_LOG_DIR'] ?? '';

function spawnNode(name, args, cwd = repoRoot, envOverride = undefined) {
  const env = envOverride ? { ...childEnv, ...envOverride } : childEnv;
  if (childLogDir === '') {
    return spawnNodeInherit(name, args, cwd, env);
  }
  mkdirSync(childLogDir, { recursive: true });
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = createWriteStream(path.join(childLogDir, `${name}.log`), { flags: 'a' });
  // A LOG SINK MUST NEVER TAKE THE LAUNCHER DOWN. An EACCES / ENOSPC / EBUSY on
  // this file arrives as an 'error' event, and an unhandled one on a
  // WriteStream is fatal - which would kill a whole e2e lane to protect a
  // diagnostic. Report and carry on; the run matters more than its log.
  let sinkBroken = false;
  sink.on('error', (err) => {
    sinkBroken = true;
    log(`child log sink for ${name} failed, continuing without it: ${String(err)}`);
  });
  // `end: false` ON BOTH, and this is not a style choice. Piping two readables
  // into one writable with the default `end: true` means the FIRST stream to
  // EOF calls sink.end(), and Node then unpipes every other source when the
  // sink finishes - so the second stream's remaining output is discarded
  // silently, with no error even if you are listening for one. stderr losing
  // its tail is the exact opposite of what a failure log is for.
  child.stdout.pipe(sink, { end: false });
  child.stderr.pipe(sink, { end: false });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  // 'close', NOT 'exit'. 'exit' fires when the PROCESS ends; 'close' fires once
  // its stdio streams are closed too, and the two are not the same moment -
  // Node documents 'close' as existing precisely because stdio can outlive
  // 'exit' when a process shares it with children. These children do: Vite runs
  // esbuild as a child service, and app/worker run under tsx. Ending the sink on
  // 'exit' would drop whatever a grandchild wrote afterwards - reintroducing,
  // four lines below the comment that warns about it, the same silent
  // truncation `{ end: false }` was added to remove.
  child.once('close', () => {
    if (!sinkBroken) sink.end();
  });
  // A run separator, because `flags: 'a'` accumulates sessions into one file and
  // an undelimited concatenation of three runs is close to unreadable. The
  // timestamp is the launcher's, which is the same clock the child's pino lines
  // use, and the pid is what makes the next caveat survivable.
  //
  // CAVEAT on `e2e:restart`: the dying child's final lines can still be draining
  // through its own sink when this separator is written, so a crash tail can
  // appear BELOW the separator for the run that replaced it. Both writes are
  // O_APPEND so nothing corrupts - but attribute by pid, not by position.
  sink.write(`\n===== ${name} started ${new Date().toISOString()} (pid ${child.pid}) =====\n`);
  return trackChild(name, child);
}

function spawnNodeInherit(name, args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
  return trackChild(name, child);
}

function trackChild(name, child) {
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!shuttingDown) log(`${name} exited (code=${code} signal=${signal})`);
  });
  child.on('error', (err) => {
    log(`${name} failed to spawn: ${String(err)}`);
    if (!shuttingDown) shutdown(1);
  });
  children.set(name, child);
  return child;
}

function startApp() {
  spawnNode('app', ['--import', 'tsx', path.join('app', 'src', 'index.ts')]);
}
function startWorker() {
  spawnNode('worker', ['--import', 'tsx', path.join('app', 'src', 'worker.ts')]);
}
async function prepareOwnedPort(port, label) {
  if (activeProfilerOwnerToken !== null) {
    if (!await defaultProbe(port, '127.0.0.1')) {
      throw new Error(`profiler_${label}_port_occupied`);
    }
    return;
  }
  // killPort tree-kills EVERY pid listening on this port, with no check that
  // the process is ours. That is safe only because holding this lane's lease
  // proves no other live run owns it - anything still on these ports is an
  // orphan of a dead run. Without that proof we must not kill: the process
  // could be a neighbouring worktree's Vite, mid-suite.
  // See docs/issues/e2e-lane-allocation-cross-worktree-race.md.
  if (!holdsLane(lane, ownerToken)) {
    if (await defaultProbe(port, '127.0.0.1')) return; // free anyway - nothing to do
    throw new Error(
      `lane ${lane} ${label} port :${port} is held, and this launcher does not hold lane ${lane}'s ` +
        `lease - refusing to kill a process it cannot account for. ` +
        `Run npm run e2e:stop here, or let the resolver pick another lane.`,
    );
  }
  const reaped = killPort(port);
  if (reaped.length) log(`reaped orphan(s) holding :${port} before start: ${reaped.join(', ')}`);
}

async function startViteNext() {
  // PREFLIGHT — reap any orphan holding the dashboard port before spawning Vite.
  // It pins `strictPort: true` (dashboard/vite.config.ts), so a held port makes
  // Vite exit non-zero instead of drifting to another port — which here lands in
  // `child.on('exit')` (logged, not a shutdown), so `web-next` silently vanishes
  // and Playwright's webServer polls a stale server or times out. Freeing the
  // port first guarantees the child we spawn owns it.
  await prepareOwnedPort(ports.dashboard, 'dashboard');
  // DASHBOARD_PORT (not the generic PORT — that's the APP's variable, and a
  // shared env would leak it into Vite: the 2026-07-02 `npm run dev` regression
  // where Vite bound the app's 8080). vite.config.ts reads DASHBOARD_PORT.
  spawnNode('web-next', [viteBin], dashboardNextDir, {
    DASHBOARD_PORT: String(ports.dashboard),
    APP_PORT: String(ports.app),
  });
}
async function startFakeTwilio() {
  // The fake-twilio host impersonates Twilio's REST API (the app's redirected
  // driver POSTs sends here) and fires correctly-signed webhooks BACK at the app.
  // Two URLs, deliberately split: it POSTs webhooks to APP_BASE_URL (the app's
  // real address) but SIGNS them against APP_PUBLIC_BASE_URL (the app's
  // PUBLIC_BASE_URL) — because the app's signature middleware reconstructs
  // the signed URL as `${PUBLIC_BASE_URL}${req.originalUrl}`. CF_ORIGIN_SECRET is
  // inherited from childEnv so the dispatcher's x-origin-verify header satisfies
  // the app's origin-secret validator (which gates /webhooks/* too).
  //
  // PREFLIGHT — reap any orphan still holding the fake port. On Windows a second
  // `app.listen()` on an already-bound port does NOT raise EADDRINUSE: the listen
  // callback fires, the process exits 0 without ever owning the socket, and the
  // launcher would then track that throwaway child while an untracked orphan keeps
  // the port — un-killable by killChild/shutdown/e2e:stop. Freeing the port first
  // guarantees the child we spawn below is the real owner and a tracked
  // descendant of this launcher (so tree-kill teardown covers it).
  await prepareOwnedPort(ports.fake, 'fake');
  spawnNode('fake-twilio', ['--import', 'tsx', path.join('fake-twilio', 'src', 'index.ts')], undefined, {
    FAKE_TWILIO_PORT: String(ports.fake),
    APP_BASE_URL: appUrl,
    APP_PUBLIC_BASE_URL: publicBaseUrl,
    // The base the fake mints RecordingUrl/MediaUrl from (recordingServeBase in
    // callEngine). The app fetches recordings from the fake at TWILIO_API_BASE_URL
    // (= fakeUrl) and its media-SSRF allowlist accepts ONLY that exact origin. The
    // fake otherwise defaults this to http://localhost:<port>, whose origin differs
    // from the lane's 127.0.0.1 fakeUrl → MediaFetchRefusedError 'host_not_allowed'
    // (recording never mirrors). Pin it to fakeUrl so the origins match. 127.0.0.1
    // everywhere — do NOT use localhost (the deliberate IPv4-consistency choice).
    FAKE_TWILIO_PUBLIC_URL: fakeUrl,
    // Serve the pre-built fake-phones UI (built once in main() before first start).
    // On a restartBackend() bounce the existing dist is reused — the UI rarely
    // changes, so we don't rebuild it.
    FAKE_TWILIO_UI_DIST: fakeUiDistDir,
  });
}

async function buildFakeUi() {
  // Build the standalone fake-phones React/Vite app once so the host can serve it
  // as a static bundle on the fake port. Vite caches between runs, so this is
  // cheap after the first build. Must finish BEFORE startFakeTwilio() so dist/ exists.
  const started = Date.now();
  log('building fake-phones UI (npm run build -w @housingchoice/fake-twilio-web)…');
  // npm-cli.js ships alongside the node binary (…/node_modules/npm/bin/npm-cli.js),
  // so we run it through process.execPath rather than relying on a PATH lookup.
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await runOnce('fake-ui-build', [npmCli, 'run', 'build', '-w', '@housingchoice/fake-twilio-web']);
  log(`fake-phones UI built in ${((Date.now() - started) / 1000).toFixed(1)}s → ${fakeUiDistDir}`);
}

function killChild(name) {
  const child = children.get(name);
  if (!child) return;
  killTree(child.pid);
  children.delete(name);
}

async function runOnce(name, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: childEnv, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))));
    child.on('error', reject);
  });
}

async function waitForHealth(url = `${appUrl}/health`, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`health did not come up in time: ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function cleanSlate() {
  // Reseed the backend so every session boots HERMETIC. The DynamoDB container is
  // REUSED across boots for speed and `db-seed` only idempotently re-PutItems fixed-ID
  // rows — it never CLEARS — so dynamically-created rows (contacts, messages, and the
  // `sid#<providerSid>` inbound-dedup pointers) accumulate across boots forever.
  // /__dev/reseed clears + re-seeds, wiping those stale pointers. (Together with
  // fake-twilio's now-randomized SID base this keeps interactive `e2e:session` driving
  // clean and collision-free. `npm run e2e` ALSO reseeds in globalSetup — the extra
  // reseed there is a cheap, harmless no-op.)
  const res = await fetch(`${appUrl}/__dev/reseed`, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`clean-slate reseed failed (HTTP ${res.status}) at ${appUrl}/__dev/reseed`);
  }
  // Best-effort: also clear the fake's threads + any in-flight status-callback timers.
  await fetch(`${fakeUrl}/control/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {
    /* the fake may be momentarily unavailable — never fail boot over its reset */
  });
}

async function verifyProfilerChildIdentity() {
  if (activeProfilerOwnerToken === null) return;
  let body;
  try {
    const response = await fetch(`${appUrl}/__dev/ping`);
    if (!response.ok) throw new Error('profiler_ping_failed');
    body = await response.json();
  } catch {
    throw new Error('profiler_ping_failed');
  }
  assertProfilerPingIdentity({
    expectedCommit: gitSha,
    expectedOwnerToken: activeProfilerOwnerToken,
    body,
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (parentWatchInterval !== null) {
    clearInterval(parentWatchInterval);
    parentWatchInterval = null;
  }
  log('shutting down — stopping app, worker, web, fake-twilio (DynamoDB + MinIO containers left running)');
  for (const name of [...children.keys()]) killChild(name);
  removeOwnedSessionState({ pidFile, launcherPid: process.pid });
  // Release the lane so the next run can take it immediately rather than
  // waiting for pid-liveness to notice we are gone. Compares on the token, so
  // a late shutdown can never free a lane someone else has since claimed.
  //
  // BEST-EFFORT, and deliberately so. This runs on a signal-driven shutdown and
  // on `npm run e2e:stop`, but NOT when Playwright tears its webServer down by
  // tree-kill (measured on Windows, 2026-08-21: a clean 251-spec run left the
  // lease behind). That is the case pid-liveness staleness exists for - the
  // very next resolve sees a `held` record with a dead pid and reclaims it,
  // which is exactly what happened on the following run. Releasing is an
  // optimisation that skips one reclaim; correctness never depends on it.
  if (ownerToken !== null && ownerToken !== undefined && releaseLane(lane, ownerToken)) {
    log(`released lane ${lane}`);
  }
  setTimeout(() => process.exit(code), 500);
}

async function restartBackend() {
  if (restarting) {
    log('restart already in progress — ignoring this trigger');
    return;
  }
  restarting = true;
  try {
    log('restart sentinel changed — restarting app + worker + fake-twilio (Vite/DB untouched)');
    killChild('app');
    killChild('worker');
    // Also bounce fake-twilio so a code change to it is picked up on restart.
    killChild('fake-twilio');
    await new Promise((r) => setTimeout(r, 200));
    await startFakeTwilio();
    await waitForHealth(`${fakeUrl}/health`);
    startApp();
    startWorker();
    await waitForHealth();
    await verifyProfilerChildIdentity();
    log('app + worker + fake-twilio back up');
  } catch (err) {
    log(activeProfilerOwnerToken === null
      ? `restart health check failed: ${String(err)}`
      : 'restart health check failed: profiler_identity_refused');
    if (activeProfilerOwnerToken !== null) shutdown(1);
  } finally {
    restarting = false;
  }
}

async function main() {
  const parentPid = process.ppid;
  activeProfilerOwnerToken = parseProfilerOwnerToken(rawProfilerOwnerToken);

  if (activeProfilerOwnerToken !== null && typeof process.send !== 'function') {
    throw new Error('profiler_ipc_unavailable');
  }

  // SELF-HEAL: if a stale session.pid exists, kill that launcher tree first.
  if (existsSync(pidFile)) {
    const oldPid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid && isAlive(oldPid)) {
      if (activeProfilerOwnerToken !== null) throw new Error('profiler_existing_session_live');
      log(`reaping stale session launcher (pid=${oldPid})…`);
      killTree(oldPid);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (activeProfilerOwnerToken !== null) {
    for (const [label, port] of [
      ['app', ports.app],
      ['dashboard', ports.dashboard],
      ['fake', ports.fake],
      ['public_base', ports.publicBase],
    ]) {
      if (!await defaultProbe(port, '127.0.0.1')) {
        throw new Error(`profiler_${label}_port_occupied`);
      }
    }
  }

  // CLAIM the lane lease. The resolver that picked this lane was a short-lived
  // child (execFileSync of lane.mjs, above), so its reservation is stamped with
  // a pid that is already gone. This launcher is the long-lived process, so it
  // takes ownership under the same token - and from here `holdsLane` is what
  // authorises anything destructive (port reaps, table drops).
  // THIS is where a lease refusal belongs - the launcher is the only process
  // that boots a stack, so it is the only one that has to own the lane.
  // lane.mjs deliberately reports `ownerToken: null` instead of throwing, so a
  // Playwright test worker re-reading the config can never fail the suite over
  // ownership (that mistake cost a 70-spec run on 2026-08-21).
  if (ownerToken === null || ownerToken === undefined) {
    throw new Error(
      `lane ${lane} is held by another live run on this machine, so this session will not start ` +
        `a second stack on it. Wait for it, run npm run e2e:stop in that worktree, or unset ` +
        `E2E_LANE and let the resolver pick a free lane.`,
    );
  }
  if (!claimLane(lane, ownerToken, { appCommit: gitSha || null })) {
    throw new Error(
      `could not claim lane ${lane}'s lease - another run took it while this session was starting. ` +
        `Re-run; the resolver will pick a free lane.`,
    );
  }
  if (needsReap === true) {
    log(`lane ${lane} has ports held by a dead run's orphans - reaping them (we hold the lease)`);
  }

  // State becomes visible only after this launcher has proved the lane has no
  // live session marker and every profiler-owned port is free.
  writeOwnedSessionState();

  if (!existsSync(sentinel)) writeFileSync(sentinel, '0');

  // Log the resolved lane so the MCP browser (and humans) can see which ports
  // are in use — critical for debugging and for the MCP to navigate the right URL.
  log(`resolved lane ${lane}: app=${appUrl} dashboard=${dashboardUrl} fake=${fakeUrl} publicBase=${publicBaseUrl}`);
  log(`tablePrefix=${tablePrefix} mediaBucket=${mediaBucket} accessKeyId=${accessKeyId}`);

  log('ensuring DynamoDB Local…');
  await ensureDbStarted();
  log('ensuring MinIO local S3…');
  await ensureS3Started();
  log('creating tables + media bucket + seeding…');
  await runOnce('db-create', ['--import', 'tsx', path.join('app', 'scripts', 'db-create.ts')]);
  // RETROFIT MISSING GSIs before seeding. `db-create`'s ensureTable is
  // CREATE-ONLY: on ResourceInUseException it reports 'exists' and touches
  // nothing, so a lane whose tables predate a new GSI in lib/tables.ts never
  // gains that index - forever. The symptom is environment drift wearing a
  // regression's clothes: on 2026-07-21 a schema-adding day made lanes 15 and
  // 16 fail a BROAD ~20-spec cluster, deterministic on those lanes, green on a
  // fresh one, costing ~5 full-suite runs before anyone suspected the lane.
  //
  // db:update-gsis is the no-data-loss remedy built for exactly this: it diffs
  // each live table against its TableSpec and CREATEs only what is missing,
  // one index per UpdateTable as DynamoDB requires. Idempotent - a lane that is
  // already current reports `ok` and is left alone - and hard-gated to a
  // localhost endpoint, so it can never touch a deployed table.
  // See docs/issues/e2e-lane-tables-stale-schema.md.
  await runOnce('db-update-gsis', ['--import', 'tsx', path.join('app', 'scripts', 'db-update-gsis.ts')]);
  await runOnce('s3-create', ['--import', 'tsx', path.join('app', 'scripts', 's3-create.ts')]);
  await runOnce('db-seed', ['--import', 'tsx', path.join('app', 'scripts', 'db-seed.ts')]);

  // Build the fake-phones UI BEFORE starting the host, so its dist/ exists when
  // the host wires up static serving (FAKE_TWILIO_UI_DIST).
  await buildFakeUi();

  // Start fake-twilio FIRST so the app's very first outbound send has a host to
  // reach (the app only calls it on send, but this avoids a race on boot).
  log(`starting fake-twilio (:${ports.fake})…`);
  await startFakeTwilio();
  await waitForHealth(`${fakeUrl}/health`);
  log(`fake-twilio ready (:${ports.fake})`);
  log(`fake-phones UI → ${fakeUrl}/`);

  log(`starting app, worker, web :${ports.dashboard} (non-watch)…`);
  if (activeProfilerOwnerToken !== null && !await defaultProbe(ports.app, '127.0.0.1')) {
    throw new Error('profiler_app_port_occupied');
  }
  startApp();
  startWorker();
  await startViteNext();

  await waitForHealth();
  await verifyProfilerChildIdentity();

  // Clean slate: clear any rows accumulated in the reused DynamoDB container (incl.
  // stale fake-SID dedup pointers) so this session starts hermetic. See cleanSlate().
  log('clean-slate reseed (hermetic session start)…');
  await cleanSlate();

  log(`ready — app :${ports.app} (${appUrl}), web :${ports.dashboard} (${dashboardUrl}), fake-twilio :${ports.fake} (${fakeUrl}), MinIO :9000 (MESSAGING_DRIVER=twilio → fake)`);
  // Filtered runs (`npx playwright test <file>` from e2e/) now REUSE this
  // session automatically - playwright.config.ts prefers a live lane.json. The
  // explicit export is still printed as the manual override, and because an
  // agent reading this log should be able to see which lane to watch.
  log(`filtered runs reuse this session automatically; to force it: E2E_LANE=${lane}`);

  sendProfilerReady(
    activeProfilerOwnerToken,
    typeof process.send === 'function' ? (message) => process.send(message) : undefined,
  );

  // PARENT-DEATH WATCH: if the parent process (the task shell or Playwright) dies,
  // shut down automatically. This fires only when the parent is genuinely gone —
  // during Playwright suite runs, Playwright stays alive, so the interval is dormant.
  parentWatchInterval = setInterval(() => {
    if (!isAlive(parentPid)) {
      log('parent process exited — shutting down session');
      shutdown(0);
    }
  }, 1000);

  // Restart only app+worker when the sentinel file is rewritten.
  watchFile(sentinel, { interval: 300 }, () => {
    void restartBackend();
  });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => {
    for (const name of [...children.keys()]) killChild(name);
  });
}

main().catch((err) => {
  sendProfilerFailure(
    activeProfilerOwnerToken,
    err,
    typeof process.send === 'function' ? (message) => process.send(message) : undefined,
  );
  log(activeProfilerOwnerToken === null ? `fatal: ${String(err)}` : 'fatal: profiler_launcher_failed');
  shutdown(1);
});
