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

/** Validate the browser PushSubscription shape: endpoint + keys.{p256dh,auth}, all strings. */
function parseSubscription(raw: unknown): PushSubscriptionRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const sub = raw as Record<string, unknown>;
  const endpoint = sub['endpoint'];
  const keys = sub['keys'];
  if (typeof endpoint !== 'string' || endpoint.length === 0) return undefined;
  // Endpoint must be an https URL (push services are always https) — rejects
  // a client trying to register a junk/file endpoint.
  if (!/^https:\/\//.test(endpoint)) return undefined;
  if (typeof keys !== 'object' || keys === null) return undefined;
  const k = keys as Record<string, unknown>;
  if (typeof k['p256dh'] !== 'string' || typeof k['auth'] !== 'string') return undefined;
  return {
    endpoint,
    keys: { p256dh: k['p256dh'], auth: k['auth'] },
    created_at: new Date().toISOString(),
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
    const subscription = parseSubscription(payload.subscription);
    if (subscription === undefined) {
      res.status(400).json({
        error: 'subscription must be { endpoint: https url, keys: { p256dh, auth } }',
      });
      return;
    }
    const subscriptions = await users.addPushSubscription(userId, subscription);
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
