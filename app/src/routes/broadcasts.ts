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
  deriveBroadcastStats,
  MAX_BROADCAST_RECIPIENTS,
  type AudienceFilter,
  type BroadcastAudienceMode,
  type BroadcastItem,
  type BroadcastRecipient,
  type BroadcastsRepo,
  type BroadcastStatus,
} from '../repos/broadcastsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createAudienceResolutionService,
  type AudienceResolutionService,
  type ResolvedContact,
} from '../services/audienceResolution.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';

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

/**
 * A recipient slot as returned to the dashboard: the persisted delivery slot
 * PLUS optional raw identity (S5). Raw fields only - the dashboard composes the
 * display name (contactDisplayName), so no name is composed server-side.
 */
interface EnrichedRecipient extends BroadcastRecipient {
  firstName?: string;
  lastName?: string;
  phone?: string;
}

/** Bounded-concurrency getById fan-out (mirrors the send route's selection fetch). */
const RESULTS_FETCH_CONCURRENCY = 50;

/** Optional-string reader off a flexible ContactItem attribute (trimmed). */
function trimmedField(contact: ContactItem, field: string): string | undefined {
  const v = contact[field];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * S5: enrich each recipients-map entry with OPTIONAL raw firstName/lastName/
 * phone so the results view can show the tenant's name + number (and keep
 * linking to /contacts/:id).
 * - contactId keys: contacts.getById, chunked at RESULTS_FETCH_CONCURRENCY
 *   (same pattern as the send route's explicit-selection fetch).
 * - phone#<E164> keys: phone comes from the key (no lookup).
 * - deleted/unresolvable contacts: omit the fields (never leak the raw key);
 *   the dashboard falls back to today's "Tenant" label.
 * Cost is bounded by MAX_BROADCAST_RECIPIENTS, only on this endpoint (no cache).
 */
async function enrichRecipients(
  contacts: ContactsRepo,
  recipients: Record<string, BroadcastRecipient>,
): Promise<Record<string, EnrichedRecipient>> {
  const keys = Object.keys(recipients);
  const contactIdKeys = keys.filter((k) => !k.startsWith('phone#'));
  const resolvedById = new Map<string, ContactItem>();
  for (let i = 0; i < contactIdKeys.length; i += RESULTS_FETCH_CONCURRENCY) {
    const chunk = contactIdKeys.slice(i, i + RESULTS_FETCH_CONCURRENCY);
    const fetched = await Promise.all(chunk.map((id) => contacts.getById(id)));
    for (let j = 0; j < chunk.length; j += 1) {
      const contact = fetched[j];
      if (contact) resolvedById.set(chunk[j]!, contact);
    }
  }
  const out: Record<string, EnrichedRecipient> = {};
  for (const key of keys) {
    const slot = recipients[key]!;
    if (key.startsWith('phone#')) {
      // The phone is the key itself - no lookup, no identity leak beyond it.
      out[key] = { ...slot, phone: key.slice('phone#'.length) };
      continue;
    }
    const contact = resolvedById.get(key);
    if (!contact) {
      // Deleted / unresolvable - omit identity; never echo the raw contactKey.
      out[key] = { ...slot };
      continue;
    }
    const firstName = trimmedField(contact, 'firstName');
    const lastName = trimmedField(contact, 'lastName');
    const phone = typeof contact.phone === 'string' && contact.phone.length > 0 ? contact.phone : undefined;
    out[key] = {
      ...slot,
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(phone !== undefined && { phone }),
    };
  }
  return out;
}

/**
 * Build the recipients map from a list of already-sendable contacts: one
 * `{ status: 'queued' }` slot per contact, keyed by the shared contactKey
 * convention (contactId when present, else `phone#<E164>`). The map naturally
 * de-dupes by key. Shared by the explicit-selection send path (post-fence
 * survivors) and the seeds_only no-body path (resolved seeds) so both produce
 * the identical stored shape.
 */
function buildRecipientsFrom(
  list: Array<{ contactId?: string; phone: string }>,
): Record<string, BroadcastRecipient> {
  const recipients: Record<string, BroadcastRecipient> = {};
  for (const c of list) {
    const contactKey = c.contactId && c.contactId.length > 0 ? c.contactId : `phone#${c.phone}`;
    recipients[contactKey] = { status: 'queued' };
  }
  return recipients;
}

/** The results-view projection of a broadcast (stats + recipients + lifecycle). */
function toBroadcastResults(
  b: BroadcastItem,
  recipients: Record<string, EnrichedRecipient>,
): Record<string, unknown> {
  return {
    broadcastId: b.broadcastId,
    status: b.status,
    unitId: b.unitId ?? null,
    audience_filter: b.audience_filter,
    // Matching sends: surface the draft's audience mode when set so the composer
    // can render the seeds_only (1:1) vs filter (1:N) affordances.
    ...(b.audience_mode !== undefined && { audience_mode: b.audience_mode }),
    // S4: disjoint buckets derived from the recipients map (historical rows too).
    stats: deriveBroadcastStats(b),
    recipients,
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
    // Matching sends: pass the audience mode through on list rows too (dashboard
    // Task 5 reads it on BroadcastSummary).
    ...(b.audience_mode !== undefined && { audience_mode: b.audience_mode }),
    // S4: derived disjoint stats (the byCreated GSI projects the map).
    stats: deriveBroadcastStats(b),
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

  /** Resolve seed contact ids to sendable tenants using the SAME fences as the
   *  explicit-selection send path: exists, type 'tenant', has phone, not
   *  sms_opt_out, not sms_unreachable. Anything else lands in `unresolved`.
   *  Seeds are few (1..handful), so per-id getById is fine. */
  async function resolveSeeds(
    ids: string[],
  ): Promise<{ contacts: ResolvedContact[]; unresolved: string[] }> {
    const resolved: ResolvedContact[] = [];
    const unresolved: string[] = [];
    for (const id of ids) {
      const c = await contacts.getById(id);
      if (
        !c ||
        c.type !== 'tenant' ||
        typeof c.phone !== 'string' ||
        c.phone.length === 0 ||
        c.sms_opt_out === true ||
        c.sms_unreachable === true
      ) {
        unresolved.push(id);
        continue;
      }
      resolved.push({
        contactId: c.contactId,
        phone: c.phone,
        ...(typeof c.firstName === 'string' && { firstName: c.firstName }),
        ...(typeof c.lastName === 'string' && { lastName: c.lastName }),
        ...(typeof c.voucherSize === 'number' && { voucherSize: c.voucherSize }),
        ...(typeof c.housingAuthority === 'string' && { housingAuthority: c.housingAuthority }),
        has_consent: hasSmsConsent(c),
      });
    }
    return { contacts: resolved, unresolved };
  }

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

    // Optional seed recipients attached to the draft (the seeded 1:1 entry, or
    // hand-picked additions). Parsed with the same shape/cap guard as the send
    // path's recipientContactIds.
    const parsedSeeds = parseRecipientContactIds(
      (req.body as Record<string, unknown> | undefined)?.['seedContactIds'],
    );
    if (parsedSeeds !== undefined && 'error' in parsedSeeds) {
      res.status(400).json({ error: parsedSeeds.error });
      return;
    }
    // An EMPTY parsed seed list behaves exactly like an absent one: no seeds
    // stored, and the draft stays in filter mode (never flipped to seeds_only).
    const seedContactIds =
      parsedSeeds !== undefined && parsedSeeds.ids.length > 0 ? parsedSeeds.ids : undefined;
    // A draft carrying seeds but NO explicit audience_filter is a seeds_only
    // draft (the seeded 1:1 entry) - the default tenant filter would otherwise
    // propose every tenant. Any explicit filter keeps it in filter mode.
    const rawFilterProvided =
      (req.body as Record<string, unknown> | undefined)?.['audience_filter'] !== undefined;
    const audienceMode: BroadcastAudienceMode =
      seedContactIds !== undefined && !rawFilterProvided ? 'seeds_only' : 'filter';

    // Estimate the audience now (save-for-later shows the operator the reach).
    const seeds =
      seedContactIds !== undefined
        ? await resolveSeeds(seedContactIds)
        : { contacts: [], unresolved: [] };
    let estimatedAudience: number;
    let truncated = false;
    if (audienceMode === 'seeds_only') {
      estimatedAudience = seeds.contacts.length;
    } else {
      const audience = await resolveAudience(filter);
      const union = new Set(audience.contactIds);
      for (const s of seeds.contacts) union.add(s.contactId);
      estimatedAudience = union.size;
      truncated = audience.truncated;
    }

    const created = await broadcasts.create({
      created_by: actor,
      audience_filter: filter,
      body_template: template,
      estimatedAudience,
      audienceMode,
      ...(unitId !== undefined && { unitId }),
      ...(flyer_url !== undefined && { flyer_url }),
      ...(seedContactIds !== undefined && { seedContactIds }),
    });
    await audit.append(`broadcasts#${created.broadcastId}`, 'broadcast_created', {
      actor,
      ...(unitId !== undefined && { unitId }),
      estimatedCount: estimatedAudience,
    });
    log.info(
      { broadcastId: created.broadcastId, estimatedCount: estimatedAudience, actor },
      'broadcast draft created via api',
    );
    res.status(201).json({
      broadcastId: created.broadcastId,
      status: 'draft',
      estimatedCount: estimatedAudience,
      // FIX 3+4: surface whether the estimate was truncated (page cap hit) so
      // the operator knows the draft's reach is incomplete before sending.
      truncated,
      ...(flyer_url !== undefined && { flyerUrl: flyer_url }),
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
    // Seeded recipients attached to the draft: resolve them (same fences as the
    // send path), then UNION into the previewed candidate list. A seeds_only
    // draft (the seeded 1:1 entry) skips the audience filter entirely so preview
    // returns ONLY the seeds, never the whole tenant base.
    const seedIds = broadcast.seed_contact_ids ?? [];
    const seeds =
      seedIds.length > 0 ? await resolveSeeds(seedIds) : { contacts: [], unresolved: [] };
    const audience =
      broadcast.audience_mode === 'seeds_only'
        ? { contacts: [], contactIds: [], count: 0, truncated: false }
        : await resolveAudience(broadcast.audience_filter);
    const seedIdSet = new Set(seeds.contacts.map((c) => c.contactId));
    // Union: audience rows first (stable order), then seeds not already present.
    // A contact in BOTH audience and seeds is ONE row, flagged seeded.
    const combined = [
      ...audience.contacts.filter((c) => !seedIdSet.has(c.contactId)),
      ...seeds.contacts,
    ];
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
    const candidates = combined.slice(0, MAX_BROADCAST_RECIPIENTS).map((c) => ({
      contactId: c.contactId,
      ...(c.firstName !== undefined && { firstName: c.firstName }),
      // Full name for the review rows (same authed/internal PII class as
      // firstName + phone above).
      ...(c.lastName !== undefined && { lastName: c.lastName }),
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
      // Whether this row came from the draft's seed_contact_ids (a hand-picked
      // recipient, or the seeded 1:1 entry). A contact in BOTH audience and
      // seeds is ONE row flagged seeded.
      seeded: seedIdSet.has(c.contactId),
    }));
    // count/truncated derive from the post-union, pre-slice list (+ the audience
    // truncation flag) so the operator sees the true unioned reach.
    const combinedCount = combined.length;
    log.info(
      { broadcastId, count: combinedCount, truncated: audience.truncated },
      'broadcast audience previewed',
    );
    // Surface `truncated` (FIX 3+4) so the operator sees an incomplete/over-cap
    // audience BEFORE sending (and the dashboard can warn). seedContactIds (as
    // stored) + unresolvedSeedIds let the composer show which seeds dropped.
    res.json({
      count: combinedCount,
      truncated: audience.truncated,
      candidates,
      priorRecipientContactIds: [...priorRecipients],
      seedContactIds: seedIds,
      unresolvedSeedIds: seeds.unresolved,
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
    //  (b) seeds_only no-body - a seeded 1:1/1:N draft (the seeded entry): the
    //      draft carries seed_contact_ids and audience_mode 'seeds_only', so
    //      resolve THOSE seeds (same fences) instead of the default filter.
    //  (c) filter-resolve (back-compat - no body): the existing snapshot path.
    let recipients: Record<string, BroadcastRecipient> = {};
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
      const survivors: Array<{ contactId?: string; phone: string }> = [];
      for (const contact of fetched) {
        if (!contact) continue; // unknown id — drop
        if (contact.type !== 'tenant') continue; // never text a non-tenant
        if (contact.sms_opt_out === true) continue; // HARD exclusion (re-enforced)
        if (contact.sms_unreachable === true) continue; // HARD exclusion (re-enforced)
        if (typeof contact.phone !== 'string' || contact.phone.length === 0) continue; // unsendable
        survivors.push({ contactId: contact.contactId, phone: contact.phone });
      }
      // Same contactKey convention (contactId else phone#<E164>) + de-dupe - here
      // ids are real contactIds, so keys are the contactIds.
      recipients = buildRecipientsFrom(survivors);
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
    } else if (broadcast.audience_mode === 'seeds_only') {
      // (b) seeds_only no-body - resolve the draft's seed_contact_ids (same
      // fences as resolveSeeds), NOT the default tenant filter (which would
      // otherwise send to every tenant). Reuse the explicit-path recipient build.
      const seeds = await resolveSeeds(broadcast.seed_contact_ids ?? []);
      if (seeds.contacts.length === 0) {
        // Every seed dropped (unknown / non-tenant / opted-out / unreachable /
        // phone-less) - refuse clearly, leave the draft for the operator.
        res.status(400).json({ error: 'empty_audience' });
        return;
      }
      recipients = buildRecipientsFrom(seeds.contacts);
      count = Object.keys(recipients).length;
    } else {
      // (c) Re-resolve the audience snapshot at send time (the source of truth -
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
    // S5: resolve raw identity (firstName/lastName/phone) for each recipient so
    // the results rows are human-readable. IDs/counts only in logs (never here).
    const recipients = await enrichRecipients(contacts, broadcast.recipients ?? {});
    res.json(toBroadcastResults(broadcast, recipients));
  });

  // GET /api/broadcasts?status=&limit= — the TEAM-WIDE list (optionally status-
  // filtered), newest-first. Both branches read the same byCreated GSI, so the
  // dashboard's All tab and its status tabs see the SAME population (they used
  // to diverge: no-filter was scoped to the acting user, 2026-07-08 bug).
  router.get('/broadcasts', async (req, res) => {
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
      // Filtered pages can come back SHORT (Limit precedes the filter) while
      // still carrying a cursor — the client pages until nextCursor is null.
      page = await broadcasts.listByStatus(rawStatus as BroadcastStatus, opts);
    } else {
      page = await broadcasts.list(opts);
    }
    res.json({
      broadcasts: page.items.map(toBroadcastSummary),
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // PATCH /api/broadcasts/:id — replace the draft's hand-picked seed_contact_ids
  // (the review step's curated additions / the seeded 1:1 entry). Draft-only:
  // the repo's conditional write refuses a sending/sent/failed broadcast (409).
  // An EMPTY array is VALID here (it CLEARS the seed list) — unlike create, where
  // an empty list is treated as absent. Absent/malformed body → 400 bad_request.
  // VA-accessible (same posture as the rest of the router).
  router.patch('/broadcasts/:broadcastId', async (req, res) => {
    const broadcastId = String(req.params['broadcastId'] ?? '');
    const parsed = parseRecipientContactIds(
      (req.body as Record<string, unknown> | undefined)?.['seedContactIds'],
    );
    // Absent (undefined) OR malformed ({ error }) → a clean 400. An empty array
    // is a valid clear and parses to { ids: [] } (never undefined/error).
    if (parsed === undefined || 'error' in parsed) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const existing = await broadcasts.getById(broadcastId);
    if (!existing) {
      res.status(404).json({ error: 'broadcast_not_found' });
      return;
    }
    try {
      await broadcasts.setSeedContactIds(broadcastId, parsed.ids);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // The broadcast is no longer a draft (a concurrent send flipped it, or it
        // was already sending/sent/failed) — its recipients are frozen.
        res.status(409).json({ error: 'broadcast_not_draft' });
        return;
      }
      throw err;
    }
    log.info({ broadcastId, seedCount: parsed.ids.length }, 'broadcast seeds updated via api');
    res.status(200).json({ broadcastId, seedContactIds: parsed.ids });
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
