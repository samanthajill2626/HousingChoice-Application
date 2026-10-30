// Rankings API (WP1 B2a spec D12; charter 10.2) - admin AND va: these routes
// sit behind the /api mount's requireAuth only, as the composer does
// (routes/broadcasts.ts header). Only /api/admin/rankings is admin-only.
//
//   POST /api/rankings/:anchorKind/:anchorId/rank  { includeOlder?: boolean }
//        -> 202 { job, joined } | 400 | 404 anchor_not_found | 409 ranking_running | 429 rate_limited
//   GET  /api/rankings/:anchorKind/:anchorId?includeOlder=true|false
//        -> 200 { anchor, job, rows, flags, poolWindowDays[, poolTooLarge] } | 400 | 404 | 503 ranking_unavailable
//        (`flags` is a property anchor's own open flags; [] for a tenant anchor - spec D10 rev 7)
//   GET  /api/rankings/:anchorKind/:anchorId/job
//        -> 200 { job: RankingJobView | null } | 400        (what the page polls)
//   GET  /api/rankings/unit/:unitId/flags
//        -> 200 { flags: [{ field, label, reason }] } | 400 invalid_anchor_kind (a tenant)
//           | 404 anchor_not_found (missing or soft-deleted) | 503 flags_unavailable
//        The property page's read-only fair-housing notice (spec D10 rev 7,
//        charter item 16; services/ranking/propertyFlags.ts): the property's
//        OPEN flags by the one open rule, its unit read consistently.
//
// The rank POST - and only it - sits behind a per-USER sliding-window limiter
// (RATE_LIMIT_RANK_PER_MIN): ONE createUserRateLimit instance created with the
// router and placed ahead of the handler, exactly as the broadcast send
// limiter is (routes/broadcasts.ts), so a limited press writes nothing. Reads
// and the job poll stay unmetered (the page polls the job every 5 s).
//
// The press carries its correlation into the job record: the request's
// requestId (middleware/correlation.ts) and currentTraceparent() - the rule
// job envelopes use (jobs/jobs.ts) - so the job's log lines, run later in a
// fresh context carrying both (services/ranking/job.ts), correlate to this
// request. The 404 is S3's one anchor-exists rule (PR21). PII: log ids only.
import { Router, type Request } from 'express';
import type { AppConfig } from '../lib/config.js';
import { currentTraceparent, getContext, newRequestId } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createRankingRunsRepo, type RankingJobRecord, type RankingRunsRepo } from '../repos/rankingRunsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { claimRanking, jobView, MSG_RUNNING, type ClaimResult, type RankingPress } from '../services/ranking/job.js';
import { rankingAnchorExists } from '../services/ranking/pool.js';
import { readPropertyFlags } from '../services/ranking/propertyFlags.js';
import {
  createRankingReadDeps,
  readRanking,
  type RankingRead,
  type RankingReadDeps,
} from '../services/ranking/readRanking.js';
import type { AnchorRef } from '../services/ranking/types.js';

export interface RankingsRouterDeps {
  config: AppConfig;
  logger?: Logger;
  /**
   * The /api mount's shared repos (default wiring for the 404 check and the
   * property flag read: its unit read and, switch on, its landlord read).
   */
  contactsRepo?: Pick<ContactsRepo, 'getById' | 'getManyByIds'>;
  unitsRepo?: Pick<UnitsRepo, 'getById'>;
  /** The property flag read's flag records; the router's own rankingRunsRepo otherwise. */
  flagsRepo?: Pick<RankingRunsRepo, 'getOpenCandidateFlags'>;
  /** Test seams; the real claim / read / job read otherwise. */
  claim?(anchor: AnchorRef, press: RankingPress): Promise<ClaimResult>;
  read?(anchor: AnchorRef, opts: { includeOlder: boolean; now: Date }): Promise<RankingRead>;
  getJob?(anchor: AnchorRef): Promise<RankingJobRecord | undefined>;
  now?(): Date;
}

type AnchorParse = { ok: true; anchor: AnchorRef } | { ok: false; error: 'invalid_anchor_kind' | 'invalid_anchor_id' };

function parseAnchor(req: Request): AnchorParse {
  const kind = String(req.params['anchorKind'] ?? '');
  // Typed input is trimmed before store or compare (Cameron's standing rule).
  const id = String(req.params['anchorId'] ?? '').trim();
  if (kind !== 'unit' && kind !== 'tenant') return { ok: false, error: 'invalid_anchor_kind' };
  if (id.length === 0) return { ok: false, error: 'invalid_anchor_id' };
  return { ok: true, anchor: { kind, id } };
}

