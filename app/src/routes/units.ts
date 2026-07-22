// Units CRUD router (M1.5) — mounted under /api/units, behind requireAuth via
// the /api mount (app.ts). VAs maintain properties day-to-day, so NO admin gate
// (same posture as contacts triage).
//
//   GET   /api/units?status=&jurisdiction=&landlordId=&limit=&cursor=
//                                  → { units, nextCursor }
//   POST  /api/units  { unit fields }            → 201 { unit }
//   GET   /api/units/:unitId                      → { unit } | 404
//   PATCH /api/units/:unitId  { partial }         → { unit } | 404
//
// Validation is strict (lib/unitFields.ts): a fixed field allowlist, numbers
// are finite & non-negative, status is allowlisted (it's a GSI partition key).
// Audit: unit_created / unit_updated (entityKey units#<unitId>, actor lifted to
// the byActor GSI by auditRepo).
//
// PII (doc §9): responses carry full unit docs to the authenticated client;
// LOG LINES are IDs/counts only.
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { validateUnitBody } from '../lib/unitFields.js';
import { rankSimilarUnits } from '../lib/similarUnits.js';
import { isImageMediaType } from '../lib/mediaTypes.js';
import { transcodeForUnitPhoto } from '../adapters/mediaTranscode.js';
import { MMS_TRANSCODE_WAIT_TIMEOUT_MS } from '../lib/outboundMediaLimits.js';
import {
  UNIT_PHOTO_PASSTHROUGH_MAX_BYTES,
  UNIT_PHOTO_SOURCE_MAX_BYTES,
  UNIT_PHOTO_TRANSCODE_MAX_PER_REQUEST,
} from '../lib/unitPhotoLimits.js';
import { sharedTranscodeGate } from '../lib/transcodeGate.js';
import type { Semaphore } from '../lib/semaphore.js';
import {
  deleteRemovedUnitMedia,
  resolveUnitMedia,
  UNIT_MEDIA_MAX,
  unitMediaPrefix,
} from '../lib/unitMedia.js';
import type { MediaStore } from '../adapters/mediaStore.js';
import { createUserRateLimit } from '../middleware/rateLimit.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../repos/auditRepo.js';
import {
  CannotRemovePrimaryLandlordError,
  createUnitsRepo,
  isDeleted,
  unitContacts,
  UNIT_CONTACT_ROLES,
  type ListUnitsOpts,
  type RelatedUnit,
  type UnitContact,
  type UnitItem,
  type UnitsPage,
  type UnitStatus,
  type UnitsRepo,
} from '../repos/unitsRepo.js';
import { createContactsRepo, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createListingSendsRepo,
  toListingSendRow,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import { createPlacementsRepo, type PlacementItem, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import { deriveTourSignal } from '../lib/listingSendTour.js';

export interface UnitsRouterDeps {
  logger?: Logger;
  unitsRepo?: UnitsRepo;
  auditRepo?: AuditRepo;
  /** BE3/C3: resolve a roster contact's display name/company for denormalization. */
  contactsRepo?: ContactsRepo;
  /** BE4/C4: the listing-send record (the "Sent to tenants" recipients read). */
  listingSendsRepo?: ListingSendsRepo;
  /** FIX 3: GET /:id/placements lists the unit's placements (tenant-name enriched). */
  placementsRepo?: PlacementsRepo;
  /**
   * listing-response-tour-chip: GET /:id/recipients derives a per-row tour chip
   * from the unit's tours (byUnit GSI). Best-effort join - a query failure
   * degrades to chipless rows, never a 500.
   */
  toursRepo?: ToursRepo;
  /**
   * unit-photos: the media bucket store for photo upload (PUT) + display
   * resolution (presign-per-read). Undefined when MEDIA_BUCKET is unset - the
   * upload/manage routes then answer 503 and reads resolve stored keys to
   * url-absent (only legacy absolute URLs carry through).
   */
  mediaStore?: MediaStore;
  /**
   * unit-photo-transcode: the process-wide transcode gate (shared with MMS
   * confirm - ONE memory bound). Injectable for tests; defaults to the shared
   * instance.
   */
  transcodeGate?: Semaphore;
}

/** BE3/C3: a valid roster role (C3 `UnitContact.role`). */
function isUnitContactRole(value: unknown): value is UnitContact['role'] {
  return typeof value === 'string' && (UNIT_CONTACT_ROLES as readonly string[]).includes(value);
}

/**
 * BE3/C3: the denormalized display name for a roster row, from the contact's
 * firstName/lastName (joined + trimmed). HONEST — undefined when no name is
 * known (never invents one); the roster row then has no `name`.
 */
function displayNameOfContact(contact: ContactItem): string | undefined {
  // Part-wise trim BEFORE the join (legacy padded parts must not render an
  // interior gap; new writes arrive trimmed via trimJsonBody).
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * BE3/C3: project a unit onto the RelatedUnit wire shape (contract verbatim).
 * `address` reuses the legacy unit address field (structured or legacy string);
 * `status` reuses the legacy status. `label` is a short human hint.
 */
function toRelatedUnit(
  unit: UnitItem,
  relation: RelatedUnit['relation'],
  label?: string,
): RelatedUnit {
  return {
    unitId: unit.unitId,
    ...(unit.address !== undefined && { address: unit.address }),
    status: unit.status as UnitStatus,
    relation,
    ...(label !== undefined && { label }),
  };
}

/**
 * One property Activity row (the dashboard's Activity card) — a unit audit
 * event projected onto the wire. `type` is the audit event_type (an open set;
 * today: unit_created, unit_updated, unit_contact_added, unit_contact_removed,
 * listing_status_changed, unit_deleted, unit_restored,
 * broadcast_sent, tour_scheduled, tour_rescheduled, tour_took_place,
 * tour_no_show, tour_canceled, tour_outcome).
 * Details are a fixed-key whitelist lifted from the audit payload — NEVER the
 * raw payload document (a future payload field can't leak through here).
 */
interface UnitActivityEvent {
  /** The audit `ts` SK (`<ISO>#<suffix>`) — unique within the unit. */
  id: string;
  /** ISO 8601 — the ts prefix (when the event happened). */
  at: string;
  type: string;
  /** The acting user, when the event wasn't a system action. */
  actorId?: string;
  contactId?: string;
  /** Read-time enrichment (best-effort) — omitted when the contact is gone. */
  contactName?: string;
  role?: string;
  fields?: string[];
  from?: string;
  to?: string;
  source?: string;
  broadcastId?: string;
  tenantCount?: number;
  tourId?: string;
  outcome?: string;
}

/** Project one audit row → the Activity wire shape (fixed-key whitelist). */
function toUnitActivityEvent(e: AuditEvent): UnitActivityEvent {
  const p = e.payload ?? {};
  const str = (key: string): string | undefined =>
    typeof p[key] === 'string' ? (p[key] as string) : undefined;
  const num = (key: string): number | undefined =>
    typeof p[key] === 'number' ? (p[key] as number) : undefined;
  const fieldsRaw = p['fields'];
  const fields = Array.isArray(fieldsRaw)
    ? fieldsRaw.filter((f): f is string => typeof f === 'string')
    : undefined;
  // `at` is the ISO prefix of the `<ISO>#<suffix>` SK (same derivation as the
  // contact timeline's atOf) — the SK IS the timestamp the trail sorts by.
  const hash = e.ts.indexOf('#');
  const at = hash > 0 ? e.ts.slice(0, hash) : e.ts;
  return {
    id: e.ts,
    at,
    type: e.event_type,
    ...(typeof e.actorId === 'string' && { actorId: e.actorId }),
    ...(str('contactId') !== undefined && { contactId: str('contactId') }),
    ...(str('role') !== undefined && { role: str('role') }),
    ...(fields !== undefined && { fields }),
    ...(str('from') !== undefined && { from: str('from') }),
    ...(str('to') !== undefined && { to: str('to') }),
    ...(str('source') !== undefined && { source: str('source') }),
    ...(str('broadcastId') !== undefined && { broadcastId: str('broadcastId') }),
    ...(num('tenantCount') !== undefined && { tenantCount: num('tenantCount') }),
    ...(str('tourId') !== undefined && { tourId: str('tourId') }),
    ...(str('outcome') !== undefined && { outcome: str('outcome') }),
  };
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

/**
 * Max presigned-POST grants one /photos/presign request may mint. A UX /
 * politeness bound (a human picks a handful of files at a time), NOT a memory
 * bound - the bytes go browser->S3 directly, so the app never buffers them. The
 * 100-per-unit cap (UNIT_MEDIA_MAX) is the real abuse backstop; this just keeps
 * a single mint request civil.
 */
const UNIT_PHOTO_PRESIGN_BATCH_MAX = 20;

/**
 * BE5/C6: the cap on how many `available` units the similar-properties endpoint
 * will sweep before ranking. The ranker is O(candidates) and the result is a
 * top-N panel, so 500 is a generous bound on a single jurisdiction's open
 * inventory. If MORE than this remain, we stop and log.warn (the ranker ran on
 * a prefix of the available set — never silent truncation).
 */
const SIMILAR_SCAN_LIMIT = 500;

/**
 * Parse ?limit= into 1..MAX_PAGE_LIMIT (default DEFAULT_PAGE_LIMIT). undefined
 * means "invalid" — the caller responds 400.
 */
function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return undefined;
  return limit;
}

// --- Cursor (opaque to clients) --------------------------------------------
// base64url(JSON) of the Query/Scan LastEvaluatedKey. A unit cursor is a small
// flat object of string/number key attributes (unitId + maybe a GSI key); we
// validate it is a flat scalar object before letting it become an
// ExclusiveStartKey — a client-tampered cursor must never reach DynamoDB as a
// malformed key. The exact attribute set varies by which index produced it, so
// (unlike the inbox's fixed-shape cursor) we check the SHAPE, not exact keys.

function encodeCursor(lastEvaluatedKey: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const key = parsed as Record<string, unknown>;
    const entries = Object.entries(key);
    // A DynamoDB key is 1..3 attributes, each a string or number (the only
    // key-attribute scalar types we use). Reject anything else outright.
    if (entries.length < 1 || entries.length > 3) return undefined;
    for (const [, v] of entries) {
      if (typeof v !== 'string' && typeof v !== 'number') return undefined;
    }
    return key;
  } catch {
    return undefined;
  }
}

// MediaStore.put wants a Readable; wrap the finished transcode buffer.
function bufferToStream(buf: Buffer): Readable {
  return Readable.from([buf]);
}

export function createUnitsRouter(deps: UnitsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const mediaStore = deps.mediaStore;
  const transcodeGate = deps.transcodeGate ?? sharedTranscodeGate;

  const router = Router();

  // Presign-mint spend/abuse fence (unit-photos direct-upload R2): the SAME
  // per-user limiter class as the MMS upload endpoint, 30/min. A cheap fence on
  // presigned-POST minting (local SigV4, no S3 round trip; the bytes go
  // browser->S3, never through here - so there is NO memory concern and no
  // concurrency gate). ONE request mints MANY grants, so staff never feel it.
  // ONE instance per router (per-request creation would reset the window). The
  // manage routes (remove/cover) match the unit PATCH posture: no limiter
  // (design S4); confirm now carries its OWN, heavier fence below.
  const photoPresignLimiter = createUserRateLimit({
    routeKey: 'unit_photo_presign',
    max: 30,
    windowMs: 60_000,
    logger: log,
  });

  // Confirm is now the EXPENSIVE unit-photo endpoint (unit-photo-transcode): a
  // >5MB source is downloaded + sharp-transcoded behind the SHARED process-wide
  // gate (one memory bound with MMS confirm). The gate bounds memory but is the
  // only backpressure - without a per-user fence one caller can keep both slots
  // + both cores pinned and 503 everyone else (incl. MMS media confirm). The
  // fence kills scripted tight loops, NOT the dashboard's own serial pace:
  // D5 chunking deliberately sends each >5MB file in its OWN confirm, so a
  // bulk big-photo drop is MANY requests. 60/min (Cameron, 2026-07-21 review
  // P2 - raised from the initial 30): a transcode-bearing confirm usually
  // takes ~2-5s, but fast transcodes (~6MB sources) plus the batched small
  // confirm can legitimately exceed 30 requests inside one 60s window on a
  // 35+ photo drop, and UNIT_MEDIA_MAX is 100 - so 30 was reachable by real
  // staff. 60 gives 2x headroom over the fastest physically-realizable
  // dashboard pace and still stops free-loop abuse (each admitted request
  // stays bounded by the shared gate + the per-request transcode cap).
  // ONE instance per router.
  const photoConfirmLimiter = createUserRateLimit({
    routeKey: 'unit_photo_confirm',
    max: 60,
    windowMs: 60_000,
    logger: log,
  });

  /** sha256-prefix marker for an entry - audit trails record this, NEVER the key/URL. */
  const entryHash = (entry: string): string =>
    createHash('sha256').update(entry).digest('hex').slice(0, 12);

  /**
   * BE3/C3 FIX: enrich a unit's roster at READ time. For each UnitContact (incl.
   * the back-compat landlord row synthesized from landlordId), resolve the
   * contact and set `name` (firstName+lastName) + `company` from the CURRENT
   * contact doc — so the roster never goes stale on rename and the synthesized
   * landlord row is self-describing too. Best-effort: a missing/failed lookup
   * leaves name/company absent (the client falls back to the id) and NEVER
   * throws (consistent with /api/today's read-time enrichment). Contacts are
   * deduped per contactId (a roster is small).
   */
  async function enrichRoster(unit: UnitItem): Promise<UnitContact[]> {
    const roster = unitContacts(unit);
    const byId = new Map<string, ContactItem | undefined>();
    for (const row of roster) {
      if (byId.has(row.contactId)) continue;
      try {
        byId.set(row.contactId, await contacts.getById(row.contactId));
      } catch (err) {
        // Never 500 the roster on a contact-lookup failure.
        log.warn({ unitId: unit.unitId, contactId: row.contactId, err }, 'roster enrich: contact lookup failed (best-effort)');
        byId.set(row.contactId, undefined);
      }
    }
    return roster.map((row) => {
      const contact = byId.get(row.contactId);
      const name = contact ? displayNameOfContact(contact) : undefined;
      const company =
        contact && typeof contact['company'] === 'string' ? (contact['company'] as string) : undefined;
      // Read-time enrichment is authoritative: drop any stale stored name/company
      // and re-set ONLY when the contact currently carries one.
      const { name: _staleName, company: _staleCompany, ...rest } = row;
      return {
        ...rest,
        ...(name !== undefined && { name }),
        ...(company !== undefined && { company }),
      };
    });
  }

  // GET /api/units — filtered list. Exactly one filter is honored, in priority
  // order landlordId > status > jurisdiction (each a single-partition Query);
  // with no filter, a paginated Scan (repo.list). This keeps every list read a
  // bounded operation.
  router.get('/', async (req, res) => {
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }

    let exclusiveStartKey: Record<string, unknown> | undefined;
    const rawCursor = req.query['cursor'];
    if (rawCursor !== undefined) {
      exclusiveStartKey = typeof rawCursor === 'string' ? decodeCursor(rawCursor) : undefined;
      if (exclusiveStartKey === undefined) {
        res.status(400).json({ error: 'invalid cursor' });
        return;
      }
    }

    // ?deleted=true → the "Deleted" view (ONLY soft-deleted properties); omitted/
    // anything else → exclude deleted (every normal list path below).
    const rawDeleted = req.query['deleted'];
    const deleted = rawDeleted === 'true' || rawDeleted === '1';

    const opts: ListUnitsOpts = {
      limit,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      ...(deleted && { deleted: true }),
    };

    const landlordId = req.query['landlordId'];
    const status = req.query['status'];
    const jurisdiction = req.query['jurisdiction'];

    let page: UnitsPage;
    if (typeof landlordId === 'string' && landlordId.length > 0) {
      page = await units.listByLandlord(landlordId, opts);
    } else if (typeof status === 'string' && status.length > 0) {
      page = await units.listByStatus(status, opts);
    } else if (typeof jurisdiction === 'string' && jurisdiction.length > 0) {
      page = await units.listByJurisdiction(jurisdiction, opts);
    } else {
      page = await units.list(opts);
    }

    res.json({
      units: page.items,
      nextCursor:
        page.lastEvaluatedKey !== undefined ? encodeCursor(page.lastEvaluatedKey) : null,
    });
  });

  // POST /api/units — create a unit.
  router.post('/', async (req: AuthedRequest, res) => {
    const validation = validateUnitBody(req.body, 'create');
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    // status is NOT a writable CRUD field (§8: property-status changes route
    // through PATCH /api/units/:unitId/listing-status). Create is not a
    // transition, but the denormalized provenance must be initialized: a new
    // property starts in 'setup' (§6: being prepped, NOT yet shareable — only
    // 'available' is shareable), stamped status_source 'derived' (NOT 'manual')
    // so it stays a derivation-permitting baseline. Staff move setup → available
    // (the publish/ready action) via PATCH /api/units/:unitId/listing-status,
    // and a committed placement then derives it onward to under_application/
    // finalizing/occupied (§7). landlordId is guaranteed by validation.
    const fields = validation.fields;
    const unit = await units.create({
      landlordId: fields['landlordId'] as string,
      status: 'setup',
      status_source: 'derived',
      ...fields,
    });
    mergeContext({});
    await audit.append(`units#${unit.unitId}`, 'unit_created', {
      actor: req.user?.userId,
      landlordId: unit.landlordId,
      status: unit.status,
    });
    log.info({ unitId: unit.unitId, actor: req.user?.userId }, 'unit created via api');
    res.status(201).json({ unit });
  });

  // GET /api/units/:unitId — one unit. BE3/C3: the returned unit is a strict
  // SUPERSET of the legacy shape — every stored field (incl. landlordId) is
  // preserved, plus a `contacts` roster (via unitContacts: the stored roster
  // when present, else the back-compat single-row roster derived from
  // landlordId). The serializer never mutates the stored item.
  router.get('/:unitId', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    // unit-photos: resolve stored media keys to stable same-origin /unit-media
    // URLs (design 2026-07-21) ALONGSIDE the raw `media` (the management handle).
    const mediaDisplay = resolveUnitMedia(unit, { logger: log });
    res.json({ unit: { ...unit, contacts: await enrichRoster(unit), mediaDisplay } });
  });

  // POST /api/units/:unitId/photos/presign  body { count, contentTypes[] }
  // (unit-photos direct-upload R2). Mints `count` presigned-POST grants so the
  // BROWSER uploads each file DIRECTLY to S3 - the bytes never touch this
  // process, so there is no memory fence and no concurrency gate (that whole
  // class dissolves). Each grant is keyed `unit-media/<unitId>/<uuid>` (a
  // server-minted uuid; the browser never chooses a key) with a policy pinned
  // to that file's image Content-Type + the 1..5MB size range. VALIDATE first:
  // the unit exists + is not deleted (404); count is 1..batch-max; every
  // contentType is an allowed image type (400); existing + count <= the 100 cap
  // (400 photo_cap_exceeded - a friendly pre-check; confirm re-guards
  // atomically). 503 when the store is unconfigured. Behind the presign limiter.
  router.post('/:unitId/photos/presign', photoPresignLimiter, async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    const count = b['count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > UNIT_PHOTO_PRESIGN_BATCH_MAX) {
      res.status(400).json({ error: `count must be an integer 1..${UNIT_PHOTO_PRESIGN_BATCH_MAX}` });
      return;
    }
    const contentTypes = b['contentTypes'];
    if (!Array.isArray(contentTypes) || contentTypes.length !== count) {
      res.status(400).json({ error: 'contentTypes must be an array of length count' });
      return;
    }
    // Every requested type must be an allowed image type (jpeg/png/gif/webp) -
    // the SAME allowlist the display resolution + confirm re-check use.
    const normalized: string[] = [];
    for (const ct of contentTypes) {
      const type = typeof ct === 'string' ? ct.trim().toLowerCase() : '';
      if (!isImageMediaType(type)) {
        res.status(400).json({ error: 'unsupported_media_type' });
        return;
      }
      normalized.push(type);
    }

    // The unit must exist and not be deleted (404) - never mint a grant for a
    // phantom or a soft-deleted property.
    const unit = await units.getById(unitId);
    if (!unit || isDeleted(unit)) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    // 100-photo cap pre-check (D3 abuse backstop). A friendly 400 here; confirm's
    // atomic appendMedia re-guards it under a race.
    const existing = Array.isArray(unit.media) ? unit.media.length : 0;
    if (existing + count > UNIT_MEDIA_MAX) {
      res.status(400).json({ error: 'photo_cap_exceeded' });
      return;
    }

    // Mint one grant per file, each under a fresh server-minted key with the
    // file's own content-type policy. Minting is local SigV4 - no S3 round trip.
    const uploads = await Promise.all(
      normalized.map(async (contentType) => {
        const key = `${unitMediaPrefix(unitId)}${randomUUID()}`;
        const post = await mediaStore.createPresignedPost(key, {
          contentType,
          maxBytes: UNIT_PHOTO_SOURCE_MAX_BYTES,
        });
        return { key, post };
      }),
    );
    log.info({ unitId, count, actor: req.user?.userId }, 'unit photo presign grants minted');
    res.json({ uploads });
  });

  // POST /api/units/:unitId/photos/confirm  body { keys[] } (unit-photos
  // direct-upload R2). Records the keys the browser uploaded directly to S3.
  // Order of guards: body shape -> keys[] bounded 1..UNIT_MEDIA_MAX (a body
  // with more keys than the WHOLE-unit cap can never fit, and bounding it up
  // front means an oversized body never costs one HeadObject per key) -> the
  // unit exists and is not soft-deleted (404, mirroring presign - never append
  // photos to a phantom or deleted property). Then, for EACH key, defense in
  // depth: (a) it MUST start with the unit's own `unit-media/<unitId>/` prefix
  // (rejects a foreign / cross-unit / uploads/ key even though keys are
  // server-minted); (b) it is not a duplicate within the body and not ALREADY
  // on the unit (idempotent retries - see below); (c) HeadObject succeeds (the
  // object was actually uploaded); (d) the stored Content-Type is an allowed
  // image type (else dropped), then the stored SIZE is classified
  // (unit-photo-transcode): <= 5MB is appended as-is (today's byte-identical
  // path); > 20MB is dropped (the presign policy already forbids it - defense
  // in depth); 5MB < size <= 20MB is FITTED at confirm - behind the SHARED
  // process-wide transcode gate it is downloaded, transcoded to a 2560/q85
  // jpeg, put at a FRESH uuid key, and that RENDITION key is appended in place
  // of the oversize original (left as an accepted orphan). REPLAY CAVEAT
  // (spec D4): the idempotent-replay skip in guard (b) matches on the appended
  // entry, so a replayed >5MB SOURCE key (whose appended entry is a fresh
  // rendition uuid, never the source key) never matches and mints a SECOND
  // rendition - accepted per the design; the per-user confirm limiter fences the
  // replay-as-DoS angle (issue unit-photo-confirm-replay-duplicate-renditions).
  // API-CLIENT CAUTION (review N3, recorded 2026-07-21): a MIXED body (some
  // valid keys + some failed/undecodable keys) returns 200 with the failures
  // SILENTLY dropped - transcode_failed only surfaces when NO key survives.
  // Fine for the dashboard (it never mixes: big files are confirmed alone),
  // but a future client submitting mixed bodies must diff its request keys
  // against the returned unit.media to detect per-key drops.
  // A key failing (a)/(c)/(d) or whose transcode fails is DROPPED with a logged
  // warn (unitId + byte counts only, never keys); if NO key survives -> 400
  // (transcode_failed when a >5MB source was undecodable, else no_valid_photos),
  // UNLESS every valid key was already present (a replayed confirm) -> 200 with
  // the current unit. Gate starvation aborts the WHOLE request with 503
  // transcode_busy before any append (all-or-nothing; the dashboard sends each
  // >5MB file in its own confirm). Before the transcode loop the >5MB count is
  // bounded (> UNIT_PHOTO_TRANSCODE_MAX_PER_REQUEST -> 400 too_many_large_photos)
  // and an EARLY cap pre-check (existing + survivors + pending > 100 -> 400
  // photo_cap_exceeded) rejects an at-cap request BEFORE paying any transcode.
  // Surviving keys then pass a friendly post-loop cap pre-check (existing + new
  // <= 100 -> else 400 photo_cap_exceeded) and are committed via ONE atomic
  // appendMedia - its ConditionExpression + batch bound re-guard the cap under a
  // race (ConditionalCheckFailed -> same 400).
  // Audit unit_photos_added COUNT only, BEST-EFFORT (the media append has
  // already committed; a transient audit failure must not 500 a confirm whose
  // photos are stored). Returns the updated unit (with mediaDisplay). An
  // ordinary async handler - no busboy, no callback outside Express's
  // async-error capture, so the F3 hang class simply does not exist here.
  // Behind the per-user confirm limiter (unit_photo_confirm, 30/min - confirm
  // now transcodes; sized for the dashboard's one-confirm-per-big-file pace).
  // 503 when the store is unconfigured.
  router.post('/:unitId/photos/confirm', photoConfirmLimiter, async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    if (!mediaStore) {
      res.status(503).json({ error: 'media_storage_unavailable' });
      return;
    }
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const rawKeys = (body as Record<string, unknown>)['keys'];
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
      res.status(400).json({ error: 'keys must be a non-empty array' });
      return;
    }
    // Bound the raw body BEFORE any per-key S3 work: more keys than the cap
    // can never fit on the unit, so reject up front (same shape as the cap
    // checks below) instead of doing thousands of HeadObjects first.
    if (rawKeys.length > UNIT_MEDIA_MAX) {
      res.status(400).json({ error: 'photo_cap_exceeded' });
      return;
    }

    // Mirror presign: the unit must exist and not be soft-deleted (404) -
    // appendMedia's attribute_exists(unitId) alone would happily append to a
    // SOFT-deleted unit (the item still exists) and would surface a HARD-deleted
    // one as a misleading photo_cap_exceeded. Also gives us the current media
    // for the dedup + cap pre-checks below.
    const unit = await units.getById(unitId);
    if (!unit || isDeleted(unit)) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const existingMedia = Array.isArray(unit.media)
      ? unit.media.filter((e): e is string => typeof e === 'string')
      : [];
    const existingSet = new Set(existingMedia);

    const ownPrefix = unitMediaPrefix(unitId);
    const seen = new Set<string>();
    const survivors: string[] = [];
    const transcodePending: { key: string; sourceType: string }[] = [];
    let alreadyPresent = 0;
    for (const raw of rawKeys) {
      const key = typeof raw === 'string' ? raw : '';
      // (a) prefix scope - defense in depth beyond the minted-key design.
      if (!key.startsWith(ownPrefix)) {
        log.warn({ unitId }, 'unit photos confirm: key outside the unit namespace - dropped');
        continue;
      }
      // (b) idempotency: a key repeated within the body appends ONCE, and a key
      // ALREADY on the unit (a replayed confirm after a lost response) is
      // skipped rather than double-appended. Already-present keys skip the
      // HeadObject too - they were verified when first confirmed. CAVEAT
      // (spec D4): this holds for PASSTHROUGH (<=5MB) keys, whose submitted key
      // IS the appended entry; a replayed >5MB SOURCE key never matches here
      // (its appended entry is a fresh rendition uuid), so a replay re-transcodes
      // and mints a SECOND rendition - accepted per the design (the confirm
      // limiter fences the replay-as-DoS angle; issue
      // unit-photo-confirm-replay-duplicate-renditions tracks the dedupe option).
      if (seen.has(key)) continue;
      seen.add(key);
      if (existingSet.has(key)) {
        alreadyPresent += 1;
        continue;
      }
      // (c) the object was actually uploaded; (d) re-check the stored type, then
      // classify by size (unit-photo-transcode): <=5MB passthrough, >5MB fit.
      let head;
      try {
        head = await mediaStore.head(key);
      } catch (err) {
        log.warn({ err, unitId }, 'unit photos confirm: head failed - key dropped');
        continue;
      }
      if (!head) {
        log.warn({ unitId }, 'unit photos confirm: object missing - key dropped');
        continue;
      }
      if (!isImageMediaType(head.contentType)) {
        log.warn({ unitId }, 'unit photos confirm: stored type re-check failed - key dropped');
        continue;
      }
      const size = head.size ?? Infinity;
      if (size > UNIT_PHOTO_SOURCE_MAX_BYTES) {
        // The presign policy already forbids this; defense in depth.
        log.warn({ unitId }, 'unit photos confirm: stored size over the source cap - key dropped');
        continue;
      }
      if (size <= UNIT_PHOTO_PASSTHROUGH_MAX_BYTES) {
        // <=5MB: stored byte-identical - the pre-transcode behavior, unchanged.
        survivors.push(key);
        continue;
      }
      // >5MB: fit at confirm (design 2026-07-21) - transcoded below, behind the gate.
      transcodePending.push({ key, sourceType: head.contentType!.trim().toLowerCase() });
    }

    // P-2: bound the number of >5MB transcodes ONE request may drive. The
    // dashboard confirms each oversize file alone (D5), so a real client submits
    // 1; this caps the worst-case occupancy a hand-crafted body can impose on the
    // SHARED gate. Reject BEFORE any download/transcode so no work is paid.
    if (transcodePending.length > UNIT_PHOTO_TRANSCODE_MAX_PER_REQUEST) {
      res.status(400).json({ error: 'too_many_large_photos' });
      return;
    }

    // MF-2b: EARLY cap pre-check BEFORE the transcode loop. Each pending
    // transcode yields at most one rendition survivor, so if existing +
    // passthrough survivors + pending already exceeds the cap the request cannot
    // fit - reject now rather than paying the transcode(s) and orphaning their
    // renditions (an at-cap unit otherwise pays a full download+sharp+put before
    // the post-loop 400). The post-loop check below still re-guards the committed
    // survivor count, and appendMedia re-guards atomically under a race.
    if (existingMedia.length + survivors.length + transcodePending.length > UNIT_MEDIA_MAX) {
      res.status(400).json({ error: 'photo_cap_exceeded' });
      return;
    }

    // >5MB sources: download + fit to the photo rendition profile, behind the
    // SHARED process-wide gate (one raster memory bound with MMS confirm). The
    // rendition is appended under a FRESH uuid key - indistinguishable from a
    // direct upload, so display/flyer/namespace-guard need no changes. The
    // oversize ORIGINAL stays as an accepted orphan (issue
    // unit-photo-removal-never-deletes-s3-objects). A per-key transcode failure
    // drops THAT key (confirm's per-key posture); gate starvation is a
    // request-level 503 (memory pressure, not this key's fault). PII: byte
    // counts + unitId only - never keys/filenames.
    let transcodeFailed = 0;
    for (const pending of transcodePending) {
      // Acquire in its own try so a gate timeout is a request-level 503
      // (all-or-nothing), not a per-key drop. `release` is assigned before the
      // work try/finally below, so it is definitely-assigned there and stays
      // NON-optional (DEC-4) - release() ALWAYS runs after a successful acquire.
      let release: () => void;
      try {
        release = await transcodeGate.acquire(MMS_TRANSCODE_WAIT_TIMEOUT_MS);
      } catch {
        res.status(503).json({ error: 'transcode_busy' });
        return;
      }
      try {
        const bytes = await mediaStore.getBytes(pending.key);
        if (!bytes) {
          transcodeFailed += 1;
          log.warn({ unitId }, 'unit photo transcode: source vanished - key dropped');
          continue;
        }
        const result = await transcodeForUnitPhoto(bytes, pending.sourceType);
        if (result.bytes.length > UNIT_PHOTO_PASSTHROUGH_MAX_BYTES) {
          // Practically unreachable at 2560px, but the stored-photo invariant holds.
          transcodeFailed += 1;
          log.warn(
            { unitId, byteCount: result.bytes.length },
            'unit photo transcode: rendition over the stored cap - key dropped',
          );
          continue;
        }
        const renditionKey = `${ownPrefix}${randomUUID()}`;
        await mediaStore.put(renditionKey, bufferToStream(result.bytes), result.contentType);
        log.info(
          {
            unitId,
            sourceBytes: bytes.length,
            renditionBytes: result.bytes.length,
            transcodedFrom: result.transcodedFrom,
          },
          'unit photo transcoded',
        );
        survivors.push(renditionKey);
      } catch (err) {
        transcodeFailed += 1;
        log.warn({ err, unitId }, 'unit photo transcode failed - key dropped');
      } finally {
        release();
      }
    }

    if (survivors.length === 0) {
      // Idempotent retry semantics: when every valid key is ALREADY on the
      // unit this is a replayed confirm - succeed with the current unit (no
      // append, no audit) so a client retry after a lost response is safe.
      // Only a body with no valid key AT ALL is an error.
      if (alreadyPresent > 0) {
        const mediaDisplay = resolveUnitMedia(unit, { logger: log });
        res.json({ unit: { ...unit, mediaDisplay } });
        return;
      }
      res.status(400).json({ error: transcodeFailed > 0 ? 'transcode_failed' : 'no_valid_photos' });
      return;
    }

    // Friendly cap pre-check mirroring presign's - and the route-level guard
    // that (with appendMedia's own batch bound) closes the first-append cap
    // bypass. appendMedia re-guards atomically under a race.
    if (existingMedia.length + survivors.length > UNIT_MEDIA_MAX) {
      res.status(400).json({ error: 'photo_cap_exceeded' });
      return;
    }

    let updated: UnitItem;
    try {
      updated = await units.appendMedia(unitId, survivors);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // The atomic cap re-guard lost a race (a concurrent confirm filled the
        // unit) or the unit vanished mid-request. Same shape/copy as the
        // presign pre-check. Nothing partial reaches the client.
        log.warn({ err, unitId, count: survivors.length }, 'unit photos confirm: append cap re-guard rejected');
        res.status(400).json({ error: 'photo_cap_exceeded' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
    // PII / doc: COUNT only - never filenames or keys in the audit payload.
    // BEST-EFFORT by design: the media append above has already committed, so
    // a transient audit failure logs and continues - it must never 500 a
    // confirm whose photos are stored (the client would drop the fresh unit).
    try {
      await audit.append(`units#${unitId}`, 'unit_photos_added', {
        actor: req.user?.userId,
        count: survivors.length,
      });
    } catch (err) {
      log.warn({ err, unitId }, 'unit photos confirm: audit append failed - continuing (best-effort)');
    }
    log.info({ unitId, count: survivors.length, actor: req.user?.userId }, 'unit photos confirmed via api');
    const mediaDisplay = resolveUnitMedia(updated, { logger: log });
    res.json({ unit: { ...updated, mediaDisplay } });
  });

  // DELETE /api/units/:unitId/photos  body { entry } - drop one media entry
  // (unit-photos S4). Removes the array entry AND best-effort-deletes its S3
  // object when it is an own-namespace stored key (design 2026-07-21, D1; legacy
  // absolute URLs + foreign keys are never deleted). The delete is fire-and-
  // forget - a failure is a WARN, never a 500 - and a removed photo may keep
  // serving from CloudFront edge caches up to the 7-day TTL (accepted; manual
  // invalidation is the operator escape hatch). 404 on unknown unit or unknown
  // entry; audits unit_photo_removed (entry-HASH + count only, never the
  // key/URL). Returns the updated unit (with mediaDisplay).
  router.delete('/:unitId/photos', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const entry = (body as Record<string, unknown>)['entry'];
    if (typeof entry !== 'string' || entry.length === 0) {
      res.status(400).json({ error: 'entry is required' });
      return;
    }
    let updated: UnitItem;
    try {
      updated = await units.removeMedia(unitId, entry);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Unknown unit OR entry-not-on-unit - both 404 (no existence oracle).
        res.status(404).json({ error: 'unit_or_photo_not_found' });
        return;
      }
      throw err;
    }
    // D1: best-effort-delete the S3 object for the removed entry (own-namespace
    // stored keys only; the helper skips legacy URLs + foreign keys). Fire-and-
    // forget - never affects this response.
    //
    // DANGLING-REFERENCE RACE (review S1, accepted + documented, LOW probability;
    // docs/issues/unit-media-dangling-reference-race.md): removeMedia is a
    // NON-ATOMIC read-modify-write (unitsRepo.ts:710), so a CONCURRENT makeCover /
    // PATCH that read the pre-delete list can commit AFTER this delete and re-
    // persist the just-deleted key - leaving unit.media pointing at an object
    // whose bytes are gone (a broken <img> on the dashboard AND the public flyer
    // until a staff re-edit). Before D1 the same interleaving merely resurrected a
    // stale-but-working entry; the delete is what makes it customer-visible.
    // Accepted (self-healing by re-upload); remedies in the issue if it ever bites.
    deleteRemovedUnitMedia(mediaStore, unitId, [entry], log);
    await audit.append(`units#${unitId}`, 'unit_photo_removed', {
      actor: req.user?.userId,
      entryHash: entryHash(entry),
      remaining: Array.isArray(updated.media) ? updated.media.length : 0,
    });
    log.info({ unitId, actor: req.user?.userId }, 'unit photo removed via api');
    const mediaDisplay = resolveUnitMedia(updated, { logger: log });
    res.json({ unit: { ...updated, mediaDisplay } });
  });

  // PUT /api/units/:unitId/photos/cover  body { entry } - make `entry` the cover
  // (move to front = hero + flyer lead photo; unit-photos S4). No-op success when
  // it is already the cover. 404 on unknown unit or unknown entry; audits
  // unit_photo_cover_set (entry-HASH only). Returns the updated unit.
  router.put('/:unitId/photos/cover', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const entry = (body as Record<string, unknown>)['entry'];
    if (typeof entry !== 'string' || entry.length === 0) {
      res.status(400).json({ error: 'entry is required' });
      return;
    }
    let updated: UnitItem;
    try {
      updated = await units.makeCover(unitId, entry);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_or_photo_not_found' });
        return;
      }
      throw err;
    }
    await audit.append(`units#${unitId}`, 'unit_photo_cover_set', {
      actor: req.user?.userId,
      entryHash: entryHash(entry),
    });
    log.info({ unitId, actor: req.user?.userId }, 'unit photo cover set via api');
    const mediaDisplay = resolveUnitMedia(updated, { logger: log });
    res.json({ unit: { ...updated, mediaDisplay } });
  });

  // Individual flyer sends are the SEEDED broadcast-pipeline flow (see
  // docs/superpowers/specs/2026-07-10-matching-property-sends-design.md):
  // a draft created with seedContactIds sends through the same fan-out and
  // records listing_sends per recipient. No separate individual-send route.

  // GET /api/units/:unitId/recipients — the "Sent to tenants" list (BE4/C4).
  // Returns { recipients: ListingSendRow[] } from listByUnit. Mirrors the units
  // 404 posture: an unknown unit is a 404 (consistent with GET /:unitId); a real
  // unit with zero recipients returns []. (`recipients` is a distinct segment
  // from the bare :unitId routes, so there is no route collision.)
  router.get('/:unitId/recipients', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const rows = await listingSends.listByUnit(unitId);
    // Derive the per-row tour chip from the unit's tours (ONE byUnit GSI query,
    // grouped by tenantId). Best-effort (E3): a tours-query failure serves the
    // rows WITHOUT any tour field and logs - the roster never 500s on the join.
    let toursByTenant: Map<string, TourItem[]> | undefined;
    try {
      const unitTours = await tours.listByUnit(unitId);
      toursByTenant = new Map<string, TourItem[]>();
      for (const t of unitTours) {
        const arr = toursByTenant.get(t.tenantId);
        if (arr === undefined) toursByTenant.set(t.tenantId, [t]);
        else arr.push(t);
      }
    } catch (err) {
      log.warn({ err, unitId }, 'recipients tour-chip hydration failed (best-effort)');
    }
    // Denormalize each recipient's display name (same contacts join the roster
    // uses). Best-effort like the tour join: a failed lookup serves the row
    // nameless (the dashboard falls back to the id) - never a 500. Lookups are
    // deduped by contactId so a tenant sent to N times costs one read.
    const namesByContact = new Map<string, string | undefined>();
    for (const row of rows) {
      if (namesByContact.has(row.contactId)) continue;
      try {
        const contact = await contacts.getById(row.contactId);
        namesByContact.set(row.contactId, contact ? displayNameOfContact(contact) : undefined);
      } catch (err) {
        log.warn({ err, unitId, contactId: row.contactId }, 'recipients name hydration failed (best-effort)');
        namesByContact.set(row.contactId, undefined);
      }
    }
    res.json({
      recipients: rows.map((row) => {
        const pairing = toursByTenant?.get(row.contactId);
        const signal = pairing !== undefined ? deriveTourSignal(pairing) : undefined;
        return toListingSendRow(row, signal, namesByContact.get(row.contactId));
      }),
    });
  });

  // POST /api/units/:unitId/contacts { contactId, role, primaryVoice? } (BE3/C3).
  // Add (or update) a roster contact → { unit } (with contacts). The ROUTE
  // resolves the contact's denormalized name/company (so the roster row is
  // self-describing); the repo maintains the single-primaryVoice invariant and
  // keeps primary_voice_contact (voice routing) consistent. 404 unknown unit /
  // unknown contact; 400 bad role / primaryVoice; audit unit_contact_added.
  router.post('/:unitId/contacts', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;
    const contactId = b['contactId'];
    if (typeof contactId !== 'string' || contactId.length === 0) {
      res.status(400).json({ error: 'contactId is required' });
      return;
    }
    const role = b['role'];
    if (!isUnitContactRole(role)) {
      res.status(400).json({ error: `role must be one of: ${UNIT_CONTACT_ROLES.join(', ')}` });
      return;
    }
    const primaryVoiceRaw = b['primaryVoice'];
    if (primaryVoiceRaw !== undefined && typeof primaryVoiceRaw !== 'boolean') {
      res.status(400).json({ error: 'primaryVoice must be a boolean' });
      return;
    }
    const primaryVoice = primaryVoiceRaw === true;

    // The unit must exist (404). We check up-front so an unknown unit is a clean
    // 404 distinct from the unknown-contact 404 below.
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }

    // Resolve the contact for denormalization (404 when the contact doesn't
    // exist — never roster a phantom). name/company are best-effort honest:
    // omitted when unknown, never invented.
    const contact = await contacts.getById(contactId);
    if (!contact) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    const name = displayNameOfContact(contact);
    const company = typeof contact['company'] === 'string' ? (contact['company'] as string) : undefined;

    const updated = await units.addContact(unitId, {
      contactId,
      role,
      primaryVoice,
      ...(name !== undefined && { name }),
      ...(company !== undefined && { company }),
    });
    await audit.append(`units#${unitId}`, 'unit_contact_added', {
      actor: req.user?.userId,
      contactId,
      role,
      primaryVoice,
    });
    log.info({ unitId, contactId, role, primaryVoice, actor: req.user?.userId }, 'unit contact added via api');
    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });
  });

  // DELETE /api/units/:unitId/contacts/:contactId (BE3/C3) → { unit }. 404
  // unknown unit / contact-not-on-roster; 409 removing the primary landlord
  // (cannot_remove_primary_landlord — reassign landlordId first); audit
  // unit_contact_removed.
  router.delete('/:unitId/contacts/:contactId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const contactId = String(req.params['contactId'] ?? '');
    let updated: UnitItem;
    try {
      updated = await units.removeContact(unitId, contactId);
    } catch (err) {
      if (err instanceof CannotRemovePrimaryLandlordError) {
        res.status(409).json({ error: 'cannot_remove_primary_landlord' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        // Unknown unit OR contact-not-on-roster — both 404 (mirrors the unit
        // 404 posture; the message distinguishes them in logs only).
        res.status(404).json({ error: 'unit_or_contact_not_found' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
    await audit.append(`units#${unitId}`, 'unit_contact_removed', {
      actor: req.user?.userId,
      contactId,
    });
    log.info({ unitId, contactId, actor: req.user?.userId }, 'unit contact removed via api');
    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });
  });

  // GET /api/units/:unitId/related → { related: RelatedUnit[] } (BE3/C3). 404
  // unknown unit. same_property = the byProperty siblings (when propertyId set)
  // minus self; same_landlord = listByLandlord minus self AND minus any unit
  // already counted as same_property (a sibling shouldn't appear twice). Order:
  // same_property first, then same_landlord.
  router.get('/:unitId/related', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }

    const seen = new Set<string>([unitId]); // never relate a unit to itself
    const related: RelatedUnit[] = [];

    // same_property — the building/duplex group (sparse byProperty GSI).
    if (typeof unit.propertyId === 'string' && unit.propertyId.length > 0) {
      const siblings = await units.listByProperty(unit.propertyId);
      for (const u of siblings.items) {
        if (seen.has(u.unitId)) continue;
        seen.add(u.unitId);
        related.push(toRelatedUnit(u, 'same_property', 'Same building'));
      }
    }

    // same_landlord — other units owned by the same landlord, deduped against
    // self + the same_property siblings already added.
    if (typeof unit.landlordId === 'string' && unit.landlordId.length > 0) {
      const owned = await units.listByLandlord(unit.landlordId);
      for (const u of owned.items) {
        if (seen.has(u.unitId)) continue;
        seen.add(u.unitId);
        related.push(toRelatedUnit(u, 'same_landlord', 'Same landlord'));
      }
    }

    res.json({ related });
  });

  // GET /api/units/:unitId/placements → { placements: Array<PlacementItem & { tenantName }> }
  // (FIX 3). The "Placements on this property" read: every placement on this unit,
  // each enriched with the tenant's display name resolved at READ time (null when
  // the tenant has no contact — never 500). 404 unknown unit (matches GET /:id).
  // Bounded (a unit has few placements); `placements` is a distinct segment so
  // there is no route collision with the bare :unitId routes.
  router.get('/:unitId/placements', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const { items } = await placements.listByUnit(unitId);
    // Resolve tenant names at read time, deduped per tenantId (a unit's placements
    // are few but may share a tenant). A missing/failed lookup → tenantName null.
    const nameByTenant = new Map<string, string | null>();
    for (const c of items) {
      if (nameByTenant.has(c.tenantId)) continue;
      try {
        const contact = await contacts.getById(c.tenantId);
        nameByTenant.set(c.tenantId, contact ? (displayNameOfContact(contact) ?? null) : null);
      } catch (err) {
        log.warn({ unitId, tenantId: c.tenantId, err }, 'unit placements: tenant lookup failed (best-effort)');
        nameByTenant.set(c.tenantId, null);
      }
    }
    const enriched = items.map((c: PlacementItem) => ({
      ...c,
      tenantName: nameByTenant.get(c.tenantId) ?? null,
    }));
    res.json({ placements: enriched });
  });

  // GET /api/units/:unitId/similar → { similar: SimilarUnit[] } (BE5/C6). 404
  // unknown unit. Ranks the AVAILABLE units by attribute similarity (beds, area/
  // subzone, rent band, accepted programs) to the target via the pure,
  // deterministic rankSimilarUnits, returning the top N. (When the target itself
  // is not available, it still ranks available alternatives — the endpoint
  // surfaces "what else like this is open".) `similar` is a distinct segment
  // from the bare :unitId routes, so there is no route collision.
  router.get('/:unitId/similar', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    // Sweep ALL available units before ranking — the ranker must see the whole
    // open inventory, not one DynamoDB page (a best match could otherwise be on
    // a later page and silently missed). Loop on lastEvaluatedKey up to a sane
    // total cap; if the cap is hit with more remaining, log.warn (no silent
    // truncation — the ranker ran on a prefix only).
    const candidates: UnitItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let capped = false;
    do {
      const remaining = SIMILAR_SCAN_LIMIT - candidates.length;
      const page = await units.listByStatus('available', {
        limit: remaining,
        ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      });
      candidates.push(...page.items);
      exclusiveStartKey = page.lastEvaluatedKey;
      if (candidates.length >= SIMILAR_SCAN_LIMIT && exclusiveStartKey !== undefined) {
        capped = true;
        break;
      }
    } while (exclusiveStartKey !== undefined);

    if (capped) {
      log.warn(
        { unitId, scanned: candidates.length, cap: SIMILAR_SCAN_LIMIT },
        'similar units: hit the available-scan cap — ranked a prefix of available units only',
      );
    }

    const similar = rankSimilarUnits(unit, candidates);
    log.info({ unitId, candidateCount: candidates.length, returned: similar.length }, 'similar units served');
    res.json({ similar });
  });

  // GET /api/units/:unitId/activity?limit= — the property Activity card read.
  // Serves the unit's AUDIT trail (entityKey `units#<unitId>` — unit_created /
  // unit_updated / roster changes / listing_status_changed
  // / delete+restore) NEWEST-FIRST via auditRepo.listByEntity, projected onto
  // UnitActivityEvent (fixed-key whitelist, never the raw payload). contactName
  // is resolved at read time (best-effort, mirrors /placements' tenantName).
  // Bounded-limit (1..MAX, default DEFAULT) — no cursor; a unit's trail is
  // small, and the repo's `before` bound is there when paging is ever needed.
  // 404 unknown unit (matches the sibling reads). NOTE: "property sent to
  // tenant" audits under broadcasts#<id>, so sends don't appear here — the
  // "Sent to tenants" card (GET /:unitId/recipients) is that view.
  router.get('/:unitId/activity', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const limit = parseLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_PAGE_LIMIT}` });
      return;
    }
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }

    const rows = await audit.listByEntity(`units#${unitId}`, { limit });
    const events = rows.map(toUnitActivityEvent);

    // Read-time contactName enrichment, deduped per contactId; a missing/failed
    // lookup leaves contactName absent (the client falls back to the id) and
    // NEVER 500s — same posture as /placements' tenantName.
    const nameByContact = new Map<string, string | undefined>();
    for (const e of events) {
      if (e.contactId === undefined || nameByContact.has(e.contactId)) continue;
      try {
        const contact = await contacts.getById(e.contactId);
        nameByContact.set(e.contactId, contact ? displayNameOfContact(contact) : undefined);
      } catch (err) {
        log.warn(
          { unitId, contactId: e.contactId, err },
          'unit activity: contact lookup failed (best-effort)',
        );
        nameByContact.set(e.contactId, undefined);
      }
    }
    for (const e of events) {
      const name = e.contactId !== undefined ? nameByContact.get(e.contactId) : undefined;
      if (name !== undefined) e.contactName = name;
    }

    // PII (doc §9): IDs/counts only — never labels/names/payloads in logs.
    log.info({ unitId, returned: events.length }, 'unit activity served');
    res.json({ events });
  });

  // PATCH /api/units/:unitId — partial update (SET-merge, no-overwrite).
  router.patch('/:unitId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const validation = validateUnitBody(req.body, 'update');
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
    }
    // D1 delete-on-removal (the raw E5 seam): `media` is PATCH-writable and a
    // wholesale replace can drop stored keys. Snapshot the PRIOR list BEFORE the
    // write - as a COPY, because a read-modify-write repo can return the SAME
    // object from getById and update, so reading prev.media AFTER the update
    // could observe the already-mutated value. Read-then-write is NOT atomic: an
    // append racing between this getById and the update can orphan its object
    // (the replace drops it without it appearing in prevMedia) - the same
    // accepted orphan class that existed before D1. The REVERSE interleaving is
    // the DANGLING-REFERENCE race (review S1, accepted + documented;
    // docs/issues/unit-media-dangling-reference-race.md): a concurrent removal
    // that best-effort-deletes an object's bytes can lose the commit ordering to a
    // later-committing write HERE that re-persists that key, leaving unit.media
    // referencing a deleted object (a broken image until re-edit). Both directions
    // stem from the non-atomic read-modify-write; both accepted as LOW-probability
    // and self-healing. An unknown unit yields no prior state here; the update
    // below still owns the 404 (ConditionalCheckFailed).
    const hasMediaPatch = Object.prototype.hasOwnProperty.call(validation.fields, 'media');
    let prevMedia: string[] = [];
    if (hasMediaPatch) {
      const prevMediaValue = (await units.getById(unitId))?.media;
      prevMedia = Array.isArray(prevMediaValue)
        ? prevMediaValue.filter((e): e is string => typeof e === 'string')
        : [];
    }
    let unit;
    try {
      unit = await units.update(unitId, validation.fields);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err; // Express 5 forwards async throws to the error handler.
    }
    if (hasMediaPatch) {
      // Diff prior vs next by set membership (string entries only); best-effort-
      // delete the removed own-namespace stored keys (the helper skips legacy
      // URLs + foreign keys). Fire-and-forget - never affects this response.
      const next = new Set(Array.isArray(unit.media) ? unit.media : []);
      const removed = prevMedia.filter((e) => !next.has(e));
      deleteRemovedUnitMedia(mediaStore, unitId, removed, log);
    }
    await audit.append(`units#${unitId}`, 'unit_updated', {
      actor: req.user?.userId,
      fields: Object.keys(validation.fields),
    });
    log.info(
      { unitId, fields: Object.keys(validation.fields).length, actor: req.user?.userId },
      'unit updated via api',
    );
    res.json({ unit });
  });

  // DELETE /api/units/:unitId → 200 { unit }. SOFT delete: stamps deleted_at so the
  // record + ALL its data are retained (POST .../restore brings it back), but it's
  // hidden from the property lists, the landlord's properties card, and related/similar.
  // Audited. 404 when the unit doesn't exist.
  router.delete('/:unitId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const deletedAt = new Date().toISOString();
    let unit;
    try {
      unit = await units.softDelete(unitId, deletedAt);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    await audit.append(`units#${unitId}`, 'unit_deleted', { actor: req.user?.userId, deletedAt });
    log.info({ unitId, actor: req.user?.userId }, 'unit soft-deleted via api');
    res.json({ unit });
  });

  // POST /api/units/:unitId/restore → 200 { unit }. Clear deleted_at, bringing a
  // soft-deleted property back into the normal views. Audited; 404 when missing.
  router.post('/:unitId/restore', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    let unit;
    try {
      unit = await units.restore(unitId);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    await audit.append(`units#${unitId}`, 'unit_restored', { actor: req.user?.userId });
    log.info({ unitId, actor: req.user?.userId }, 'unit restored via api');
    res.json({ unit });
  });

  return router;
}
