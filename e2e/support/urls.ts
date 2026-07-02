/**
 * Central e2e URL module — resolved ONCE from env with 127.0.0.1 lane-0 fallbacks.
 *
 * playwright.config.ts sets these env vars before any test worker or fixture
 * code runs (Task 2). This module centralises the read so support/ and fixture
 * files don't each repeat the same process.env look-up with inline fallbacks.
 *
 * CONVENTION: 127.0.0.1 everywhere — never bare 'localhost'. Vite defaults
 * localhost → ::1 (IPv6); a 127.0.0.1 probe misses that and causes
 * ERR_CONNECTION_REFUSED. Force IPv4 throughout the lane stack.
 *
 * Lane-0 fallbacks match the dev ports (npm run dev) and are only reached when
 * running specs outside the e2e harness (rare, not recommended).
 */

/** Express/Node app server URL for this lane (e.g. http://127.0.0.1:9101). */
export const appUrl: string = process.env['E2E_APP_URL'] ?? 'http://127.0.0.1:8080';

/** Vite dashboard dev-server URL for this lane (e.g. http://127.0.0.1:9111). */
export const dashboardUrl: string = process.env['E2E_DASHBOARD_URL'] ?? 'http://127.0.0.1:5174';

/** Fake-Twilio host URL for this lane (e.g. http://127.0.0.1:9121). */
export const fakeUrl: string =
  process.env['E2E_FAKE_URL'] ?? process.env['FAKE_TWILIO_URL'] ?? 'http://127.0.0.1:8889';

/**
 * Public-facing base URL for this lane — used for Twilio webhook signing and
 * signature verification (must match on both app and fake sides).
 * (e.g. http://127.0.0.1:9131)
 */
export const publicBaseUrl: string = process.env['PUBLIC_BASE_URL'] ?? 'http://127.0.0.1:5173';
