// POST /internal/events - the cross-process event bridge, APP side (spec:
// docs/superpowers/specs/2026-07-20-event-bridge-design.md). The worker's
// forwarder (lib/eventBridge.ts) is the ONLY intended caller.
//
// Trust posture (three independent fences):
//   0. The CloudFront EDGE method allowlist (infra/modules/cloudfront/main.tf):
//      POST is allowed only on the /api/*, /webhooks/*, /auth/* behaviors; the
//      default behavior /internal/* falls to is GET/HEAD/OPTIONS-only, so a
//      public POST dies at the edge and never reaches the origin. This fence
//      is LOAD-BEARING but lives in Terraform - if a future behavior change
//      lets the default (or a broader path) accept POST, this route becomes
//      internet-reachable (still token-gated, but its 403-warn/log surface
//      opens; see docs/issues/event-bridge-hardening-followups.md item 5).
//   1. The locked middleware chain: this router mounts at the ROUTE stage, so
//      the CloudFront origin-secret validator (stage 2) already ran - a
//      direct-to-EC2 probe without CF_ORIGIN_SECRET died there.
//   2. x-bridge-token: HKDF-derived from SESSION_SECRET (lib/eventBridge.ts).
//      A via-CloudFront probe carries a valid origin stamp but can never
//      compute this token - CloudFront and browsers do not have it.
// NEVER mount this ahead of the origin validator, and NEVER under /api
// requireAuth (process-to-process: no session exists).
//
// The payload is passed through OPAQUELY: the peer is this same codebase
// authenticated by the token, so the route validates the event NAME against
// APP_EVENT_NAMES and the payload's SHAPE (plain object) only. Payloads are
// never logged (they may carry the conversation preview - PII, doc section 9).
import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';
import { APP_EVENT_NAMES, type AppEventMap, type AppEventName, type EventBus } from '../lib/events.js';
import { deriveBridgeToken } from '../lib/eventBridge.js';

const EVENT_NAME_SET: ReadonlySet<string> = new Set(APP_EVENT_NAMES);

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface InternalRouterDeps {
  config: AppConfig;
  /** MUST be the same bus instance the SSE route subscribes (buildApp resolves it). */
  events: EventBus;
  logger: Logger;
}

export function createInternalRouter(deps: InternalRouterDeps): Router {
  const { config, events, logger } = deps;
  const expectedToken = deriveBridgeToken(config.sessionSecret);
  const router = Router();

  router.post('/events', (req: Request, res: Response) => {
    const provided = req.headers['x-bridge-token'];
    if (typeof provided !== 'string' || !tokensMatch(provided, expectedToken)) {
      // NEVER log the provided value (mirrors middleware/originSecret.ts).
      logger.warn(
        {
          remoteIp: req.socket.remoteAddress ?? null,
          reason: typeof provided === 'string' ? 'bridge token mismatch' : 'bridge token missing',
        },
        'internal events post rejected',
      );
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const body: unknown = req.body;
    const name = (body as { name?: unknown } | null)?.name;
    const payload = (body as { payload?: unknown } | null)?.payload;
    if (
      typeof name !== 'string' ||
      !EVENT_NAME_SET.has(name) ||
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      res.status(400).json({ error: 'bad request' });
      return;
    }
    // The ONE narrowing seam: name is proven in APP_EVENT_NAMES and payload is
    // a plain object built by this same codebase's typed emit (worker side).
    events.emit(name as AppEventName, payload as AppEventMap[AppEventName]);
    res.status(204).end();
  });

  return router;
}
