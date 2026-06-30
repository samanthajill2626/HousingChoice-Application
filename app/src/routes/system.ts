// System Status routes (M1.4, doc §6) — the admin-only Settings → System Status
// panel's backend. Mounted under /api/system (behind requireAuth via the /api
// mount); every route ALSO requires the admin role (mirrors adminUsers.ts), so
// a VA gets 403 on all of them. The tab is admin-only + route-guarded too.
//
//   GET /api/system/flags             → 200 { ...flags }            (config only, no AWS)
//   GET /api/system/alarms            → 200 { available, alarms? | reason? }
//   GET /api/system/errors?since=…    → 200 { available, events?  | reason? }
//
// Alarms/errors degrade gracefully ({ available: false, reason } at HTTP 200)
// when AWS is unreachable (local/hermetic) or a CloudWatch read throws — the
// UI then shows "available in deployed environments." Flags always work.
//
// PII (doc §9): log IDs/counts/reasons ONLY. Flags are booleans/enums/strings;
// the errors projection is message + correlationId (+ timestamp/level) only.
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { requireRole } from '../middleware/auth.js';
import {
  createSystemStatusService,
  isSystemErrorWindow,
  type SystemStatusService,
} from '../services/systemStatus.js';

export interface SystemRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  /** Test seam: injected service (no AWS). Defaults to the real config-driven service. */
  systemStatusService?: SystemStatusService;
}

export function createSystemRouter(deps: SystemRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const service =
    deps.systemStatusService ?? createSystemStatusService({ config, logger: deps.logger });

  const router = Router();

  // Every route here is admin-only (a VA gets 403).
  router.use(requireRole('admin'));

  // GET /api/system/flags — go-live readiness from runtime config (no AWS call).
  router.get('/flags', (_req, res) => {
    res.json(service.getFlags());
  });

  // GET /api/system/alarms — CloudWatch alarms (ALARM-first) or a degraded
  // notice. Always HTTP 200; `available` distinguishes the two.
  router.get('/alarms', async (_req, res) => {
    const result = await service.getAlarms();
    if (result.available) {
      res.json({ available: true, alarms: result.alarms });
      return;
    }
    res.json({ available: false, reason: result.reason });
  });

  // GET /api/system/errors?since=1h|24h|7d — recent error events (PII-safe) or a
  // degraded notice. Default 24h; an explicitly-invalid `since` is a 400.
  router.get('/errors', async (req, res) => {
    const rawSince = req.query['since'];
    let window: '1h' | '24h' | '7d' = '24h';
    if (rawSince !== undefined) {
      if (!isSystemErrorWindow(rawSince)) {
        res.status(400).json({ error: 'since must be one of: 1h, 24h, 7d' });
        return;
      }
      window = rawSince;
    }
    const result = await service.getErrors(window);
    if (result.available) {
      res.json({ available: true, events: result.events });
      return;
    }
    log.info({ window, reason: result.reason }, 'system status: errors degraded');
    res.json({ available: false, reason: result.reason });
  });

  return router;
}
