// System Status routes (M1.4, doc §6) — the admin-only Settings → System Status
// panel's backend. Mounted under /api/system (behind requireAuth via the /api
// mount); every route ALSO requires the admin role (mirrors adminUsers.ts), so
// a VA gets 403 on all of them. The tab is admin-only + route-guarded too.
//
//   GET /api/system/flags             → 200 { ...flags }            (config only, no AWS)
//   GET /api/system/alarms            → 200 { available, alarms? | reason? }
//   GET /api/system/errors?since=…    → 200 { available, events?  | reason? }
//   GET /api/system/errors/detail?ref=...  -> 200 { available, record? | reason? }
//   GET /api/system/trace?<idKind>=...&at=...  -> 200 { available, lines? | reason? }
//
// Alarms/errors degrade gracefully ({ available: false, reason } at HTTP 200)
// when AWS is unreachable (local/hermetic) or a CloudWatch read throws — the
// UI then shows "available in deployed environments." Flags always work.
//
// PII (doc §9): log IDs/counts/reasons ONLY. Flags are booleans/enums/strings
// and carry no CONTACT's phone number; the ONE phone number they do carry is
// deliberate - our OWN business number (BUSINESS_PHONE_NUMBER), which is
// printed on public flyers, omitted when unconfigured, and never logged here.
// What these routes RETURN is a separate question (doc section 2, HUMAN
// DECISION 2026-08-24): every route here is ADMIN-ONLY, enforced SERVER-side,
// and the /errors, /errors/detail and /trace responses MAY carry contact PII -
// phone numbers, names, message text - plus host operational data. That is
// deliberate, because an admin already has access to the underlying logs.
// CREDENTIALS are the one exclusion, enforced by the detail path's `err`
// allowlist in the adapter.
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

  // GET /api/system/errors?since=1h|24h|7d - recent error events (admin-only;
  // a row may carry PII) or a degraded notice. Default 24h; an
  // explicitly-invalid `since` is a 400.
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
    // Opt-in "include warnings" firehose (?warnings=true|1). Any other value =
    // off (errors-only, the default). Twilio delivery failures show either way.
    const rawWarnings = req.query['warnings'];
    const includeWarnings = rawWarnings === 'true' || rawWarnings === '1';
    const result = await service.getErrors(window, { includeWarnings });
    if (result.available) {
      res.json({ available: true, events: result.events });
      return;
    }
    log.info({ window, reason: result.reason }, 'system status: errors degraded');
    res.json({ available: false, reason: result.reason });
  });

  // GET /api/system/errors/detail?ref=... - the complete log record behind one
  // row. A MISSING ref is a 400 (matching the `since` precedent); a PRESENT but
  // malformed one takes the degraded 200, like every other failure here.
  router.get('/errors/detail', async (req, res) => {
    const ref = req.query['ref'];
    if (typeof ref !== 'string' || ref.length === 0) {
      res.status(400).json({ error: 'ref is required' });
      return;
    }
    res.json(await service.getErrorDetail(ref));
  });

  const TRACE_ID_KINDS = ['correlationId', 'requestId', 'pollRunId'] as const;

  // The SHAPE the 400 below promises. Date.parse alone also accepts "1 Jan 2020"
  // and other implementation-defined forms, which would make the message a lie
  // about what this route takes; the prefix test plus a non-NaN parse keeps the
  // two honest. Deliberately a PREFIX (through the minutes), so seconds,
  // milliseconds and any zone suffix stay optional - the dashboard sends a full
  // toISOString(), and narrowing further would refuse a legitimate anchor.
  const ISO_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  // GET /api/system/trace - the lines around one failure. Exactly one id kind
  // plus a required `at` anchor; MISSING or ambiguous parameters are a 400
  // (matching `since`), while a present-but-malformed id degrades at 200.
  router.get('/trace', async (req, res) => {
    const present = TRACE_ID_KINDS.filter((k) => typeof req.query[k] === 'string');
    if (present.length !== 1) {
      res.status(400).json({ error: 'exactly one of correlationId, requestId, pollRunId is required' });
      return;
    }
    const rawAt = req.query['at'];
    const atMs =
      typeof rawAt === 'string' && ISO_AT_PATTERN.test(rawAt) ? Date.parse(rawAt) : Number.NaN;
    if (Number.isNaN(atMs)) {
      res.status(400).json({ error: 'at must be an ISO 8601 timestamp' });
      return;
    }
    const kind = present[0]!;
    res.json(await service.getTrace(kind, String(req.query[kind]), atMs));
  });

  return router;
}
