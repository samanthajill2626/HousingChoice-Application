// Resets the local stack's data to a clean, freshly-seeded slate by POSTing the
// gated /__dev/reseed endpoint on the running app. Fast (no process restart).
const base = process.env.E2E_APP_URL ?? 'http://localhost:8080';
const fakeTwilioBase = process.env.FAKE_TWILIO_URL ?? 'http://localhost:8889';
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
