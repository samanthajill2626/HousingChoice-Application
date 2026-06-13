// WebPushAdapter — the ONLY place the `web-push` SDK is imported (adapter
// rule). Wraps web-push.sendNotification with VAPID configured from
// AppConfig, and maps the two "the subscription is dead, prune it" upstream
// responses (404 Not Found / 410 Gone) onto a typed GoneSubscription signal
// so the caller (services/pushService) can remove the stored subscription.
//
// PII posture (doc §9): this adapter NEVER logs payload bodies — a push
// payload carries a contact's name/address (the pre-ring "Keisha Jones —
// tenant, 123 Main St" context, CO2 §7.1). Logging is the service's job and
// is restricted to userId + a notification "kind" there; this layer logs
// nothing with PII.
//
// Push is a FEATURE, not core (CO2 / M1.4 brief): when VAPID is unconfigured
// the factory returns undefined and callers no-op. Texting/calls never depend
// on this.
import webpush, { type PushSubscription, WebPushError } from 'web-push';
import { isPushConfigured, type AppConfig } from '../lib/config.js';

/** The browser PushSubscription shape (re-exported so callers avoid the SDK import). */
export type { PushSubscription } from 'web-push';

/**
 * Outcome of a single send. `gone` = the push service reported the
 * subscription dead (404/410) — the caller MUST prune it. `sent` = accepted.
 * Any OTHER failure (transient 5xx, network) throws — those are not prune
 * signals and the caller decides whether to swallow or surface them.
 */
export type SendOutcome = { result: 'sent'; statusCode: number } | { result: 'gone' };

export interface WebPushAdapter {
  /**
   * Send one notification. `payload` is a pre-serialized string (the service
   * builds it) — kept opaque here so this layer can never accidentally log a
   * field. Resolves to {result:'gone'} for 404/410, {result:'sent'} on 2xx;
   * throws WebPushError/network errors otherwise.
   */
  sendToSubscription(subscription: PushSubscription, payload: string): Promise<SendOutcome>;
}

/** HTTP statuses from a push service that mean "this subscription is dead — prune it". */
const GONE_STATUSES = new Set([404, 410]);

/**
 * SSRF guard (M1.4 security review C1): a browser hands us whatever `endpoint`
 * URL it likes, and web-push later POSTs to it — so an attacker who can store a
 * subscription (POST /api/push/subscriptions, or a missed-call push in M1.9)
 * could aim our server at an internal address (169.254.169.254, localhost, an
 * RFC-1918 host) unless we constrain it. The real push services live on a tiny
 * set of vendor domains, so we ALLOWLIST those rather than try to blocklist
 * every internal range. A hostname is accepted only when it equals or is a
 * subdomain of one of these suffixes:
 *   - googleapis.com   FCM:     fcm.googleapis.com
 *   - mozilla.com / mozaws.net  Mozilla autopush: updates.push.services.mozilla.com
 *   - windows.com      WNS:     *.notify.windows.com
 *   - apple.com        Apple:   *.push.apple.com
 * Everything else — IP literals, loopback, link-local, private ranges, an
 * arbitrary attacker host, and any non-https scheme — is rejected.
 */
const ALLOWED_PUSH_ENDPOINT_SUFFIXES: readonly string[] = [
  'googleapis.com',
  'mozilla.com',
  'mozaws.net',
  'windows.com',
  'apple.com',
] as const;

/** A hostname matches a suffix when it equals it or ends in `.<suffix>` (a true subdomain). */
function hostnameMatchesSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/**
 * Pure, testable SSRF allowlist check for a stored push endpoint. Returns true
 * ONLY for an https URL whose hostname is one of the known web-push vendor
 * domains (above). Enforced BOTH at subscribe time (routes/push.ts) AND
 * defensively before every send (services/pushService.ts) — defense in depth,
 * so a bad endpoint stored before this guard existed is still never POSTed to.
 */
export function isAllowedPushEndpoint(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }
  // Push services are always https; this also rejects http://, file://, etc.
  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  // An IPv6 literal (URL keeps the brackets in hostname) or an IPv4 literal is
  // never a vendor domain — the suffix check below would reject them anyway,
  // but bail explicitly so the intent is unmistakable.
  if (hostname.length === 0) return false;
  return ALLOWED_PUSH_ENDPOINT_SUFFIXES.some((suffix) => hostnameMatchesSuffix(hostname, suffix));
}

/**
 * Build the adapter, or undefined when VAPID is unconfigured (push off).
 *
 * Deliberately does NOT call the process-global `setVapidDetails` at
 * construction: that helper VALIDATES the key length eagerly and throws, which
 * would crash app boot if a VAPID value were malformed — but push is a
 * FEATURE, not core (the app must still boot and text/call). Instead the
 * keys are passed per-send via `vapidDetails`, so a bad key surfaces only as a
 * failed send (the pushService swallows it), never as a boot failure.
 */
export function createWebPushAdapter(config: AppConfig): WebPushAdapter | undefined {
  if (!isPushConfigured(config)) return undefined;
  // Non-null: isPushConfigured guarantees all three are present.
  const vapidDetails = {
    subject: config.vapidSubject as string,
    publicKey: config.vapidPublicKey as string,
    privateKey: config.vapidPrivateKey as string,
  };

  return {
    async sendToSubscription(subscription, payload) {
      // Defense in depth (C1): never POST to an endpoint that isn't a known
      // web-push vendor host, even if a bad one was stored before the guard.
      // Treat it as a dead subscription so the caller prunes it.
      if (!isAllowedPushEndpoint(subscription.endpoint)) {
        return { result: 'gone' };
      }
      try {
        const res = await webpush.sendNotification(subscription, payload, { vapidDetails });
        return { result: 'sent', statusCode: res.statusCode };
      } catch (err) {
        if (err instanceof WebPushError && GONE_STATUSES.has(err.statusCode)) {
          return { result: 'gone' };
        }
        throw err;
      }
    },
  };
}
