// Web Push routes (M1.4), mounted under /api (so behind sessionMiddleware +
// requireAuth + csrfOrigin — see app.ts). The dashboard PWA uses these to
// register a device for push and to fetch the VAPID public key it needs to
// subscribe in the browser.
//
//   GET    /api/push/vapid-public-key   → { publicKey }            (so the SW can subscribe)
//   POST   /api/push/subscriptions      { subscription } → 201     (store on the caller's user)
//   DELETE /api/push/subscriptions      { endpoint }     → 204     (remove one device)
//   POST   /api/push/test               → 200 { ...result }        (🖐 verification — self test send)
//
// When VAPID is unconfigured every route 503s `push_not_configured` (push is
// a feature, not core; the app still boots and texts/calls work).
//
// PII (doc §9): a subscription's endpoint is a push-service URL carrying a
// device token — it is never logged here (the repo logs counts only).
import { Router } from 'express';
import { isAllowedPushEndpoint } from '../adapters/webPush.js';
import { isPushConfigured, loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { createPushService, type PushService } from '../services/pushService.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  createUsersRepo,
  type PushSubscriptionRecord,
  type UsersRepo,
} from '../repos/usersRepo.js';

export interface PushRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  usersRepo?: UsersRepo;
  pushService?: PushService;
}

/** Length caps on the stored fields (L2): an endpoint URL and the two device
 * keys are short in practice; caps keep a hostile client from inflating the
 * user item. 2KB endpoint is generous (real ones are ~150 chars); 256 per key
 * comfortably covers a p256dh (~88 b64) / auth (~24 b64). */
const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 256;

/** parseSubscription outcome: the record, or a specific reason for the 400. */
type ParseSubscriptionResult =
  | { ok: true; record: PushSubscriptionRecord }
  | { ok: false; reason: 'shape' | 'host' | 'length' };

/**
 * Validate the browser PushSubscription shape: endpoint + keys.{p256dh,auth},
 * all strings, length-capped (L2), and — critically (C1) — the endpoint HOST
 * must be a known web-push vendor (isAllowedPushEndpoint) so a stored endpoint
 * can never aim a later send at an internal/attacker address (SSRF).
 */
function parseSubscription(raw: unknown): ParseSubscriptionResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'shape' };
  const sub = raw as Record<string, unknown>;
  const endpoint = sub['endpoint'];
  const keys = sub['keys'];
  if (typeof endpoint !== 'string' || endpoint.length === 0) return { ok: false, reason: 'shape' };
  if (typeof keys !== 'object' || keys === null) return { ok: false, reason: 'shape' };
  const k = keys as Record<string, unknown>;
  if (typeof k['p256dh'] !== 'string' || typeof k['auth'] !== 'string') {
    return { ok: false, reason: 'shape' };
  }
  // L2: cap the stored lengths before anything else touches them.
  if (
    endpoint.length > MAX_ENDPOINT_LENGTH ||
    k['p256dh'].length > MAX_KEY_LENGTH ||
    k['auth'].length > MAX_KEY_LENGTH
  ) {
    return { ok: false, reason: 'length' };
  }
  // C1: the endpoint must be an https URL whose host is a known push-service
  // vendor — rejects IPs, loopback, link-local, private ranges, http://, and
  // arbitrary attacker hosts.
  if (!isAllowedPushEndpoint(endpoint)) return { ok: false, reason: 'host' };
  return {
    ok: true,
    record: {
      endpoint,
      keys: { p256dh: k['p256dh'], auth: k['auth'] },
      created_at: new Date().toISOString(),
    },
  };
}

export function createPushRouter(deps: PushRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const pushService =
    deps.pushService ?? createPushService({ config, logger: deps.logger, usersRepo: users });

  const router = Router();

  // 503 every push route when VAPID is unconfigured — push is a feature.
  router.use((_req, res, next) => {
    if (!isPushConfigured(config)) {
      res.status(503).json({ error: 'push_not_configured' });
      return;
    }
    next();
  });

  // GET /api/push/vapid-public-key — the key the SW passes to pushManager.subscribe.
  router.get('/vapid-public-key', (_req, res) => {
    res.json({ publicKey: config.vapidPublicKey });
  });

  // POST /api/push/subscriptions { subscription } — store on the caller's user.
  router.post('/subscriptions', async (req: AuthedRequest, res) => {
    const userId = req.user?.userId;
    if (userId === undefined) {
      // requireAuth guarantees a user upstream — defensive only.
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const payload = (req.body ?? {}) as { subscription?: unknown };
    const parsed = parseSubscription(payload.subscription);
    if (!parsed.ok) {
      const error =
        parsed.reason === 'host'
          ? 'invalid push endpoint host'
          : parsed.reason === 'length'
            ? 'subscription endpoint/keys exceed the allowed length'
            : 'subscription must be { endpoint: https url, keys: { p256dh, auth } }';
      res.status(400).json({ error });
      return;
    }
    const subscriptions = await users.addPushSubscription(userId, parsed.record);
    res.status(201).json({ subscriptionCount: subscriptions.length });
  });

  // DELETE /api/push/subscriptions { endpoint } — remove one device.
  router.delete('/subscriptions', async (req: AuthedRequest, res) => {
    const userId = req.user?.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const payload = (req.body ?? {}) as { endpoint?: unknown };
    const endpoint = payload.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      res.status(400).json({ error: 'endpoint (non-empty string) is required' });
      return;
    }
    await users.removePushSubscription(userId, endpoint);
    res.status(204).end();
  });

  // POST /api/push/test — send a test notification to the caller's OWN
  // devices (the 🖐 verification path). Returns the per-call tally.
  router.post('/test', async (req: AuthedRequest, res) => {
    const userId = req.user?.userId;
    if (userId === undefined) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const result = await pushService.sendToUser(userId, {
      kind: 'test',
      payload: {
        title: 'HousingChoice',
        body: 'Test notification — push is working.',
        data: { kind: 'test' },
      },
    });
    log.info({ userId, ...result }, 'push test send');
    res.json(result);
  });

  return router;
}
