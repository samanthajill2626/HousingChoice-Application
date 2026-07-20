// Cross-process event bridge, WORKER side (spec:
// docs/superpowers/specs/2026-07-20-event-bridge-design.md).
//
// attachEventBridge subscribes one listener per AppEventMap name on the
// worker's in-process bus and fire-and-forgets each emit to the app process's
// POST /internal/events (routes/internal.ts), which re-emits for its SSE
// clients. Best-effort BY DESIGN: 2s timeout, no retry, no queue - SSE is a
// refresh hint; dashboards reconcile via GET. Failures warn with the event
// NAME only (payloads may carry the conversation preview - PII posture, doc
// section 9: never logged).
//
// The bridge token is DERIVED from SESSION_SECRET (HKDF, distinct info label)
// so both processes - which share one .env - agree with ZERO new secret
// material. CloudFront/browsers can never compute it, which is what keeps the
// internal route internal (see routes/internal.ts for the full posture).
import { hkdfSync } from 'node:crypto';
import type { Logger } from './logger.js';
import { APP_EVENT_NAMES, type EventBus } from './events.js';

/** HKDF info label - a distinct subkey purpose, never reused elsewhere. */
const BRIDGE_HKDF_INFO = 'hc-event-bridge';

/** Derive the shared bridge token (hex, 32 bytes) from SESSION_SECRET. */
export function deriveBridgeToken(sessionSecret: string): string {
  return Buffer.from(hkdfSync('sha256', sessionSecret, '', BRIDGE_HKDF_INFO, 32)).toString('hex');
}

export interface AttachEventBridgeOptions {
  /** The app process's base URL (EVENT_BRIDGE_URL - http://app:8080 in compose). */
  targetUrl: string;
  /** deriveBridgeToken(config.sessionSecret). */
  bridgeToken: string;
  /** config.cfOriginSecret - passes the app's locked origin-secret chain. */
  originSecret: string;
  logger: Logger;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/** Forward every bus emit to the app process. Attach ONLY in worker.ts - the
 *  app process must never forward (no echo path exists by construction). */
export function attachEventBridge(bus: EventBus, opts: AttachEventBridgeOptions): void {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL('/internal/events', opts.targetUrl);
  for (const name of APP_EVENT_NAMES) {
    bus.on(name, (payload) => {
      // Detached on purpose: the emitting job must never wait on the bridge.
      void doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-origin-verify': opts.originSecret,
          'x-bridge-token': opts.bridgeToken,
        },
        body: JSON.stringify({ name, payload }),
        signal: AbortSignal.timeout(2000),
      })
        .then((res) => {
          if (!res.ok) {
            // Name + status only - NEVER the payload (PII posture above).
            opts.logger.warn({ event: name, status: res.status }, 'event bridge post rejected');
          }
        })
        .catch((err: unknown) => {
          opts.logger.warn({ event: name, err }, 'event bridge post failed');
        });
    });
  }
}
