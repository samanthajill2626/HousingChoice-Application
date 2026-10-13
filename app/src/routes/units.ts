// Units CRUD router (M1.5) — mounted under /api/units, behind requireAuth via
// the /api mount (app.ts). VAs maintain properties day-to-day, so NO admin gate
// (same posture as contacts triage).
//
//   GET   /api/units?status=&landlordId=&limit=&cursor=
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
  CannotRemoveLandlordOfRecordError,
  ContactListCaseworkerError,
  createUnitsRepo,
  isDeleted,
  LandlordClaimNotLandlordError,
  LandlordReassignmentRequiredError,
  RosterWriteConflictError,
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
import {
  createContactsRepo,
  isDeleted as isContactDeleted,
  type ContactItem,
  type ContactsRepo,
  type RecipientDisplay,
} from '../repos/contactsRepo.js';
import {
  createListingSendsRepo,
  toListingSendRow,
  type ListingSendItem,
  type ListingSendRecipientFacts,
  type ListingSendRow,
  type ListingSendsRepo,
} from '../repos/listingSendsRepo.js';
import { createPlacementsRepo, type PlacementItem, type PlacementsRepo } from '../repos/placementsRepo.js';
import { createToursRepo, type TourItem, type ToursRepo, type TourType } from '../repos/toursRepo.js';
import { deriveTourActivityAt, deriveTourSignal } from '../lib/listingSendTour.js';
import { createBroadcastsRepo, type BroadcastItem, type BroadcastsRepo } from '../repos/broadcastsRepo.js';
import { reachedCount } from '../services/shareRecipientState.js';
import { createOrgNamesService, type OrgNamesService } from '../services/orgNames.js';
import { requireLandlordContact, requireTenantContact, sendContactTypeError } from '../services/contactTypeGuards.js';
import { isCaseworker } from '../lib/caseworkers.js';
import {
  deriveListingSendOutcome,
  effectiveDecline,
  interestedModeFor,
  isEligibleRecipient,
  wireDecline,
  type DeclineRecord,
} from '../lib/listingSendOutcome.js';
import { recordListingOutcomeEvent } from '../lib/listingOutcomeEvents.js';
import { formatAddress } from '../lib/address.js';
import { ledgerRowCounted } from '../services/shareLedger.js';
import { createActivityEventsRepo, type ActivityEventsRepo } from '../repos/activityEventsRepo.js';

export interface UnitsRouterDeps {
  logger?: Logger;
  unitsRepo?: UnitsRepo;
  auditRepo?: AuditRepo;
  /** last-heard-from spec 5.4 / 14.3: the outcome route pins the contact
   *  timeline (lib/listingOutcomeEvents.ts). auditRepo, contactsRepo and
   *  toursRepo already exist and serve the same route. */
  activityEventsRepo?: ActivityEventsRepo;
  /** BE3/C3: resolve a roster contact's display name/company for denormalization. */
  contactsRepo?: ContactsRepo;
  /** BE4/C4: the listing-send record (the "Sent to" recipients read). */
  listingSendsRepo?: ListingSendsRepo;
  /** FIX 3: GET /:id/placements lists the unit's placements (tenant-name enriched). */
  placementsRepo?: PlacementsRepo;
  /**
   * share-sent-outcome D5: GET /:id/activity recounts a `broadcast_sent` row's
   * tenant count from its share at read time (one projected batch read).
   */
  broadcastsRepo?: BroadcastsRepo;
  /** listing-response-tour-chip + last-heard-from D12: GET /:id/recipients and
   *  the outcome route read the unit's tours (byUnit GSI) - a REQUIRED join: a
   *  query failure is a 503 outcome_unavailable, never a guessed outcome. */
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
  /**
   * Organization names (spec 2026-10-06 D5): POST and PATCH check
   * accepted_authorities members against the stored org list. Built ONCE in
   * createApiRouter and threaded down.
   */
  orgNamesService?: OrgNamesService;
}

/** BE3/C3: a valid roster role (C3 `UnitContact.role`). */
function isUnitContactRole(value: unknown): value is UnitContact['role'] {
  return typeof value === 'string' && (UNIT_CONTACT_ROLES as readonly string[]).includes(value);
}

/**
 * The ONE eligibility rule for an AUTOMATIC routing choice (caseworker-
 * integrity spec revision 6 section 4 "Contact list (I4)" and "Restore"; final
 * review A4, fix wave FWF-3): auto-primary on a contact-list add (passed to
 * unitsRepo.addContact as `autoPrimaryEligible`) and the restore's
 * sole-landlord promotion (soleLandlordToPromote). The contact exists, is
 * typed `landlord`, is NOT soft-deleted (the contacts repo's own test -
 * deleting a contact keeps its seats, and a deleted contact is unusable for
 * routing everywhere else) and is NOT a phone or email routing pointer (a
 * routing record, never a contact). A deliberate choice - the I3 claim of a
 * vacant landlord slot, a landlord picked for a restore - asks only the type.
 */
function autoRoutingEligible(contact: ContactItem | undefined): boolean {
  return (
    contact !== undefined &&
    contact.phone_ref !== true &&
    contact.email_ref !== true &&
    !isContactDeleted(contact) &&
    contact.type === 'landlord'
  );
}

/**
 * BE3/C3: the denormalized display name for a roster row, from the contact's
 * firstName/lastName (joined + trimmed). HONEST — undefined when no name is
 * known (never invents one); the roster row then has no `name`.
 */
