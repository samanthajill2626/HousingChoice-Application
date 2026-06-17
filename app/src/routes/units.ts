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
import { rankSimilarUnits } from '../lib/similarUnits.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  CannotRemovePrimaryLandlordError,
  createUnitsRepo,
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
  /** BE3/C3: resolve a roster contact's display name/company for denormalization. */
  contactsRepo?: ContactsRepo;
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
  const first = typeof contact.firstName === 'string' ? contact.firstName : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName : '';
  const joined = `${first} ${last}`.trim();
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
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
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
    res.json({ unit: { ...unit, contacts: unitContacts(unit) } });
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
    res.json({ unit: { ...updated, contacts: unitContacts(updated) } });
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
    res.json({ unit: { ...updated, contacts: unitContacts(updated) } });
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
    const available = await units.listByStatus('available');
    const similar = rankSimilarUnits(unit, available.items);
    log.info({ unitId, candidateCount: available.items.length, returned: similar.length }, 'similar units served');
    res.json({ similar });
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
