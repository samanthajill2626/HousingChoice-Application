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

/** How long to wait for the app to finish booting before giving up. */
const PREFLIGHT_DEADLINE_MS = 60_000;
const PREFLIGHT_POLL_MS = 1_000;

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? process.env['E2E_BASE_URL'] ?? 'http://localhost:5174';
  const url = `${baseURL}/__dev/ping`;

  // Poll until the app answers, rather than failing on the first miss. Playwright's
  // webServer readiness gate keys on Vite (:5174) being up, but the app (:8080, which
  // /__dev/ping proxies to) finishes booting a beat later — so a cold ONE-TERMINAL
  // `npm run e2e` can race ahead and hit ECONNREFUSED / a proxy 5xx. Retry those
  // (transient: app still booting) until a deadline; a genuine CONFIG mismatch below
  // still fails fast (it isn't a timing problem).
  let ping: Record<string, unknown> | undefined;
  let lastErr: unknown;
  const deadline = Date.now() + PREFLIGHT_DEADLINE_MS;
  for (;;) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
      ping = (await res.json()) as Record<string, unknown>;
      break;
    } catch (err) {
      lastErr = err;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, PREFLIGHT_POLL_MS));
    }
  }
  if (!ping) {
    throw new Error(
      `e2e preflight: could not reach ${url} within ${Math.round(PREFLIGHT_DEADLINE_MS / 1000)}s ` +
        `(${String(lastErr)}). The stack must be up with the dev endpoints enabled ` +
        `(DEV_AUTH_ENABLED=1). The launcher scripts/e2e-session.mjs sets this.`,
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
