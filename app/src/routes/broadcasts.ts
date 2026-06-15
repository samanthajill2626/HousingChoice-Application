// Share-broadcast ("Share Listings") router (M1.8a) — mounted under /api,
// behind requireAuth + CSRF via the /api mount (app.ts). VAs run share
// broadcasts day-to-day, so NO admin gate (same posture as contacts/units/
// relay-groups).
//
//   POST /api/broadcasts                 { unitId?, body_template, audience_filter } → 201 { broadcastId, status:'draft', estimatedCount }
//   POST /api/broadcasts/:id/preview                                                 → { count, sample:[{contactId, firstName?, phone}] }
//   POST /api/broadcasts/:id/send                                                    → { broadcastId, status:'sending', count } | 400 empty audience
//   GET  /api/broadcasts/:id/results                                                 → { broadcastId, status, stats, recipients }
//   GET  /api/broadcasts?status=&limit=                                              → { broadcasts:[...], nextCursor }
//
// Audience: TENANT 1:1 contacts ONLY (never relay-group rosters), filtered by
// housing authority and/or exact bedroom size; opted-out + unreachable are
// ALWAYS excluded. The send fans out through the SHARED A2P throttle (the
// broadcast.send job + worker a2pBucket).
//
// PII (doc §9): the preview RESPONSE carries phones (authed/internal — the
// operator needs to see who's in the audience), but LOG LINES never do — IDs/
// counts only. Bodies/templates are never logged.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { flyerUrl } from '../lib/mergeFields.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { BROADCAST_SEND_JOB } from '../jobs/broadcastFanOut.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createBroadcastsRepo,
  MAX_BROADCAST_RECIPIENTS,
  type AudienceFilter,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastsRepo,
  type BroadcastStatus,
} from '../repos/broadcastsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import {
  createAudienceResolutionService,
  type AudienceResolutionService,
} from '../services/audienceResolution.js';

/** The lifecycle statuses ?status= may filter on (byStatus GSI partition). */
const BROADCAST_STATUSES: ReadonlySet<string> = new Set<BroadcastStatus>([
  'draft',
  'sending',
  'sent',
  'failed',
]);

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
/** The preview returns at most this many sample contacts (the audience is bounded). */
const PREVIEW_SAMPLE_SIZE = 25;
/** Sane cap so a template body can't be used to store a huge blob. */
const MAX_TEMPLATE_LEN = 1600;

export interface BroadcastsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  broadcastsRepo?: BroadcastsRepo;
  unitsRepo?: UnitsRepo;
  auditRepo?: AuditRepo;
  audienceResolutionService?: AudienceResolutionService;
  events?: EventBus;
}

/**
 * Parse + validate an audience_filter from the request body. contact_type is
 * fixed 'tenant' for M1.8 (any other value is rejected — never relay rosters);
 * housing_authority/bedroomSize are optional narrowers; opt-out + unreachable
 * are ALWAYS excluded regardless of the request.
 */
function parseAudienceFilter(raw: unknown): AudienceFilter | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'audience_filter must be an object' };
  }
  const f = raw as Record<string, unknown>;
  // contact_type defaults to 'tenant'; if present it MUST be 'tenant'.
  if (f['contact_type'] !== undefined && f['contact_type'] !== 'tenant') {
    return { error: 'audience_filter.contact_type must be "tenant" (M1.8 targets tenants only)' };
  }
  let housing_authority: string | undefined;
  if (f['housing_authority'] !== undefined && f['housing_authority'] !== null) {
    if (typeof f['housing_authority'] !== 'string' || f['housing_authority'].trim().length === 0) {
      return { error: 'audience_filter.housing_authority must be a non-empty string' };
    }
    housing_authority = f['housing_authority'].trim();
  }
  let bedroomSize: number | undefined;
  if (f['bedroomSize'] !== undefined && f['bedroomSize'] !== null) {
    const v = f['bedroomSize'];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 12) {
      return { error: 'audience_filter.bedroomSize must be an integer 0..12' };
    }
    bedroomSize = v;
  }
  return {
    contact_type: 'tenant',
    ...(housing_authority !== undefined && { housing_authority }),
    ...(bedroomSize !== undefined && { bedroomSize }),
    excludeOptedOut: true,
    excludeUnreachable: true,
  };
}

/** Parse an optional ?limit= into 1..MAX_PAGE_LIMIT, or undefined when invalid. */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

/** Opaque base64url cursor over a DynamoDB LastEvaluatedKey (contacts.ts pattern). */
function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

/**
 * Decode a broadcasts-list cursor. The ExclusiveStartKey is the base-table key
 * (broadcastId) plus the queried GSI's keys (byStatus: status; byCreatedAt:
 * created_by, created_at) — a small flat scalar object (1..3 string attrs).
 * Validate the SHAPE before it becomes a DynamoDB key; a tampered cursor must
 * never reach DynamoDB malformed (returns undefined → 400 upstream).
 */
