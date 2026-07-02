// Resets the local stack's data to a clean, freshly-seeded slate by POSTing the
// gated /__dev/reseed endpoint on the running app. Fast (no process restart).
//
// Reads e2e/.artifacts/lane.json (written by e2e-session.mjs) to target the
// correct lane's ports/URLs. Falls back to E2E_APP_URL / FAKE_TWILIO_URL env vars
// for back-compat when lane.json is absent but a session is running at known ports.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const laneFile = path.join(repoRoot, 'e2e', '.artifacts', 'lane.json');

let base, fakeTwilioBase;

if (existsSync(laneFile)) {
  let laneJson;
  try {
    laneJson = JSON.parse(readFileSync(laneFile, 'utf8'));
  } catch (err) {
    process.stderr.write(`[e2e-reseed] could not parse lane.json: ${String(err)}\n`);
    process.exit(1);
  }
  base = laneJson?.urls?.app;
  fakeTwilioBase = laneJson?.urls?.fake;
  if (!base || !fakeTwilioBase) {
    process.stderr.write(`[e2e-reseed] lane.json is malformed (missing urls.app or urls.fake)\n`);
    process.exit(1);
  }
  process.stdout.write(`[e2e-reseed] targeting lane ${laneJson.lane} (${base})\n`);
} else {
  // No lane.json — check for env-var overrides before giving up.
  if (!process.env.E2E_APP_URL && !process.env.FAKE_TWILIO_URL) {
    process.stderr.write(
      `[e2e-reseed] no running session found (e2e/.artifacts/lane.json is missing).\n` +
        `Start a session first with \`npm run e2e:session\`, then re-run.\n`,
    );
    process.exit(1);
  }
  base = process.env.E2E_APP_URL ?? 'http://127.0.0.1:8080';
  fakeTwilioBase = process.env.FAKE_TWILIO_URL ?? 'http://127.0.0.1:8889';
  process.stdout.write(`[e2e-reseed] no lane.json — using env vars (${base})\n`);
}

try {
  const res = await fetch(`${base}/__dev/reseed`, { method: 'POST' });
  if (!res.ok) {
    process.stderr.write(`[e2e-reseed] failed: HTTP ${res.status} (is a session running with DEV_AUTH_ENABLED?)\n`);
    process.exit(1);
  }
  process.stdout.write('[e2e-reseed] local data reset + reseeded\n');
} catch (err) {
  process.stderr.write(`[e2e-reseed] could not reach ${base}/__dev/reseed: ${String(err)}\n`);
  process.exit(1);
}

// Best-effort: also reset the fake-twilio service so its in-memory threads and any
// in-flight status-callback timers are cleared (otherwise orphaned setTimeout
// callbacks fire stale delivered/undelivered webhooks at the freshly-reseeded app,
// which ERROR-logs an unknown-SID and feeds the error-log alarm). The fake may not
// be running in every context, so a failure here only warns — it never fails the reseed.
try {
  const fakeRes = await fetch(`${fakeTwilioBase}/control/reset`, { method: 'POST' });
  if (!fakeRes.ok) {
    process.stderr.write(`[e2e-reseed] warning: fake-twilio reset returned HTTP ${fakeRes.status} (continuing)\n`);
  } else {
    process.stdout.write('[e2e-reseed] fake-twilio store + timers reset\n');
  }
} catch (err) {
  process.stderr.write(`[e2e-reseed] warning: could not reach ${fakeTwilioBase}/control/reset: ${String(err)} (continuing)\n`);
}
