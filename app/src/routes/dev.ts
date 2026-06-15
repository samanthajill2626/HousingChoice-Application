// Dev-only router. Mounted ONLY when DEV_AUTH_ENABLED is truthy AND
// NODE_ENV !== 'production' (gated by lib/devRoutes.ts; config.ts fails fast if
// the flag is ever set in production). Phase 1 exposes only a liveness/identity
// probe; later phases add dev-login, the recorded-message outbox, and reseed.
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';

export interface DevRouterDeps {
  logger?: Logger;
}

export function createDevRouter(deps: DevRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const router = Router();

  // GET /__dev/ping — confirms the dev endpoints are active. Tests and the e2e
  // harness use this to verify they are talking to a hermetic dev stack.
  router.get('/__dev/ping', (_req, res) => {
    res.status(200).json({ dev: true });
  });

  log.debug({ routes: ['/__dev/ping'] }, 'dev router mounted');
  return router;
}