function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    const entries = Object.entries(key);
    if (entries.length < 1 || entries.length > 3) return undefined;
    for (const [, v] of entries) if (typeof v !== 'string') return undefined;
    return key;
  } catch {
    return undefined;
  }
}

/** The results-view projection of a broadcast (stats + recipients + lifecycle). */
function toBroadcastResults(b: BroadcastItem): Record<string, unknown> {
  return {
    broadcastId: b.broadcastId,
    status: b.status,
    unitId: b.unitId ?? null,
    audience_filter: b.audience_filter,
    stats: b.stats,
    recipients: b.recipients ?? {},
    ...(b.last_error !== undefined && { last_error: b.last_error }),
    created_at: b.created_at,
  };
}

/** The list-row summary (no recipients map — that's the results view). */
function toBroadcastSummary(b: BroadcastItem): Record<string, unknown> {
  return {
    broadcastId: b.broadcastId,
    status: b.status,
    unitId: b.unitId ?? null,
    audience_filter: b.audience_filter,
    stats: b.stats,
    created_at: b.created_at,
    created_by: b.created_by,
  };
}

export function createBroadcastsRouter(deps: BroadcastsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const broadcasts = deps.broadcastsRepo ?? createBroadcastsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const resolveAudience =
    deps.audienceResolutionService ?? createAudienceResolutionService({ logger: deps.logger });
  // NOTE: broadcast.updated SSE events are emitted from the broadcast.send job
  // (on completion) and the delivery-callback rollup — NOT this router — so the
  // `events` dep is accepted for API symmetry but not used here.

  const router = Router();

  // POST /api/broadcasts — create a DRAFT + estimate the audience (save-for-later).
  router.post('/broadcasts', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    const body = (req.body ?? {}) as {
      unitId?: unknown;
      body_template?: unknown;
      audience_filter?: unknown;
    };

    const template =
      typeof body.body_template === 'string' && body.body_template.trim().length > 0
        ? body.body_template
        : undefined;
    if (template === undefined) {
      res.status(400).json({ error: 'body_template (non-empty string) is required' });
      return;
    }
    if (template.length > MAX_TEMPLATE_LEN) {
      res.status(400).json({ error: `body_template exceeds ${MAX_TEMPLATE_LEN} chars` });
      return;
    }
    const filter = parseAudienceFilter(body.audience_filter ?? {});
    if ('error' in filter) {
      res.status(400).json({ error: filter.error });
      return;
    }
    let unitId: string | undefined;
    let flyer_url: string | undefined;
    if (body.unitId !== undefined && body.unitId !== null) {
      if (typeof body.unitId !== 'string' || body.unitId.length === 0) {
        res.status(400).json({ error: 'unitId must be a non-empty string' });
        return;
      }
      const unit = await units.getById(body.unitId);
      if (!unit) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      unitId = unit.unitId;
      flyer_url = flyerUrl(config.publicBaseUrl, unit.unitId);
    }

    // Estimate the audience now (save-for-later shows the operator the reach).
    const audience = await resolveAudience(filter);

    const created = await broadcasts.create({
      created_by: actor,
      audience_filter: filter,
      body_template: template,
      estimatedAudience: audience.count,
      ...(unitId !== undefined && { unitId }),
      ...(flyer_url !== undefined && { flyer_url }),
    });
    await audit.append(`broadcasts#${created.broadcastId}`, 'broadcast_created', {
      actor,
      ...(unitId !== undefined && { unitId }),
      estimatedCount: audience.count,
    });
    log.info(
      { broadcastId: created.broadcastId, estimatedCount: audience.count, actor },
      'broadcast draft created via api',
    );
    res.status(201).json({
      broadcastId: created.broadcastId,
      status: 'draft',
      estimatedCount: audience.count,
      // FIX 3+4: surface whether the estimate was truncated (page cap hit) so
      // the operator knows the draft's reach is incomplete before sending.
      truncated: audience.truncated,
    });
  });

  // POST /api/broadcasts/:id/preview — re-resolve the audience + a sample.
  router.post('/broadcasts/:broadcastId/preview', async (req, res) => {
    const { broadcastId } = req.params;
    mergeContext({});
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    const audience = await resolveAudience(broadcast.audience_filter);
    // The sample carries phones — authed/internal response only; NEVER logged.
    const sample = audience.contacts.slice(0, PREVIEW_SAMPLE_SIZE).map((c) => ({
      contactId: c.contactId,
      ...(c.firstName !== undefined && { firstName: c.firstName }),
      phone: c.phone,
    }));
    log.info(
      { broadcastId, count: audience.count, truncated: audience.truncated },
      'broadcast audience previewed',
    );
    // Surface `truncated` (FIX 3+4) so the operator sees an incomplete/over-cap
    // audience BEFORE sending (and the dashboard can warn).
    res.json({ count: audience.count, truncated: audience.truncated, sample });
  });

  // POST /api/broadcasts/:id/send — snapshot the audience, mark sending, enqueue.
  router.post('/broadcasts/:broadcastId/send', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    const { broadcastId } = req.params;
    mergeContext({});
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    if (broadcast.status !== 'draft') {
      // Only a draft may be sent — a sending/sent broadcast is not re-sendable.
      res.status(409).json({ error: 'broadcast_not_draft', status: broadcast.status });
      return;
    }

    // Re-resolve the audience snapshot at send time (the source of truth — the
    // draft estimate may be stale). Build the recipients map keyed by contactKey
    // (contactId else phone#<E164>, the shared convention), all 'queued'.
    const audience = await resolveAudience(broadcast.audience_filter);
    if (audience.count === 0) {
      // Empty audience: refuse clearly (no point marking a broadcast sending
      // with nobody to send to). Leave it a draft so the operator can adjust.
      res.status(400).json({ error: 'empty_audience' });
      return;
    }
    // Bound the audience (FIX 3+4): refuse when the resolved set exceeds the
    // recipients-map item-size cap, OR when resolution was truncated (page cap
    // hit → the set is INCOMPLETE; sending would silently under-deliver). Either
    // way leave the broadcast a DRAFT and do NOT enqueue — the operator must
    // narrow the bedroom/housing-authority filter.
    if (audience.count > MAX_BROADCAST_RECIPIENTS || audience.truncated) {
      log.warn(
        { broadcastId, count: audience.count, truncated: audience.truncated, cap: MAX_BROADCAST_RECIPIENTS },
        'broadcast send refused: audience too large',
      );
      res.status(400).json({
        error: 'audience_too_large',
        message: audience.truncated
          ? `audience resolution was truncated (more than ${MAX_BROADCAST_RECIPIENTS} candidates) — narrow the housing authority and/or bedroom-size filter`
          : `audience of ${audience.count} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap — narrow the housing authority and/or bedroom-size filter`,
        count: audience.count,
        truncated: audience.truncated,
      });
      return;
    }
    const recipients: Record<string, BroadcastRecipient> = {};
    for (const c of audience.contacts) {
      const contactKey = c.contactId && c.contactId.length > 0 ? c.contactId : `phone#${c.phone}`;
      recipients[contactKey] = { status: 'queued' };
    }

    let sending: BroadcastItem;
    try {
      sending = await broadcasts.markSending(broadcastId, recipients);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // markSending is conditional on status='draft'. A concurrent/duplicate
        // send won the flip between our read above and here — return the same
        // idempotent-clean 409 as the draft-state guard (NOT an uncaught 500),
        // and do NOT enqueue (the winning send owns the fan-out).
        log.info({ broadcastId }, 'broadcast send raced a concurrent send — not a draft, 409');
        res.status(409).json({ error: 'broadcast_not_draft' });
        return;
      }
      throw err;
    }

    try {
      await enqueueImmediate(BROADCAST_SEND_JOB, { broadcastId });
    } catch (err) {
      // Enqueue failed AFTER markSending — the broadcast is 'sending' but no job
      // runs. Mark it failed so the operator sees the honest outcome (no silent
      // stuck-sending). Surface 500 so the client can retry.
      log.error({ err, broadcastId }, 'broadcast send: enqueue failed — marking failed');
      try {
        await broadcasts.markFailed(broadcastId, 'enqueue failed');
      } catch (markErr) {
        log.error({ err: markErr, broadcastId }, 'broadcast send: markFailed also failed');
      }
      res.status(500).json({ error: 'enqueue_failed' });
      return;
    }

    await audit.append(`broadcasts#${broadcastId}`, 'broadcast_sent', {
      actor,
      count: audience.count,
    });
    log.info({ broadcastId, count: audience.count, actor }, 'broadcast send started via api');
    res.json({ broadcastId, status: sending.status, count: audience.count });
  });

  // GET /api/broadcasts/:id/results — stats + per-recipient delivery map.
  router.get('/broadcasts/:broadcastId/results', async (req, res) => {
    const { broadcastId } = req.params;
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    res.json(toBroadcastResults(broadcast));
  });

  // GET /api/broadcasts?status=&limit= — list (by status, else this user's).
  router.get('/broadcasts', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    // Optional opaque cursor → ExclusiveStartKey (FIX 5). A tampered/invalid
    // cursor is a 400 (never handed to DynamoDB malformed).
    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }
    const opts = { limit, ...(exclusiveStartKey !== undefined && { exclusiveStartKey }) };

    const rawStatus = req.query['status'];
    let page;
    if (typeof rawStatus === 'string' && rawStatus.length > 0) {
      if (!BROADCAST_STATUSES.has(rawStatus)) {
        res.status(400).json({ error: `status must be one of: ${[...BROADCAST_STATUSES].join(', ')}` });
        return;
      }
      page = await broadcasts.listByStatus(rawStatus as BroadcastStatus, opts);
    } else {
      // No status filter → the acting user's broadcasts, newest-first.
      page = await broadcasts.listByCreatedBy(actor, opts);
    }
    res.json({
      broadcasts: page.items.map(toBroadcastSummary),
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  return router;
}
