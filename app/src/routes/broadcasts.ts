// Share-broadcast ("Share Properties") router (M1.8a) — mounted under /api,
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
import { createUserRateLimit } from '../middleware/rateLimit.js';
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
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
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
/** Sane cap so a template body can't be used to store a huge blob. */
const MAX_TEMPLATE_LEN = 1600;

export interface BroadcastsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  broadcastsRepo?: BroadcastsRepo;
  unitsRepo?: UnitsRepo;
  contactsRepo?: ContactsRepo;
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

/**
 * Parse an optional `recipientContactIds` send body. Returns:
 *  - `undefined` when the field is absent/null → keep the filter-resolve path.
 *  - `{ ids }` (de-duped, non-empty) when a valid non-empty string array.
 *  - `{ error }` when malformed (not an array, a non-string/empty element, or
 *    over the recipient cap defensively).
 * Empty-after-dedupe is surfaced as `{ error }` too (the send refuses an empty
 * effective set with 400 empty_audience; an empty explicit list is the same
 * intent — but we let the caller map it, returning `{ ids: [] }` here so the
 * route emits the consistent empty_audience shape).
 */
function parseRecipientContactIds(
  raw: unknown,
): { ids: string[] } | { error: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    return { error: 'recipientContactIds must be an array of non-empty strings' };
  }
  if (raw.length > MAX_BROADCAST_RECIPIENTS) {
    return {
      error: `recipientContactIds exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap`,
    };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const el of raw) {
    if (typeof el !== 'string' || el.trim().length === 0) {
      return { error: 'recipientContactIds must be an array of non-empty strings' };
    }
    const id = el.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ids };
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
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
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

  // POST /api/broadcasts/:id/preview — re-resolve the audience + return the FULL
  // annotated candidate list (bounded by the recipient cap, NOT the old 25-row
  // sample) so the composer can render an editable curated recipient list. Each
  // candidate carries voucherSize/housingAuthority for the row, plus
  // `alreadySentThisProperty` (SOFT — a prior sent/sending broadcast for this
  // unit already included the tenant). `priorRecipientContactIds` lets the
  // composer annotate MANUALLY-added tenants locally too.
  router.post('/broadcasts/:broadcastId/preview', async (req, res) => {
    const { broadcastId } = req.params;
    mergeContext({});
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    const audience = await resolveAudience(broadcast.audience_filter);
    // Prior-recipients for this unit (already-sent annotation). Only meaningful
    // with a unitId; degrades safely to an empty set otherwise (or when the
    // byUnit GSI is absent on an un-applied env). The set is contactKeys — which
    // are contactId OR `phone#<E164>` (a phone-only recipient at the prior
    // broadcast's send time), so a candidate must be matched on EITHER key.
    const priorRecipients =
      broadcast.unitId !== undefined
        ? await broadcasts.priorRecipientContactIds(broadcast.unitId)
        : new Set<string>();
    // The candidate list carries phones — authed/internal response only; the
    // log line below stays IDs/counts only (NEVER phones/names/bodies).
    const candidates = audience.contacts.slice(0, MAX_BROADCAST_RECIPIENTS).map((c) => ({
      contactId: c.contactId,
      ...(c.firstName !== undefined && { firstName: c.firstName }),
      phone: c.phone,
      ...(c.voucherSize !== undefined && { voucherSize: c.voucherSize }),
      ...(c.housingAuthority !== undefined && { housingAuthority: c.housingAuthority }),
      // A2P/CTIA (LOCKED CONTRACT 3): whether this candidate has recorded SMS
      // consent. The composer surfaces "consent not recorded" for `false` +
      // a count; the fan-out EXCLUDES !has_consent recipients (broadcastFanOut).
      has_consent: c.has_consent,
      // Match on contactId OR the `phone#<E164>` key (same prefix the recipients
      // map uses) so a tenant previously texted under a phone-only key (who
      // later gained a contactId) is still flagged. SOFT hint — never excludes.
      // TODO(broadcasts): the manually-added-tenant client-side annotation (the
      // dashboard matches `priorRecipientContactIds` by contactId) has the same
      // rare phone-only edge — a manually-added tenant prior-texted under a
      // `phone#…` key won't be flagged client-side. Not addressed here.
      alreadySentThisProperty:
        broadcast.unitId !== undefined &&
        (priorRecipients.has(c.contactId) || priorRecipients.has(`phone#${c.phone}`)),
    }));
    log.info(
      { broadcastId, count: audience.count, truncated: audience.truncated },
      'broadcast audience previewed',
    );
    // Surface `truncated` (FIX 3+4) so the operator sees an incomplete/over-cap
    // audience BEFORE sending (and the dashboard can warn).
    res.json({
      count: audience.count,
      truncated: audience.truncated,
      candidates,
      priorRecipientContactIds: [...priorRecipients],
    });
  });

  // POST /api/broadcasts/:id/send — snapshot the audience, mark sending, enqueue.
  //
  // Per-user spend fence (2026-07-02 hardening): each request triggers a whole
  // audience fan-out — the most expensive single click in the app — so the send
  // POST (and only the send POST; draft/preview/results stay unmetered) sits
  // behind a sliding-window per-user limiter. ONE instance, created with the
  // router.
  const broadcastSendLimiter = createUserRateLimit({
    routeKey: 'broadcast_send',
    max: config.rateLimitBroadcastSendPerMin,
    windowMs: 60_000,
    logger: log,
  });
  router.post('/broadcasts/:broadcastId/send', broadcastSendLimiter, async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    // NOTE: with a middleware ahead of the handler, Express's typings no longer
    // narrow req.params from the path literal — coerce like voiceApi.ts does.
    const broadcastId = String(req.params['broadcastId'] ?? '');
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

    // Two send paths share the rest of the flow once they've produced a bounded
    // `recipients` map + count:
    //  (a) explicit selection — the dashboard's curated checked list (a body
    //      `recipientContactIds`): resolve EACH contact + RE-ENFORCE the same
    //      hard fences the audience resolver applies (drop unknown / non-tenant
    //      / opted-out / unreachable / phone-less). The already-sent flag is a
    //      preview hint only — NEVER excluded here.
    //  (b) filter-resolve (back-compat — no body): the existing snapshot path.
    const recipients: Record<string, BroadcastRecipient> = {};
    let count: number;

    const selection = parseRecipientContactIds(
      (req.body as { recipientContactIds?: unknown } | undefined)?.recipientContactIds,
    );
    if (selection !== undefined && 'error' in selection) {
      res.status(400).json({ error: selection.error });
      return;
    }

    if (selection !== undefined) {
      // (a) Explicit selection. Build recipients from THIS set — re-fence each.
      // contactsRepo has no batch-get, so resolve the ids with a BOUNDED-
      // CONCURRENCY fan-out: chunk the ids and Promise.all each chunk, capping
      // in-flight getById round-trips at FETCH_CONCURRENCY. The raw list is
      // already capped at MAX_BROADCAST_RECIPIENTS pre-fetch (parse guard), so
      // this only trims request latency (sequential awaits were 7-15s on a
      // 1500-id send) — it does NOT change which contacts survive. The fences,
      // de-dupe, contactKey convention, empty→400, and cap below are identical.
      const FETCH_CONCURRENCY = 50;
      const fetched: Array<Awaited<ReturnType<typeof contacts.getById>>> = [];
      for (let i = 0; i < selection.ids.length; i += FETCH_CONCURRENCY) {
        const chunk = selection.ids.slice(i, i + FETCH_CONCURRENCY);
        const resolved = await Promise.all(chunk.map((id) => contacts.getById(id)));
        for (const contact of resolved) fetched.push(contact);
      }
      for (const contact of fetched) {
        if (!contact) continue; // unknown id — drop
        if (contact.type !== 'tenant') continue; // never text a non-tenant
        if (contact.sms_opt_out === true) continue; // HARD exclusion (re-enforced)
        if (contact.sms_unreachable === true) continue; // HARD exclusion (re-enforced)
        if (typeof contact.phone !== 'string' || contact.phone.length === 0) continue; // unsendable
        // Same contactKey convention (contactId else phone#<E164>) — here ids
        // are real contactIds, so the key is the contactId.
        const contactKey =
          contact.contactId && contact.contactId.length > 0
            ? contact.contactId
            : `phone#${contact.phone}`;
        recipients[contactKey] = { status: 'queued' };
      }
      count = Object.keys(recipients).length;
      if (count === 0) {
        // Nothing survived the fences (all dropped) — refuse clearly, leave the
        // draft for the operator to adjust.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      if (count > MAX_BROADCAST_RECIPIENTS) {
        log.warn(
          { broadcastId, count, cap: MAX_BROADCAST_RECIPIENTS },
          'broadcast send refused: explicit selection too large',
        );
        res.status(400).json({
          error: 'audience_too_large',
          message: `audience of ${count} exceeds the ${MAX_BROADCAST_RECIPIENTS} recipient cap — remove recipients`,
          count,
          truncated: false,
        });
        return;
      }
    } else {
      // (b) Re-resolve the audience snapshot at send time (the source of truth —
      // the draft estimate may be stale). Build the recipients map keyed by
      // contactKey (contactId else phone#<E164>, the shared convention),
      // all 'queued'.
      const audience = await resolveAudience(broadcast.audience_filter);
      if (audience.count === 0) {
        // Empty audience: refuse clearly (no point marking a broadcast sending
        // with nobody to send to). Leave it a draft so the operator can adjust.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      // Bound the audience (FIX 3+4): refuse when the resolved set exceeds the
      // recipients-map item-size cap, OR when resolution was truncated (page cap
      // hit → the set is INCOMPLETE; sending would silently under-deliver).
      // Either way leave the broadcast a DRAFT and do NOT enqueue — the operator
      // must narrow the bedroom/housing-authority filter.
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
      for (const c of audience.contacts) {
        const contactKey = c.contactId && c.contactId.length > 0 ? c.contactId : `phone#${c.phone}`;
        recipients[contactKey] = { status: 'queued' };
      }
      count = audience.count;
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
      count,
    });
    log.info({ broadcastId, count, actor }, 'broadcast send started via api');
    res.json({ broadcastId, status: sending.status, count });
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

  // DELETE /api/broadcasts/:id — delete an UNSENT draft only. A sending/sent/
  // failed broadcast is permanent (409). The repo's conditional delete is the
  // race guard — a concurrent send that flips draft→sending mid-call yields 409,
  // never a silent delete of a sent broadcast. Audited IDs-only (NEVER the body/
  // audience). VA-accessible (same posture as the rest of the router).
  router.delete('/broadcasts/:broadcastId', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId ?? 'unknown';
    const { broadcastId } = req.params;
    const result = await broadcasts.delete(broadcastId);
    if (result.deleted) {
      await audit.append(`broadcasts#${broadcastId}`, 'broadcast_deleted', { actor });
      log.info({ broadcastId, actor }, 'broadcast draft deleted via api');
      res.status(200).json({ deleted: true });
      return;
    }
    if (result.reason === 'not_found') {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    // not_draft: re-read the current status so the client can fall back to the
    // results view (the row is already sending/sent/failed).
    const current = await broadcasts.getById(broadcastId);
    res.status(409).json({
      error: 'broadcast_not_draft',
      ...(current !== undefined && { status: current.status }),
    });
  });

  return router;
}
