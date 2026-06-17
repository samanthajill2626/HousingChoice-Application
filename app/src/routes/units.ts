// Units CRUD router (M1.5) — mounted under /api/units, behind requireAuth via
// the /api mount (app.ts). VAs maintain listings day-to-day, so NO admin gate
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
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { mergeContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { validateUnitBody } from '../lib/unitFields.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createUnitsRepo,
  type ListUnitsOpts,
  type UnitsPage,
  type UnitsRepo,
} from '../repos/unitsRepo.js';
import {
  createListingSendsRepo,
  ListingSendNotFoundError,
  toListingSendRow,
  type ListingResponse,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';

export interface UnitsRouterDeps {
  logger?: Logger;
  unitsRepo?: UnitsRepo;
  auditRepo?: AuditRepo;
  /** BE4/C4: the listing-send record (recipients + response). */
  listingSendsRepo?: ListingSendsRepo;
  /** BE4/C4: emit a `listing_reviewed` milestone on a real interested/not_a_fit change. */
  activityEventsRepo?: ActivityEventsRepo;
}

/** The valid tenant responses (C4 `ListingResponse`). */
const LISTING_RESPONSES: readonly ListingResponse[] = ['interested', 'not_a_fit', 'no_reply'] as const;

function isListingResponse(value: unknown): value is ListingResponse {
  return typeof value === 'string' && (LISTING_RESPONSES as readonly string[]).includes(value);
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

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

export function createUnitsRouter(deps: UnitsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });

  const router = Router();

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

    const opts: ListUnitsOpts = {
      limit,
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
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
    // status defaults to 'available' when the caller omits it (a new listing is
    // available unless told otherwise); landlordId is guaranteed by validation.
    const fields = validation.fields;
    const unit = await units.create({
      landlordId: fields['landlordId'] as string,
      status: typeof fields['status'] === 'string' ? (fields['status'] as string) : 'available',
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

  // GET /api/units/:unitId — one unit.
  router.get('/:unitId', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    res.json({ unit });
  });

  // SEAM (BE4/C4 — individual flyer send): there is currently NO individual-send
  // route in the codebase (only the share-broadcast fan-out sends a listing). The
  // data model already supports `via:'individual'`; when an individual-send
  // endpoint lands, it should call
  //   listingSends.recordSend({ contactId, unitId, via: 'individual' })
  // (best-effort, alongside the send) so a one-off flyer send shows up in both
  // the "Sent to tenants" and "Listings sent" lists, exactly like a broadcast.
  // Individual-send CAPTURE is therefore a seam pending that endpoint.

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
    res.json({ recipients: rows.map(toListingSendRow) });
  });

  // PATCH /api/units/:unitId/recipients/:contactId { response } (BE4/C4).
  // Set the tenant's response on an existing send row → { recipient }. 400 on an
  // invalid response; 404 when the send row doesn't exist. On a CHANGE to
  // 'interested' / 'not_a_fit', emit a `listing_reviewed` milestone (best-effort)
  // + audit the change (listing_response_set).
  router.patch('/:unitId/recipients/:contactId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const contactId = String(req.params['contactId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const response = (body as Record<string, unknown>)['response'];
    if (!isListingResponse(response)) {
      res.status(400).json({ error: `response must be one of: ${LISTING_RESPONSES.join(', ')}` });
      return;
    }

    // Atomically set the response. `changed` reports a REAL value transition
    // (the conditional only writes when the value actually changes), so two
    // concurrent identical PATCHes collapse to one change — never a duplicate
    // milestone. A missing row throws ListingSendNotFoundError → 404.
    let result;
    try {
      result = await listingSends.setResponse(unitId, contactId, response);
    } catch (err) {
      if (err instanceof ListingSendNotFoundError) {
        res.status(404).json({ error: 'listing_send_not_found' });
        return;
      }
      throw err;
    }
    const { row: updated, changed } = result;

    // Emit listing_reviewed ONLY on a real change to a reviewed response.
    if (changed && (response === 'interested' || response === 'not_a_fit')) {
      const label = response === 'interested' ? 'Listing reviewed · Interested' : 'Listing reviewed · Not a fit';
      try {
        await activityEvents.record({
          contactId,
          type: 'listing_reviewed',
          label,
          refType: 'unit',
          refId: unitId,
        });
      } catch (err) {
        log.error({ err, unitId, contactId }, 'unit recipients: recording listing_reviewed milestone failed (best-effort)');
      }
    }

    // Audit only a REAL change (a no-op set writes nothing, so it warrants no
    // audit row either — matches the milestone gate above).
    if (changed) {
      await audit.append(`units#${unitId}`, 'listing_response_set', {
        actor: req.user?.userId,
        contactId,
        response,
      });
    }
    log.info({ unitId, contactId, response, changed, actor: req.user?.userId }, 'listing response set via api');
    res.json({ recipient: toListingSendRow(updated) });
  });

  // PATCH /api/units/:unitId — partial update (SET-merge, no-overwrite).
  router.patch('/:unitId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const validation = validateUnitBody(req.body, 'update');
    if (!validation.ok) {
      res.status(400).json({ error: validation.error });
      return;
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

  return router;
}