function parseIncludeOlderQuery(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

export function createRankingsRouter(deps: RankingsRouterDeps): Router {
  const { config } = deps;
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? ((): Date => new Date());
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  // A client object only; no request is made until a route reads it.
  const jobs = createRankingRunsRepo({ logger: deps.logger });
  let readDeps: RankingReadDeps | undefined;

  const claim =
    deps.claim ??
    ((anchor: AnchorRef, press: RankingPress): Promise<ClaimResult> =>
      claimRanking(anchor, press, {
        jobs,
        anchorExists: (a) => rankingAnchorExists(a, { contacts, units }),
        config,
        now: () => now().toISOString(),
      }));
  const read =
    deps.read ??
    ((anchor: AnchorRef, opts: { includeOlder: boolean; now: Date }): Promise<RankingRead> => {
      readDeps ??= createRankingReadDeps({ config, logger: log });
      return readRanking(anchor, opts, readDeps);
    });
  const getJob =
    deps.getJob ??
    ((anchor: AnchorRef): Promise<RankingJobRecord | undefined> =>
      jobs.getJob(anchor.kind, anchor.id, { consistent: true }));

  const router = Router();

  const rankLimiter = createUserRateLimit({
    routeKey: 'ranking_rank',
    max: config.rateLimitRankPerMin,
    windowMs: 60_000,
    logger: log,
  });

  router.post('/:anchorKind/:anchorId/rank', rankLimiter, async (req, res) => {
    const parsed = parseAnchor(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const body = (req.body ?? {}) as { includeOlder?: unknown };
    if (body.includeOlder !== undefined && typeof body.includeOlder !== 'boolean') {
      res.status(400).json({ error: 'invalid_include_older' });
      return;
    }
    const press: RankingPress = {
      includeOlder: body.includeOlder === true,
      requestedBy: (req as AuthedRequest).user?.userId ?? 'unknown',
      requestId: getContext()?.requestId ?? newRequestId(),
      traceparent: currentTraceparent(),
    };
    const result = await claim(parsed.anchor, press);
    if (result.status === 404) {
      res.status(404).json({ error: 'anchor_not_found' });
      return;
    }
    if (result.status === 409) {
      res.status(409).json({ error: 'ranking_running', message: MSG_RUNNING });
      return;
    }
    log.info(
      { anchorKind: parsed.anchor.kind, anchorId: parsed.anchor.id, joined: result.joined, generation: result.job.generation },
      'ranking press',
    );
    res.status(202).json({ job: jobView(result.job, now().toISOString()), joined: result.joined });
  });

  router.get('/:anchorKind/:anchorId/job', async (req, res) => {
    const parsed = parseAnchor(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const record = await getJob(parsed.anchor);
    res.json({ job: record === undefined ? null : jobView(record, now().toISOString()) });
  });

  // The property page's fair-housing notice (spec D10 rev 7). A property
  // only: a tenant has no flags of its own.
  router.get('/:anchorKind/:anchorId/flags', async (req, res) => {
    const parsed = parseAnchor(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (parsed.anchor.kind !== 'unit') {
      res.status(400).json({ error: 'invalid_anchor_kind' });
      return;
    }
    const unitId = parsed.anchor.id;
    try {
      const result = await readPropertyFlags(unitId, {
        units,
        contacts,
        flags: deps.flagsRepo ?? jobs,
        config,
      });
      if (result.kind === 'not_found') {
        res.status(404).json({ error: 'anchor_not_found' });
        return;
      }
      res.json({ flags: result.flags });
    } catch (err) {
      // PII: ids only. The page shows a short note and keeps working.
      log.warn({ unitId, err }, 'property flag read failed');
      res.status(503).json({ error: 'flags_unavailable' });
    }
  });

  router.get('/:anchorKind/:anchorId', async (req, res) => {
    const parsed = parseAnchor(req);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const includeOlder = parseIncludeOlderQuery(req.query['includeOlder']);
    if (includeOlder === undefined) {
      res.status(400).json({ error: 'invalid_include_older' });
      return;
    }
    const result = await read(parsed.anchor, { includeOlder, now: now() });
    switch (result.kind) {
      case 'ok':
        res.json({
          anchor: result.anchor,
          job: result.job,
          rows: result.rows,
          flags: result.flags,
          poolWindowDays: result.poolWindowDays,
          ...(result.poolTooLarge !== undefined && { poolTooLarge: result.poolTooLarge }),
        });
        return;
      case 'not_found':
        res.status(404).json({ error: 'anchor_not_found' });
        return;
      case 'unavailable':
        res.status(503).json({ error: 'ranking_unavailable', message: result.message });
        return;
    }
  });

  return router;
}