// Takes the MINIMAL shape both contact reads satisfy - a whole ContactItem
// (getById / getManyByIds) and the ContactDisplayItem projection
// (getDisplayById / getDisplaysByIds). `contactId` is here only as the anchor
// that keeps TypeScript's weak-type check honest; the name comes from the two
// optional fields.
function displayNameOfContact(contact: {
  contactId: string;
  firstName?: unknown;
  lastName?: unknown;
}): string | undefined {
  // Part-wise trim BEFORE the join (legacy padded parts must not render an
  // interior gap; new writes arrive trimmed via trimJsonBody).
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/**
 * caseworkers D20 (plan 3.7, ruling R3-F3): a recipients row's contact type and
 * role, from the recipient display projection. `role` only when it holds text;
 * a contact that did not resolve never reaches here (its row omits both).
 */
function recipientFactsOf(contact: RecipientDisplay): ListingSendRecipientFacts {
  const role = typeof contact.role === 'string' ? contact.role.trim() : '';
  return {
    ...(contact.type !== undefined && { type: contact.type }),
    ...(role.length > 0 && { role }),
  };
}

/** The joins every outcome-serving units read needs (last-heard-from D12):
 *  the unit's tours grouped by tenant, and the recipients' display projection
 *  read with requireComplete. Both REQUIRED. */
interface RecipientJoin {
  toursByTenant: Map<string, TourItem[]>;
  displays: Map<string, RecipientDisplay>;
}

/** Group a unit's tours strictly by the pairing's tenant. */
function groupToursByTenant(unitTours: TourItem[]): Map<string, TourItem[]> {
  const byTenant = new Map<string, TourItem[]>();
  for (const t of unitTours) {
    const arr = byTenant.get(t.tenantId);
    if (arr === undefined) byTenant.set(t.tenantId, [t]);
    else arr.push(t);
  }
  return byTenant;
}

/**
 * One "Sent to" row with its derived outcome (spec 5.4 / 5.5). A recipient
 * whose contact row is GONE is not an incomplete read (requireComplete only
 * throws on unread keys): it serves with the id as its name,
 * recipientMissing, no type (so no tour signal and no reply can be known),
 * interestedSupported false and eligible false. A non-tenant row reads no
 * tours and carries no `tour` (B11).
 */
function projectRecipientRow(row: ListingSendItem, unit: UnitItem, join: RecipientJoin): ListingSendRow {
  const interestedMode = interestedModeFor(unit);
  const contact = join.displays.get(row.contactId);
  if (contact === undefined) {
    const outcome = deriveListingSendOutcome({
      row,
      recipientType: undefined,
      lastHeardFromAt: undefined,
      tour: undefined,
      tourActivityAt: undefined,
    });
    const declined = wireDecline(row, outcome);
    return toListingSendRow(row, {
      outcome,
      ...(declined !== undefined && { declined }),
      interestedSupported: false,
      interestedMode,
      eligible: false,
      recipientMissing: true,
    });
  }
  const isTenant = contact.type === 'tenant';
  const pairTours = isTenant ? (join.toursByTenant.get(row.contactId) ?? []) : [];
  const tour = deriveTourSignal(pairTours);
  const outcome = deriveListingSendOutcome({
    row,
    recipientType: contact.type,
    lastHeardFromAt: contact.last_heard_from_at,
    tour,
    tourActivityAt: deriveTourActivityAt(pairTours),
  });
  const declined = wireDecline(row, outcome);
  const tenantName = displayNameOfContact(contact);
  return toListingSendRow(row, {
    ...(tour !== undefined && { tour }),
    ...(tenantName !== undefined && { tenantName }),
    facts: recipientFactsOf(contact),
    outcome,
    ...(contact.last_heard_from_at !== undefined && { lastHeardFromAt: contact.last_heard_from_at }),
    ...(declined !== undefined && { declined }),
    interestedSupported: isTenant,
    interestedMode,
    eligible: isEligibleRecipient(contact),
  });
}

/** The outcome route's body: exactly { outcome } with one of the three values. */
function parseOutcomeBody(body: unknown): 'interested' | 'not_interested' | 'clear' | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'outcome') return undefined;
  const value = (body as Record<string, unknown>)['outcome'];
  return value === 'interested' || value === 'not_interested' || value === 'clear' ? value : undefined;
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
 * tour_no_show, tour_canceled, tour_outcome, tour_auto_closed,
 * tour_reopened, listing_declined, listing_decline_cleared,
 * listing_interested).
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
 * top-N panel, so 500 is a generous bound on a single market's open
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
  const activityEvents = deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: deps.logger });
  const placements = deps.placementsRepo ?? createPlacementsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const broadcasts = deps.broadcastsRepo ?? createBroadcastsRepo({ logger: deps.logger });
  const mediaStore = deps.mediaStore;
  const transcodeGate = deps.transcodeGate ?? sharedTranscodeGate;
  const orgNames = deps.orgNamesService ?? createOrgNamesService({ logger: deps.logger });

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
    // ONE BatchGet for the whole roster (was one getById per row). WHOLE items,
    // not the display projection: the rows below also read `company`.
    let byId = new Map<string, ContactItem>();
    try {
      byId = await contacts.getManyByIds(roster.map((row) => row.contactId));
    } catch (err) {
      // Never 500 the roster on a contact-lookup failure. The blast radius is
      // now the whole batch rather than one row - every row simply serves
      // un-enriched, which is the same degradation the per-row catch gave.
      log.warn({ unitId: unit.unitId, err }, 'roster enrich: contact lookup failed (best-effort)');
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

  /**
   * caseworker-integrity spec revision 5, section 4 "Restore" (Cameron's Q5;
   * fix wave 2 FW2-12): the sole-landlord promotion of a "Restore without a
   * landlord". When the cleared landlord was the property's primary contact -
   * its contact-list row flagged, or the primary_contact scalar naming it
   * (unitsRepo.restoreWithLandlord's rule) - the ONE remaining row whose
   * contact is eligible for automatic routing (any roster role; read
   * CONSISTENTLY; `autoRoutingEligible`, the rule auto-primary shares since
   * spec revision 6 / fix wave FWF-3: typed `landlord`, and a missing, a
   * routing-pointer or a SOFT-DELETED contact - R3 code review finding A1,
   * fix wave 3 FW3-1 - is not eligible) is the one to promote; zero or
   * two-plus such rows promote nobody (null).
   * Decided from `listRead` - the contact list of `unit` (the route's
   * consistent read) taken ONCE, before these type reads are awaited - which
   * is the very value the restore's write is then conditioned on
   * (`expectContacts`; R3 code review finding A3, fix wave 3 FW3-2).
   */
  async function soleLandlordToPromote(
    unit: UnitItem,
    listRead: UnitItem['contacts'],
    clearedLandlordId: string | undefined,
  ): Promise<string | null> {
    if (clearedLandlordId === undefined) return null;
    // unitContacts' own reading of that one list (the landlordId-derived row
    // when no list is stored).
    const rows = unitContacts({ contacts: listRead, landlordId: clearedLandlordId });
    const clearedRow = rows.find((row) => row.contactId === clearedLandlordId);
    const clearedWasPrimary =
      clearedRow?.primaryContact === true || unit.primary_contact === clearedLandlordId;
    if (!clearedWasPrimary) return null;
    const remaining = rows.filter((row) => row.contactId !== clearedLandlordId);
    const read = await Promise.all(
      remaining.map((row) => contacts.getById(row.contactId, { consistentRead: true })),
    );
    const eligible = remaining.filter((_row, i) => autoRoutingEligible(read[i]));
    const [only] = eligible;
    return eligible.length === 1 && only !== undefined ? only.contactId : null;
  }

  // GET /api/units — filtered list. Exactly one filter is honored, in priority
  // order landlordId > status (each a single-partition Query); with no filter, a
  // paginated Scan (repo.list). This keeps every list read a bounded operation.
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

    let page: UnitsPage;
    if (typeof landlordId === 'string' && landlordId.length > 0) {
      page = await units.listByLandlord(landlordId, opts);
    } else if (typeof status === 'string' && status.length > 0) {
      page = await units.listByStatus(status, opts);
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
    // ORGANIZATION NAMES (spec 2026-10-06 D5): a new unit holds nothing yet,
    // so EVERY accepted_authorities member must resolve to a housing
    // authority on the stored list - a tombstoned `jurisdiction` in the same
    // body grants no pass (the validator drops it). Members are trimmed and
    // de-duplicated, and a unique spelling is stored as its entry's exact
    // name. The validator's 400s ran first; a 422 creates nothing.
    if (Array.isArray(validation.fields['accepted_authorities'])) {
      const check = await orgNames.checkList(
        'accepted_authorities',
        validation.fields['accepted_authorities'] as string[],
        undefined,
        undefined,
      );
      if (!check.ok) {
        log.info({ actor: req.user?.userId }, 'unit create refused: accepted authority not on the list');
        res.status(422).json(check.error);
        return;
      }
      validation.fields['accepted_authorities'] = check.value;
    }
    // caseworker-integrity I3 (spec 2026-10-12 section 4): the owning
    // landlordId must name a contact typed `landlord` (a property manager is a
    // landlord with a role) - 404 landlord_not_found when no such contact
    // exists, 409 landlord_not_landlord otherwise. A consistent read. It runs
    // after the validator's 400s and the org-list 422, and nothing is created
    // on a refusal. landlordId is guaranteed by validation.
    try {
      await requireLandlordContact(contacts, validation.fields['landlordId'] as string);
    } catch (err) {
      if (sendContactTypeError(err, res)) {
        log.info({ actor: req.user?.userId }, 'unit create refused: landlordId is not a landlord');
        return;
      }
      throw err;
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

  // GET /api/units/:unitId/recipients - the property's "Sent to" list (BE4/C4).
  // Returns { recipients: ListingSendRow[] } from listByUnit, each row with its
  // derived send outcome (last-heard-from spec 5.4). Mirrors the units 404
  // posture: an unknown unit is a 404; a real unit with zero recipients
  // returns []. D12: the tours join and the contacts join (read with
  // requireComplete) are REQUIRED - an outcome drives buttons and a to-do
  // list, so a failed join is a 503 outcome_unavailable, never a guessed row.
  // (`recipients` is a distinct segment from the bare :unitId routes, so
  // there is no route collision.)
  router.get('/:unitId/recipients', async (req, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const rows = await listingSends.listByUnit(unitId);
    let join: RecipientJoin;
    try {
      // ONE byUnit GSI query and ONE BatchGet of the recipient projection for
      // the whole page (the batch de-dupes ids). caseworkers D20 (ruling
      // R3-F4): the recipients-only projection carries type and role, so the
      // dashboard can label a non-tenant row.
      const [unitTours, displays] = await Promise.all([
        tours.listByUnit(unitId),
        contacts.getRecipientDisplaysByIds(rows.map((row) => row.contactId), { requireComplete: true }),
      ]);
      join = { toursByTenant: groupToursByTenant(unitTours), displays };
    } catch (err) {
      log.warn({ err, unitId }, 'recipients outcome join failed - 503 outcome_unavailable');
      res.status(503).json({ error: 'outcome_unavailable' });
      return;
    }
    res.json({ recipients: rows.map((row) => projectRecipientRow(row, unit, join)) });
  });

  // POST /api/units/:unitId/recipients/:contactId/outcome - the ONE way a
  // send outcome changes (last-heard-from spec 5.4 as amended by 14.3 and
  // 14.7). Body { outcome: 'interested' | 'not_interested' | 'clear' }.
  // Answers, in this order: 404 unit_not_found; 409 unit_deleted (every
  // outcome, B10); 404 send_not_found (no COUNTED row - ledgerRowCounted,
  // B5); 400 invalid_outcome; 503 outcome_unavailable when a required read
  // fails BEFORE any write; interested only: 400 interested_unsupported (not
  // a tenant on the recipient projection), 404 tenant_not_found / 409
  // contact_not_tenant (requireTenantContact - the same CONSISTENT I2 guard
  // POST /api/tours runs), 409 tour_type_required (no qualifying tour and no
  // structured tour_type - the dashboard opens the form instead, D14);
  // not_interested / clear only: 404 send_not_found when the conditional
  // write finds no counted row; then 200 { row } re-projected.
  // INTERESTED (spec 14.7 - steps 3 and 4 of 5.4 reversed): it CREATES the
  // tour (only when no qualifying tour exists) and records
  // listing_interested FIRST, so a failed create leaves the decline and the
  // timeline untouched. THEN it clears the decline record it READ, whatever
  // its effectiveness (an explicit Interested overrides every earlier
  // decline, and a retry repairs a clear that failed behind a create), as a
  // COMPARE-AND-CLEAR on that record's `at` (review B R2-1): a decline
  // another staff member records meanwhile survives, and a lost compare (or
  // a row that stopped counting) records nothing and is never a 404 - the
  // re-projection answers the truth. listing_decline_cleared is recorded
  // only when the cleared decline was EFFECTIVE (review B R2-2). CLEAR (Undo)
  // removes any stored decline and records listing_decline_cleared only when
  // there was one.
  // SAVED (review A-3, B R2-2, B R2-3; spec 14.7): a failure AFTER a write -
  // the re-read, or a throw such as the clear behind a create (logged at
  // error, ids only) - answers 503 { error: 'outcome_unavailable', saved:
  // true }, never a bare 500. The writes are setDeclined, a tour create and
  // a clear that removed a record; a click that wrote none of them (an
  // Interested that found a tour and no stored decline, an Undo with nothing
  // to undo) gets the plain 503, and a throw before any write is the generic
  // 500. Audit events are best-effort (lib/listingOutcomeEvents.ts). A
  // concurrent double click can still race two creates (no conditional write
  // on the pair - I3; the dashboard disables the button in flight). PII: ids
  // only in logs.
  router.post('/:unitId/recipients/:contactId/outcome', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const contactId = String(req.params['contactId'] ?? '');
    const unit = await units.getById(unitId);
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    if (isDeleted(unit)) {
      res.status(409).json({ error: 'unit_deleted' });
      return;
    }
    const row = await listingSends.getByKeyConsistent(unitId, contactId);
    if (row === undefined || !ledgerRowCounted(row)) {
      res.status(404).json({ error: 'send_not_found' });
      return;
    }
    const outcome = parseOutcomeBody(req.body);
    if (outcome === undefined) {
      res.status(400).json({ error: 'invalid_outcome' });
      return;
    }

    // The recipient projection (requireComplete): the type for the
    // interested check AND the name / type / reachability for the
    // re-projection. A failure here has written nothing.
    let recipient: RecipientDisplay | undefined;
    try {
      recipient = (await contacts.getRecipientDisplaysByIds([contactId], { requireComplete: true })).get(contactId);
    } catch (err) {
      log.warn({ err, unitId, contactId }, 'outcome: recipient read failed - nothing written');
      res.status(503).json({ error: 'outcome_unavailable' });
      return;
    }

    const actor = req.user?.userId;
    const at = new Date().toISOString();
    const address = formatAddress(unit.address) || unitId;
    const eventDeps = { activityEvents, audit, logger: log };
    let createdTour: TourItem | undefined;
    // Review A-3 / B R2-3: `saved: true` on a late 503 only when THIS click
    // wrote (setDeclined / a tour create / a clear that removed a record). An
    // Interested click that found a tour and no stored decline, or an Undo
    // with nothing to undo, writes nothing.
    let wrote = false;

    // Review B R2-2 part 2 / A R2-2 (spec 14.7): everything from here on runs
    // under one guard. A throw BEFORE any write stays the generic 500 (nothing
    // was saved, so a retry is right); a throw AFTER one (the Interested clear
    // behind a create, the re-projection) is never a bare 500 - the click DID
    // save, so it answers 503 saved:true and invites no retry.
    try {
      if (outcome === 'interested') {
        if (recipient?.type !== 'tenant') {
          res.status(400).json({ error: 'interested_unsupported' });
          return;
        }
        try {
          await requireTenantContact(contacts, contactId);
        } catch (err) {
          if (sendContactTypeError(err, res)) return;
          throw err;
        }
        let pairTours: TourItem[];
        try {
          // Accepted (build adjudication F6): the unit's tours filtered to the
          // tenant read the same pair set as spec 5.4's byTenant read.
          pairTours = (await tours.listByUnit(unitId)).filter((t) => t.tenantId === contactId);
        } catch (err) {
          log.warn({ err, unitId, contactId }, 'outcome: tours read failed - nothing written');
          res.status(503).json({ error: 'outcome_unavailable' });
          return;
        }
        // (1) ANY qualifying tour (the chip's set) means no tour is created.
        const existing = deriveTourSignal(pairTours) !== undefined;
        // (2) interestedModeFor's rule: no structured tour_type -> the form
        // path. The tour type is the unit's own field ONLY (D14) - never derived.
        const tourType: TourType | undefined = unit.tour_type;
        if (!existing && tourType === undefined) {
          res.status(409).json({ error: 'tour_type_required' });
          return;
        }
        // Whether a decline is EFFECTIVE is judged on the tours as read, before
        // this click creates one (the new tour would supersede it).
        const declineEffective = effectiveDecline(row, deriveTourActivityAt(pairTours));
        // (4, run FIRST - review ADV-3) Create, and ONLY then record
        // listing_interested (a click that found an existing tour writes no
        // event; a retry is not re-recorded). A create failure throws here,
        // before the decline or the timeline is touched.
        if (!existing && tourType !== undefined) {
          createdTour = await tours.create({ tenantId: contactId, unitId, tourType, status: 'requested' });
          wrote = true;
          await recordListingOutcomeEvent(eventDeps, {
            type: 'listing_interested',
            contactId,
            unitId,
            label: `Interested in ${address} - tour requested`,
            ...(actor !== undefined && { actor }),
            tourId: createdTour.tourId,
            at,
          });
        }
        // (3, run SECOND) The decline record this click READ is removed
        // WHATEVER its effectiveness (review B R2-2: an explicit Interested
        // overrides every earlier decline, and a retry repairs a clear that
        // failed behind an earlier create); `listing_decline_cleared` is its
        // history only when that decline was EFFECTIVE (a superseded record
        // changed nothing visible). COMPARE-AND-CLEAR (review B R2-1): only the
        // record whose `at` was read is removed, so a decline another staff
        // member records meanwhile survives. A clear that answers 'not_found'
        // (someone re-declined, or the row stopped counting) records nothing
        // and is NEVER a 404 here - the row was counted when read - so it falls
        // through to the re-projection, which answers the truth.
        const readDecline = row.declined;
        if (readDecline !== undefined) {
          const cleared = await listingSends.clearDeclined(unitId, contactId, { expectedAt: readDecline.at });
          if (cleared === 'ok') wrote = true;
          if (cleared === 'ok' && declineEffective) {
            await recordListingOutcomeEvent(eventDeps, {
              type: 'listing_decline_cleared',
              contactId,
              unitId,
              label: `Not interested cleared for ${address}`,
              ...(actor !== undefined && { actor }),
              at,
            });
          }
        }
      } else if (outcome === 'not_interested') {
        const record: DeclineRecord = { at, by: 'staff', ...(actor !== undefined && { staffId: actor }) };
        if ((await listingSends.setDeclined(unitId, contactId, record)) === 'not_found') {
          res.status(404).json({ error: 'send_not_found' });
          return;
        }
        wrote = true;
        await recordListingOutcomeEvent(eventDeps, {
          type: 'listing_declined',
          contactId,
          unitId,
          label: `Not interested in ${address}`,
          ...(actor !== undefined && { actor }),
          at,
        });
      } else {
        const hadDecline = row.declined !== undefined;
        if ((await listingSends.clearDeclined(unitId, contactId)) === 'not_found') {
          res.status(404).json({ error: 'send_not_found' });
          return;
        }
        // Review B R2-3: an Undo with nothing to undo changed nothing a
        // person can see, so it is not a write for `saved` either.
        wrote = hadDecline;
        // A clear that found no decline records nothing (plan 3.4 #2).
        if (hadDecline) {
          await recordListingOutcomeEvent(eventDeps, {
            type: 'listing_decline_cleared',
            contactId,
            unitId,
            label: `Not interested cleared for ${address}`,
            ...(actor !== undefined && { actor }),
            at,
          });
        }
      }

      // (5) Re-project (D12: the joins are required). The row is re-read
      // CONSISTENTLY; the byUnit GSI may not yet show a tour created a moment
      // ago, so the created item joins the read. A failure here carries
      // `saved: true` only when this click wrote (review A-3).
      const unavailable = wrote ? { error: 'outcome_unavailable', saved: true } : { error: 'outcome_unavailable' };
      let after: ListingSendItem | undefined;
      let unitTours: TourItem[];
      try {
        [after, unitTours] = await Promise.all([
          listingSends.getByKeyConsistent(unitId, contactId),
          tours.listByUnit(unitId),
        ]);
      } catch (err) {
        log.warn({ err, unitId, contactId, wrote }, 'outcome: re-projection read failed - 503');
        res.status(503).json(unavailable);
        return;
      }
      if (after === undefined || !ledgerRowCounted(after)) {
        res.status(503).json(unavailable);
        return;
      }
      const created = createdTour;
      const joinedTours = created === undefined ? unitTours : [...unitTours.filter((t) => t.tourId !== created.tourId), created];
      const join: RecipientJoin = {
        toursByTenant: groupToursByTenant(joinedTours),
        displays: recipient !== undefined ? new Map([[contactId, recipient]]) : new Map(),
      };
      log.info({ unitId, contactId, outcome, tourCreated: created !== undefined }, 'listing send outcome recorded');
      res.json({ row: projectRecipientRow(after, unit, join) });
    } catch (err) {
      if (!wrote) throw err;
      log.error({ err, unitId, contactId, outcome, tourCreated: createdTour !== undefined }, 'outcome: failed after a write - 503 saved');
      if (!res.headersSent) res.status(503).json({ error: 'outcome_unavailable', saved: true });
    }
  });

  // POST /api/units/:unitId/contacts { contactId, role, primaryContact? } (BE3/C3).
  // Add (or update) a roster contact → { unit } (with contacts). The ROUTE
  // resolves the contact's denormalized name/company (so the roster row is
  // self-describing); the repo maintains the single-primaryContact invariant and
  // keeps the primary_contact scalar consistent with the row marked primary
  // (nothing routes on the scalar: the roster resolvers take the row marked
  // primary, else the landlord of record - see unitsRepo.addContact).
  // Auto-primary (caseworker-integrity spec revisions 5 and 6, section 4
  // "Contact list"): a NEW seat for a contact typed landlord and not
  // soft-deleted (autoRoutingEligible) on a property with no row marked
  // primary and no landlord of record becomes its primary contact even when
  // the request's primaryContact is false or absent. A Landlord role
  // claims an ownerless legacy property. 409 contact_list_caseworker (a
  // caseworker taking a NEW seat) and 409 landlord_not_landlord (a claim of the
  // vacant landlord slot by a contact not typed landlord), each from the
  // route's checks below or from the roster write itself; 409
  // landlord_reassignment_required when a different owner already exists, or
  // unit_roster_conflict after repeated write races. 404 unit_not_found
  // (unknown/disappeared unit) or contact_not_found (a missing contact, or the
  // id of a phone or email routing pointer); 400 bad role / primaryContact;
  // audit unit_contact_added after successful writes only.
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
    const primaryContactRaw = b['primaryContact'];
    if (primaryContactRaw !== undefined && typeof primaryContactRaw !== 'boolean') {
      res.status(400).json({ error: 'primaryContact must be a boolean' });
      return;
    }
    const primaryContact = primaryContactRaw === true;

    // The unit must exist (404). We check up-front so an unknown unit is a clean
    // 404 distinct from the unknown-contact 404 below. caseworker-integrity
    // (spec 2026-10-12 section 4): the seat and claim checks below decide from
    // THIS read, so it is consistent.
    const unit = await units.getById(unitId, { consistentRead: true });
    if (!unit) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }

    // Resolve the contact for denormalization (404 when the contact doesn't
    // exist — never roster a phantom). name/company are best-effort honest:
    // omitted when unknown, never invented. A phone or email ROUTING POINTER
    // row (contactsRepo.ts `phone_ref` / `email_ref`: a routing record, never
    // a contact) does not exist as a contact here either - the codebase's own
    // pointer test, as in services/contactTypeGuards.ts (R2 code review finding
    // A3, fix wave 2 FW2-3).
    const contact = await contacts.getById(contactId, { consistentRead: true });
    if (!contact || contact.phone_ref === true || contact.email_ref === true) {
      res.status(404).json({ error: 'contact_not_found' });
      return;
    }
    // caseworker-integrity (spec 2026-10-12 section 4), in this order and both
    // before the repo call; the repo's own 409 landlord_reassignment_required
    // follows. Decided from the consistent reads above with the repo's own
    // definitions (unitsRepo.addContact): a SEAT is a row of unitContacts(unit)
    // (the landlord of record included); a CLAIM is a role-landlord add on a
    // unit with no landlordId attribute.
    //   I4: a caseworker never takes a NEW seat, whatever the role. A seat they
    //       already hold stays editable (L2).
    //   I3: claiming the vacant landlord slot needs a contact typed `landlord`.
    //       Re-asserting the existing owner is not a claim and is not checked.
    // These answer the common, no-race case. addContact decides both again on
    // each attempt's own read from the facts passed below (fix wave 2 FW2-1),
    // so a seat removed or a landlord cleared after THIS read answers the same
    // 409s instead of re-seating a caseworker or letting a non-landlord claim.
    // Auto-primary asks `autoPrimaryEligible`, the one automatic-routing rule
    // shared with the restore's promotion (autoRoutingEligible): only a
    // contact typed landlord that is not soft-deleted (and not a pointer,
    // already a 404 above) is made the primary contact of an ownerless,
    // primary-less property (spec revisions 5 and 6; FW2-11, FWF-3); the I3
    // claim keeps asking `landlordTyped`.
    const seated = unitContacts(unit).some((row) => row.contactId === contactId);
    if (!seated && isCaseworker(contact)) {
      log.info({ unitId, contactId, actor: req.user?.userId }, 'unit contact refused: a caseworker cannot take a new seat');
      res.status(409).json({ error: 'contact_list_caseworker' });
      return;
    }
    const claimsVacantLandlord =
      role === 'landlord' && !Object.prototype.hasOwnProperty.call(unit, 'landlordId');
    if (claimsVacantLandlord && contact.type !== 'landlord') {
      log.info({ unitId, contactId, actor: req.user?.userId }, 'unit contact refused: a landlord claim by a non-landlord');
      res.status(409).json({ error: 'landlord_not_landlord' });
      return;
    }
    const name = displayNameOfContact(contact);
    const company = typeof contact['company'] === 'string' ? (contact['company'] as string) : undefined;

    let updated: UnitItem;
    try {
      updated = await units.addContact(
        unitId,
        {
          contactId,
          role,
          primaryContact,
          ...(name !== undefined && { name }),
          ...(company !== undefined && { company }),
        },
        {
          caseworker: isCaseworker(contact),
          landlordTyped: contact.type === 'landlord',
          autoPrimaryEligible: autoRoutingEligible(contact),
        },
      );
    } catch (err) {
      if (err instanceof ContactListCaseworkerError) {
        log.info(
          { unitId, contactId, actor: req.user?.userId },
          'unit contact refused at the roster write: a caseworker cannot take a new seat',
        );
        res.status(409).json({ error: 'contact_list_caseworker' });
        return;
      }
      if (err instanceof LandlordClaimNotLandlordError) {
        log.info(
          { unitId, contactId, actor: req.user?.userId },
          'unit contact refused at the roster write: a landlord claim by a non-landlord',
        );
        res.status(409).json({ error: 'landlord_not_landlord' });
        return;
      }
      if (err instanceof LandlordReassignmentRequiredError) {
        res.status(409).json({ error: 'landlord_reassignment_required' });
        return;
      }
      if (err instanceof RosterWriteConflictError) {
        res.status(409).json({ error: 'unit_roster_conflict' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    // The EFFECTIVE primary flag, read from the written unit (R2 code review
    // finding A1, fix wave 2 FW2-2): auto-primary can make the contact primary
    // although the request said false (every dashboard add does), so the
    // durable record states what the write did, and `autoPrimary` says the
    // rule - not the request - did it.
    const effectivePrimary = (updated.contacts ?? []).some(
      (row) => row.contactId === contactId && row.primaryContact === true,
    );
    const autoPrimary = effectivePrimary && !primaryContact;
    await audit.append(`units#${unitId}`, 'unit_contact_added', {
      actor: req.user?.userId,
      contactId,
      role,
      primaryContact: effectivePrimary,
      ...(autoPrimary && { autoPrimary: true }),
    });
    log.info(
      {
        unitId,
        contactId,
        role,
        primaryContact: effectivePrimary,
        ...(autoPrimary && { autoPrimary: true }),
        actor: req.user?.userId,
      },
      'unit contact added via api',
    );
    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });
  });

  // DELETE /api/units/:unitId/contacts/:contactId (BE3/C3) → { unit }. 404
  // unknown unit / contact-not-on-roster; 409 removing the landlord of record
  // (cannot_remove_landlord_of_record — reassign landlordId first) or exhausted
  // optimistic retries (unit_roster_conflict); audit unit_contact_removed.
  router.delete('/:unitId/contacts/:contactId', async (req: AuthedRequest, res) => {
    const unitId = String(req.params['unitId'] ?? '');
    const contactId = String(req.params['contactId'] ?? '');
    let updated: UnitItem;
    try {
      updated = await units.removeContact(unitId, contactId);
    } catch (err) {
      if (err instanceof CannotRemoveLandlordOfRecordError) {
        res.status(409).json({ error: 'cannot_remove_landlord_of_record' });
        return;
      }
      if (err instanceof RosterWriteConflictError) {
        res.status(409).json({ error: 'unit_roster_conflict' });
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
    try {
      const displays = await contacts.getDisplaysByIds(items.map((c) => c.tenantId));
      for (const [tenantId, contact] of displays) {
        nameByTenant.set(tenantId, displayNameOfContact(contact) ?? null);
      }
    } catch (err) {
      log.warn({ unitId, err }, 'unit placements: tenant lookup failed (best-effort)');
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
  // 404 unknown unit (matches the sibling reads). A finished share of this
  // unit appears as ONE `broadcast_sent` row (finalize's audit), whose
  // tenantCount is recounted from the share at read time (share-sent-outcome
  // D5); the per-recipient view is the "Sent to" card (GET
  // /:unitId/recipients).
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

    // share-sent-outcome D5: a `broadcast_sent` row's tenantCount is the
    // share's REACHED recipients at read time (delivered + sent + sending, the
    // strict reading), never the every-slot count finalize wrote into the
    // append-only audit row. ONE projected batch read of the page's shares; a
    // share that no longer exists keeps its stored count, and a failed read
    // keeps EVERY stored count - best-effort, the route NEVER 500s on it.
    const shareIds = [
      ...new Set(
        events.flatMap((e) =>
          e.type === 'broadcast_sent' && e.broadcastId !== undefined ? [e.broadcastId] : [],
        ),
      ),
    ];
    if (shareIds.length > 0) {
      let shares = new Map<string, BroadcastItem>();
      try {
        shares = await broadcasts.getByIds(shareIds, { projection: 'stats' });
      } catch (err) {
        log.error(
          { err, unitId, count: shareIds.length },
          'unit activity: share recount read failed (best-effort) - stored counts kept',
        );
      }
      for (const e of events) {
        if (e.type !== 'broadcast_sent' || e.broadcastId === undefined) continue;
        const share = shares.get(e.broadcastId);
        if (share !== undefined) e.tenantCount = reachedCount(share);
      }
    }

    // Read-time contactName enrichment, deduped per contactId; a missing/failed
    // lookup leaves contactName absent (the client falls back to the id) and
    // NEVER 500s — same posture as /placements' tenantName.
    const nameByContact = new Map<string, string | undefined>();
    try {
      const wanted = events.flatMap((e) => (e.contactId === undefined ? [] : [e.contactId]));
      for (const [contactId, contact] of await contacts.getDisplaysByIds(wanted)) {
        nameByContact.set(contactId, displayNameOfContact(contact));
      }
    } catch (err) {
      log.warn({ unitId, err }, 'unit activity: contact lookup failed (best-effort)');
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
    // A TRUE no-op save (spec section 8). An ok-but-EMPTY validated field set is
    // reachable only through the retired `jurisdiction` / `accepted_programs`
    // tombstones - a truly empty body is still the 400 above - i.e. a stale cached
    // dashboard bundle saving nothing but dead keys. Calling units.update here
    // would stamp `updated_at` and append a bare "Property updated" activity row
    // for a change that did not happen, so return the unchanged unit instead. The
    // normal path gets its 404 from update's attribute_exists condition; this early
    // return has to re-establish it explicitly or an unknown unit would 200.
    if (Object.keys(validation.fields).length === 0) {
      const existing = await units.getById(unitId);
      if (existing === undefined) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      log.info({ unitId, actor: req.user?.userId }, 'unit patch was a no-op (retired fields only)');
      res.json({ unit: existing });
      return;
    }
    // ORGANIZATION NAMES (spec 2026-10-06 D5). A PATCH carrying
    // accepted_authorities is checked per member against the STORED unit (a
    // new pre-read; an unknown unit 404s before any 422). A member the unit
    // already holds (compared trimmed on both sides) passes unchanged, and so
    // does its legacy `jurisdiction` - but ONLY while the unit has no stored
    // accepted_authorities list, because only then did the edit form
    // synthesize its list from that value (lib/unitFields.ts authoritiesOf; a
    // stored list, even [], wins - ruling R1-F1). Every other member must
    // resolve to a housing authority on the list; members are trimmed and
    // de-duplicated, and a unique spelling is stored as the exact name. The
    // pre-read is CONSISTENT: a stale read could pass an off-list value
    // through as "already held" (the contacts PATCH precedent).
    if (Array.isArray(validation.fields['accepted_authorities'])) {
      const storedUnit = await units.getById(unitId, { consistentRead: true });
      if (storedUnit === undefined) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      const storedList: unknown = storedUnit.accepted_authorities;
      const held = Array.isArray(storedList)
        ? storedList.filter((a): a is string => typeof a === 'string').map((a) => a.trim())
        : undefined;
      const legacy =
        held === undefined && typeof storedUnit.jurisdiction === 'string'
          ? storedUnit.jurisdiction.trim()
          : '';
      const check = await orgNames.checkList(
        'accepted_authorities',
        validation.fields['accepted_authorities'] as string[],
        held,
        legacy.length > 0 ? legacy : undefined,
      );
      if (!check.ok) {
        log.info({ unitId, actor: req.user?.userId }, 'unit patch refused: accepted authority not on the list');
        res.status(422).json(check.error);
        return;
      }
      validation.fields['accepted_authorities'] = check.value;
    }
    // caseworker-integrity I3 (spec 2026-10-12 section 4): a CHANGED landlordId
    // must name a contact typed `landlord` (404 landlord_not_found / 409
    // landlord_not_landlord). "Changed" is decided on a CONSISTENT unit read; an
    // unchanged landlordId is not checked (re-saving the stored owner, L2). An
    // empty id names no contact, so it is a 404 without a contact read.
    const landlordPatch = validation.fields['landlordId'];
    if (typeof landlordPatch === 'string') {
      const current = await units.getById(unitId, { consistentRead: true });
      if (current === undefined) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      if (current.landlordId !== landlordPatch) {
        if (landlordPatch.length === 0) {
          res.status(404).json({ error: 'landlord_not_found' });
          return;
        }
        try {
          await requireLandlordContact(contacts, landlordPatch);
        } catch (err) {
          if (sendContactTypeError(err, res)) {
            log.info({ unitId, actor: req.user?.userId }, 'unit patch refused: landlordId is not a landlord');
            return;
          }
          throw err;
        }
      }
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
    // caseworker-integrity I3 (spec 2026-10-12 section 4 "Restore", Cameron
    // 2026-10-12): a property comes back live only with a landlord of record
    // typed `landlord`, or with none - and restore never dead-ends.
    //   - Plain restore (no `landlordId` key in the body): when the unit is
    //     ownerless or its landlordId names a contact typed `landlord`, restore
    //     exactly as before. Otherwise 409 restore_needs_landlord
    //     { landlordName? } and nothing is written.
    //   - { landlordId: <id> } restores AND makes that contact (404
    //     landlord_not_found / 409 landlord_not_landlord) the landlord of record;
    //     { landlordId: null } restores ownerless and, when the cleared landlord
    //     was the primary, promotes the one remaining contact typed landlord
    //     (spec revision 5, soleLandlordToPromote). Honored ONLY when the plain
    //     restore would refuse, in ONE conditional write
    //     (unitsRepo.restoreWithLandlord) on the landlordId read here - and, for
    //     { landlordId: null }, the contact list read here - so a concurrent
    //     change answers 409 unit_roster_conflict.
    //   - A body is sent only after a 409 restore_needs_landlord, so one that
    //     arrives when the plain restore WOULD apply (the unit is no longer
    //     soft-deleted, its stored landlord is typed landlord again, or it is
    //     ownerless) means the state changed under the dialog: 409
    //     restore_landlord_not_needed and NOTHING is written - no restore, no
    //     audit (spec revision 7; final review A2 and round 2 R2-1). Its own
    //     code, never unit_roster_conflict ("the contact list or landlord
    //     changed, retry"): a retry of this body can never succeed. The
    //     dashboard closes the dialog and re-reads the property; the plain
    //     restore is never re-run for the caller, which would override the
    //     choice it sent.
    //   - A unit that is NOT soft-deleted restores exactly as before with no
    //     check (plain restore only): nothing comes back to life, and restore
    //     must never become a way to reassign a live property's landlord.
    const raw: unknown = req.body;
    const body =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const choosesLandlord = Object.prototype.hasOwnProperty.call(body, 'landlordId');
    const choice = body['landlordId'];
    if (choosesLandlord && choice !== null && (typeof choice !== 'string' || choice.length === 0)) {
      res.status(400).json({ error: 'landlordId must be a contact id or null' });
      return;
    }

    const stored = await units.getById(unitId, { consistentRead: true });
    if (stored === undefined) {
      res.status(404).json({ error: 'unit_not_found' });
      return;
    }
    const storedLandlordId =
      typeof stored.landlordId === 'string' && stored.landlordId.length > 0 ? stored.landlordId : undefined;
    let needsLandlord = false;
    let landlordName: string | undefined;
    if (isDeleted(stored) && storedLandlordId !== undefined) {
      const current = await contacts.getById(storedLandlordId, { consistentRead: true });
      if (current === undefined || current.type !== 'landlord') {
        needsLandlord = true;
        landlordName = current === undefined ? undefined : displayNameOfContact(current);
      }
    }

    if (!needsLandlord) {
      // The late body (spec revision 7; final review A2, round 2 R2-1): the
      // plain restore applies, so a landlord choice cannot be what the caller
      // saw - refuse before anything is written, with the code that says no
      // landlord is needed now, so the dialog closes and the page re-reads.
      if (choosesLandlord) {
        log.info(
          { unitId, actor: req.user?.userId },
          'unit restore refused: a landlord choice arrived when the plain restore applies',
        );
        res.status(409).json({ error: 'restore_landlord_not_needed' });
        return;
      }
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
      return;
    }

    if (!choosesLandlord) {
      log.info({ unitId, actor: req.user?.userId }, 'unit restore refused: the landlord of record is not a landlord');
      res.status(409).json({
        error: 'restore_needs_landlord',
        ...(landlordName !== undefined && { landlordName }),
      });
      return;
    }

    let next: { contactId: string; name?: string; company?: string } | null = null;
    if (typeof choice === 'string') {
      let landlord: ContactItem;
      try {
        landlord = await requireLandlordContact(contacts, choice);
      } catch (err) {
        if (sendContactTypeError(err, res)) return;
        throw err;
      }
      const name = displayNameOfContact(landlord);
      const company = typeof landlord['company'] === 'string' ? (landlord['company'] as string) : undefined;
      next = {
        contactId: choice,
        ...(name !== undefined && { name }),
        ...(company !== undefined && { company }),
      };
    }

    // Restore WITHOUT a landlord: the sole-landlord promotion (spec revision
    // 5) is decided here from the consistent reads, and the repo applies it
    // only on the very contact list it was decided from (`expectContacts`) - a
    // contact-list change in between answers 409 unit_roster_conflict. The
    // list is read ONCE, here, before the contact-type reads are awaited, and
    // that one value is both the decision's input and `expectContacts` (R3
    // code review finding A3, fix wave 3 FW3-2): `stored.contacts` read again
    // after the awaits need not be the list the decision saw (a FakeWorld
    // unit read is the live object a concurrent write replaces it on).
    const listRead = stored.contacts;
    const promote = next === null ? await soleLandlordToPromote(stored, listRead, storedLandlordId) : null;
    let restored: UnitItem;
    try {
      restored =
        next !== null
          ? await units.restoreWithLandlord(unitId, { expectLandlordId: storedLandlordId, next })
          : await units.restoreWithLandlord(unitId, {
              expectLandlordId: storedLandlordId,
              next: null,
              expectContacts: listRead,
              promote,
            });
    } catch (err) {
      if (err instanceof RosterWriteConflictError) {
        res.status(409).json({ error: 'unit_roster_conflict' });
        return;
      }
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'unit_not_found' });
        return;
      }
      throw err;
    }
    // The promotion as written: the promoted row is primary in the written unit.
    const primaryPromoted =
      promote !== null &&
      (restored.contacts ?? []).some((row) => row.contactId === promote && row.primaryContact === true);
    await audit.append(`units#${unitId}`, 'unit_restored', {
      actor: req.user?.userId,
      ...(next !== null
        ? { landlordReplaced: { from: storedLandlordId, to: next.contactId } }
        : {
            landlordCleared: { from: storedLandlordId },
            ...(primaryPromoted && { primaryPromoted: { to: promote } }),
          }),
    });
    log.info(
      {
        unitId,
        actor: req.user?.userId,
        landlordCleared: next === null,
        ...(primaryPromoted && { primaryPromoted: promote }),
      },
      'unit restored via api with a landlord change',
    );
    // The enriched roster (the roster routes' shape) so the Contacts card can
    // apply the new landlord of record in place.
    res.json({ unit: { ...restored, contacts: await enrichRoster(restored) } });
  });

  return router;
}
