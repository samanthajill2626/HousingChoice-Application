// Resets the local stack's data to a clean, freshly-seeded slate by POSTing the
// gated /__dev/reseed endpoint on the running app. Fast (no process restart).
const base = process.env.E2E_APP_URL ?? 'http://localhost:8080';
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
