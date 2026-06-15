// Dev-only router. Mounted ONLY when DEV_AUTH_ENABLED is truthy AND
// NODE_ENV !== 'production' (gated by lib/devRoutes.ts; config.ts fails fast if
// the flag is ever set in production). Exposes a liveness probe and a dev-login
// that mints a REAL session for a seeded user, mirroring the OAuth callback.
// Later phases add the recorded-message outbox and reseed.
import express, { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { sealSession, sessionCookieOptions } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../lib/sessionCookie.js';
import { createUsersRepo, sessionEpochOf, type UsersRepo } from '../repos/usersRepo.js';

export interface DevRouterDeps {
  logger?: Logger;
  config?: AppConfig;
  usersRepo?: UsersRepo;
}

export function createDevRouter(deps: DevRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const users = deps.usersRepo ?? createUsersRepo({ logger: deps.logger });
  const router = Router();

  // Body parser for the dev router (mounted before the global body parsers in
  // app.ts, so we need our own). Only parses JSON for dev endpoints.
  router.use(express.json());

  // GET /__dev/ping — confirms the dev endpoints are active (stack-identity probe).
  router.get('/__dev/ping', (_req, res) => {
    res.status(200).json({ dev: true });
  });

  // POST /auth/dev-login — mint a session for a seeded user without Google.
  // Mirrors the OAuth callback's session minting exactly (same seal + cookie
  // options), so the resulting session is indistinguishable from a real login.
  router.post('/auth/dev-login', async (req, res) => {
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

  return router;
}
