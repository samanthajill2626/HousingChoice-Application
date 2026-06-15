// Dev-only router. Mounted ONLY when DEV_AUTH_ENABLED is truthy AND
// NODE_ENV !== 'production' (gated by lib/devRoutes.ts; config.ts fails fast if
// the flag is ever set in production). Exposes a liveness probe and a dev-login
// that mints a REAL session for a seeded user, mirroring the OAuth callback.
// Also exposes the recorded-message outbox and reseed for e2e testing.
import { Router, json } from 'express';
import { ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig, tableName, type AppConfig } from '../lib/config.js';
import { createDocumentClient } from '../lib/dynamo.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { sealSession, sessionCookieOptions } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../lib/sessionCookie.js';
import { createUsersRepo, sessionEpochOf, type UsersRepo } from '../repos/usersRepo.js';
import { OUTBOX_TABLE_BASE, type OutboxRecord } from '../adapters/recordingMessaging.js';
import { resetLocalData } from '../lib/devReset.js';

export interface DevRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  usersRepo?: UsersRepo;
  doc?: DynamoDBDocumentClient;
}

export function createDevRouter(deps: DevRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const doc = deps.doc ?? createDocumentClient({ config });
  const router = Router();

  // GET /__dev/ping — confirms the dev endpoints are active (stack-identity probe).
  router.get('/__dev/ping', (_req, res) => {
    res.status(200).json({ dev: true });
  });

  // POST /auth/dev-login — mint a session for a seeded user without Google.
  // Mirrors the OAuth callback's session minting exactly (same seal + cookie
  // options), so the resulting session is indistinguishable from a real login.
  // json() is scoped to this route only — no global body-parsing side-effects.
  router.post('/auth/dev-login', json(), async (req, res) => {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' && body.email.trim() ? body.email : 'va@example.com';
    const user = await users.findByEmail(email);
    if (!user) {
      res.status(404).json({ error: 'unknown_dev_user', email });
      return;
    }
    res.cookie(
      SESSION_COOKIE_NAME,
      sealSession({ userId: user.userId, email: user.email, role: user.role }, config, {
        epoch: sessionEpochOf(user),
      }),
      sessionCookieOptions(config),
    );
    log.info({ email: user.email, role: user.role }, 'dev-login minted a session');
    res.status(200).json({ userId: user.userId, email: user.email, role: user.role });
  });

  // GET /__dev/outbox?to=&since= — recorded outbound messages (newest last).
  router.get('/__dev/outbox', async (req, res) => {
    const table = tableName(OUTBOX_TABLE_BASE);
    let items: OutboxRecord[] = [];
    try {
      const out = await doc.send(new ScanCommand({ TableName: table }));
      items = (out.Items ?? []) as OutboxRecord[];
    } catch {
      items = []; // table not created yet (nothing sent) — empty outbox
    }
    const to = typeof req.query['to'] === 'string' ? req.query['to'] : undefined;
    const since = typeof req.query['since'] === 'string' ? req.query['since'] : undefined;
    if (to) items = items.filter((m) => m.to === to);
    if (since) items = items.filter((m) => m.createdAt >= since);
    items.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    res.status(200).json({ messages: items });
  });

  // POST /__dev/reseed — wipe local tables (incl. outbox) and re-seed.
  router.post('/__dev/reseed', async (_req, res) => {
    await resetLocalData({ config, logger: log });
    res.status(200).json({ ok: true });
  });

  return router;
}
