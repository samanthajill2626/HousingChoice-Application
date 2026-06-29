import type { FullConfig } from '@playwright/test';

/**
 * Global preflight — runs ONCE before any spec (Playwright `globalSetup`), after
 * the webServer is ready OR after Playwright decides to REUSE a server already
 * bound to the baseURL.
 *
 * Why this exists: `reuseExistingServer` (playwright.config.ts) will happily
 * reuse ANY process already listening on :5174 — including a stale or
 * hand-started session booted with the wrong env. The canonical failure: an app
 * started WITHOUT `MESSAGING_RECORD_OUTBOX=1` has no outbox-recording wrapper,
 * so every outbound send silently skips the dev-outbox and `outbox.spec.ts`
 * fails with a mystifying `Received: 0` — with nothing in the spec output
 * pointing at the real cause (the stack, not the code). This preflight queries
 * `/__dev/ping` (which echoes the stack's config flags) and turns that class of
 * failure into a single, ACTIONABLE error before any spec runs.
 */
const EXPECTED = {
  recordOutbox: true,
  messagingDriver: 'twilio',
  smsSendingEnabled: true,
} as const;

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? process.env['E2E_BASE_URL'] ?? 'http://localhost:5174';
  const url = `${baseURL}/__dev/ping`;

  let ping: Record<string, unknown>;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    ping = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `e2e preflight: could not reach ${url} (${String(err)}). The stack must be up with the ` +
        `dev endpoints enabled (DEV_AUTH_ENABLED=1). The launcher scripts/e2e-session.mjs sets this.`,
    );
  }

  const mismatches = Object.entries(EXPECTED).filter(([key, want]) => ping[key] !== want);
  if (mismatches.length > 0) {
    const detail = mismatches
      .map(([key, want]) => `  - ${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(ping[key])}`)
      .join('\n');
    throw new Error(
      `e2e preflight: the stack on ${baseURL} is NOT the hermetic e2e stack (or is stale):\n` +
        `${detail}\n\n` +
        `Playwright reuses an already-running server (reuseExistingServer), so a session started ` +
        `by hand or with the wrong env gets reused SILENTLY. Fix: stop it with \`npm run e2e:stop\` ` +
        `(plus any stray app on :8080/:5174/:8889) and re-run — the launcher (scripts/e2e-session.mjs) ` +
        `bakes in the correct env. Note: recordOutbox=false means NO outbox recording, which makes ` +
        `outbox.spec.ts fail with "Received: 0".`,
    );
  }
}
