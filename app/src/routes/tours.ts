// Tours router — first-class Tour entity (Tours feature).
// Mounted under /api/tours, behind requireAuth via the /api mount (app.ts).
// VAs schedule and manage tours, so NO admin gate (same posture as contacts).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt?, tourType } → 201 { tour }
//   GET   /api/tours/:tourId                                         → { tour } | 404
//   GET   /api/tours/:tourId/activity?limit=&before=       -> { events } | 404
//   GET   /api/tours?tenantId=&unitId=&from=&to=&status=             → { tours }
//   PATCH /api/tours/:tourId  { scheduledAt?, status?, outcome?, moveForward? }
//                                                                    → { tour } | 404
//   POST  /api/tours/:tourId/relay  { members? }                     → 201 { tour, conversation }
//
// POST: scheduledAt is OPTIONAL. Absent → the tour is created 'requested' (the
// timeless coordination anchor; no scheduledAt attribute stored, no reminders).
// Present → status 'scheduled' and the reminder ladder arms immediately.
//
// PATCH supports:
//   - Reschedule: { scheduledAt } — allowed only when canReschedule(current status)
//     or when the status field brings the tour to 'scheduled'. Booking: a
//     scheduledAt patch on a 'requested' tour (no explicit status) auto-advances
//     it to 'scheduled' in the same update.
//   - Status change: { status } — allowlisted via isTourStatus; illegal transitions
//     (e.g. closed → scheduled) are rejected 409.
//   - Exit gate: { outcome, moveForward } — records the navigator decision; sets
//     convertible:true when moveForward is true. Does NOT create a placement or
//     touch tenant status (conversion is a downstream feature).
//
// GET ?status=: optional filter validated against isTourStatus (400 on unknown).
// The existing tenantId/unitId/from+to modes are unchanged; status may be
// supplied as the SOLE filter. The 400-on-no-filter rule is preserved.
//
// POST /api/tours/:tourId/relay provisions a masked relay group thread for a tour
// (Task 5). One thread per tour is ENFORCED: a tour that already carries a
// groupThreadId is refused (409 relay_already_provisioned). members is OPTIONAL —
// absent/empty auto-resolves [tenant, unit's landlord] from contacts.
// Multi-concurrent-tour numbering/UX is OUT OF SCOPE (one thread per tour;
// see docs/issues/group-threads-across-multiple-tours.md).
//
// Validation is a strict field allowlist (unknown fields → 400). Mirror of
// units.ts idioms: error shapes, 404 codes, createXRouter(deps) factory.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router, type Response } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  canReschedule,
  isTourOutcome,
  isTourStatus,
  isTourType,
  TOUR_STATUSES,
  TOUR_OUTCOMES,
  TOUR_TYPES,
  type TourOutcome,
  type TourStatus,
  type TourType,
} from '../lib/toursModel.js';
import { createToursRepo, type TourItem, type ToursRepo } from '../repos/toursRepo.js';
import {
  armTourReminders,
  cancelTourReminders,
  readQuietHoursWindow,
} from '../jobs/tourReminders.js';
import { createTourRemindersRepo, type TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { appEvents, type EventBus } from '../lib/events.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, unitContacts, type UnitsRepo } from '../repos/unitsRepo.js';
import { createAuditRepo, type AuditEvent, type AuditRepo } from '../repos/auditRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
  type ActivityEventType,
} from '../repos/activityEventsRepo.js';
import {
  addMemberToRelay,
  removeMemberFromRelay,
  resolveMemberName,
  type RelayMemberDeps,
} from '../services/relayMembers.js';
import {
  applyRosterPlanEdit,
  buildAddPreview,
  buildOpenPreview,
  parseRosterEntryInput,
  resolveRosterCandidate,
  ROSTER_NO_THREAD,
  ROSTER_THREAD_EXISTS,
  ROSTER_UNAVAILABLE,
  type QuietHoursState,
  type RosterEditRefusal,
  type RosterPlanState,
  type RosterPlanStore,
} from '../services/rosterEdits.js';
import {
  describeRoster,
  resolveRoster,
  type RosterOwner,
  type RosterResolutionDeps,
} from '../lib/rosterResolution.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
  type PoolNumbersService,
} from '../services/poolNumbers.js';
import { provisionRelayGroup } from '../services/relayProvisioning.js';
import { armRelayCloseNagIfOpen } from '../services/relayCloseNag.js';
import { VoiceCapabilityError } from '../adapters/messaging.js';
import { normalizeToE164 } from '../lib/phone.js';
import { recordPersonMilestone, recordRosterMilestone } from '../lib/personEvents.js';
import { zipFive } from '../lib/address.js';
import { loadConfig, type AppConfig } from '../lib/config.js';

/**
 * Validate that a string is a parseable ISO 8601 datetime.
 * We accept any value that new Date() parses to a finite timestamp — the
 * simplest correct check that covers ISO 8601 extended format strings.
 */
function isValidIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

// Allowed POST body fields (strict allowlist — unknown fields → 400).
const POST_ALLOWED = new Set(['tenantId', 'unitId', 'scheduledAt', 'tourType']);

// Allowed PATCH body fields (strict allowlist).
const PATCH_ALLOWED = new Set(['scheduledAt', 'status', 'outcome', 'moveForward']);

// --- Tour activity projection (GET /:tourId/activity, tour-detail-page 1a) ---

/**
 * One tour Activity row on the wire. Details are a FIXED-KEY whitelist lifted
 * from the audit payload - NEVER the raw payload document (a future payload
 * field cannot leak through here). Mirrors the units#/activity projection
 * STYLE; paging (limit + before cursor) follows the placement-history pattern
 * (orchestrator decision E-D1).
 */
interface TourActivityEvent {
  /** The audit `ts` SK (`<ISO>#<suffix>`) - unique within the tour; doubles as the `before` cursor. */
  id: string;
  /** ISO 8601 - the ts prefix (when the event happened). */
  at: string;
  type: string;
  /** The acting user, when the event was not a system action. */
  actorId?: string;
  tourId?: string;
  /** The created placement (tour_converted rows). */
  placementId?: string;
  /** The opened group thread (tour_group_opened rows). */
  conversationId?: string;
}

/** Project one audit row -> the Activity wire shape (fixed-key whitelist). */
function toTourActivityEvent(e: AuditEvent): TourActivityEvent {
  const p = e.payload ?? {};
  const str = (key: string): string | undefined =>
    typeof p[key] === 'string' ? (p[key] as string) : undefined;
  // `at` is the ISO prefix of the `<ISO>#<suffix>` SK (same derivation as the
  // unit activity read) - the SK IS the timestamp the trail sorts by.
  const hash = e.ts.indexOf('#');
  const at = hash > 0 ? e.ts.slice(0, hash) : e.ts;
  return {
    id: e.ts,
    at,
    type: e.event_type,
    ...(typeof e.actorId === 'string' && { actorId: e.actorId }),
    ...(str('tourId') !== undefined && { tourId: str('tourId') }),
    ...(str('placementId') !== undefined && { placementId: str('placementId') }),
    ...(str('conversationId') !== undefined && { conversationId: str('conversationId') }),
  };
}

const DEFAULT_ACTIVITY_LIMIT = 50;
const MAX_ACTIVITY_LIMIT = 100;

/** Parse ?limit= into 1..MAX (default DEFAULT). undefined = invalid -> 400. */
function parseActivityLimit(raw: unknown): number | undefined {
  if (raw === undefined) return DEFAULT_ACTIVITY_LIMIT;
  if (typeof raw !== 'string') return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ACTIVITY_LIMIT) return undefined;
  return limit;
}

export interface ToursRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
  /** Quiet-hours window for arm-time dueAt clamping (quiet-hours spec 2026-08-03). */
  settingsRepo?: SettingsRepo;
  /** For relay provisioning (Task 5). */
  conversationsRepo?: ConversationsRepo;
  auditRepo?: AuditRepo;
  poolNumbersService?: PoolNumbersService;
  /** Relay auto-membership: resolve the tour's tenant contact (phone + name). */
  contactsRepo?: ContactsRepo;
  /** Relay auto-membership: resolve the tour's unit → its landlord contact. */
  unitsRepo?: UnitsRepo;
  /** Person-centric milestone log — emits tour_took_place on the toured transition. */
  activityEventsRepo?: ActivityEventsRepo;
  events?: EventBus;
  /**
   * Injected clock for arm/re-arm dueAt computation — defaults to wall clock.
   * Tests inject this to assert exact dueAt values; production omits it.
   */
  now?: () => string;
}

export function createToursRouter(deps: ToursRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const reminders = deps.tourRemindersRepo ?? createTourRemindersRepo({ logger: deps.logger });
  const settingsRepo = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const conversations =
    deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const poolNumbers =
    deps.poolNumbersService ?? createPoolNumbersService({ config, logger: deps.logger });
  const events = deps.events ?? appEvents;
  const getNow = deps.now ?? (() => new Date().toISOString());

  const router = Router();

  // Best-effort write of a tour lifecycle event to THREE surfaces: BOTH
  // parties' contact timelines (the tenant's and the unit landlord's - one
  // activity event each, via lib/personEvents), the property's Activity card
  // (a `units#<unitId>` audit row), and the tour's OWN history (a
  // `tours#<tourId>` audit row - tour-detail-page 1a, feeds
  // GET /api/tours/:tourId/activity). Each write is independently guarded -
  // NONE may fail the route (state is already persisted). PII-safe log:
  // ids/type only.
  async function recordTourEvent(
    tour: { tenantId: string; unitId: string; tourId: string },
    activityType: ActivityEventType,
    auditType: string,
    label: string,
  ): Promise<void> {
    await recordPersonMilestone(
      { activityEvents, units, log },
      {
        tenantId: tour.tenantId,
        unitId: tour.unitId,
        type: activityType,
        label,
        refType: 'tour',
        refId: tour.tourId,
      },
    );
    try {
      await audit.append(`units#${tour.unitId}`, auditType, { tourId: tour.tourId });
    } catch (err) {
      log.error({ err, tourId: tour.tourId }, `${auditType} unit audit failed (best-effort)`);
    }
    try {
      await audit.append(`tours#${tour.tourId}`, auditType, { tourId: tour.tourId });
    } catch (err) {
      log.error({ err, tourId: tour.tourId }, `${auditType} tour audit failed (best-effort)`);
    }
  }

  // POST /api/tours — create a tour. With scheduledAt → 'scheduled' + armed
  // ladder; without → 'requested' (timeless), nothing armed until booking.
  router.post('/', async (req, res) => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;

    // Unknown-field check (allowlist).
    const unknownFields = Object.keys(b).filter((k) => !POST_ALLOWED.has(k));
    if (unknownFields.length > 0) {
      res.status(400).json({ error: `unknown field(s): ${unknownFields.join(', ')}` });
      return;
    }

    // Required: tenantId
    if (typeof b['tenantId'] !== 'string' || b['tenantId'].length === 0) {
      res.status(400).json({ error: 'tenantId is required' });
      return;
    }
    // Required: unitId
    if (typeof b['unitId'] !== 'string' || b['unitId'].length === 0) {
      res.status(400).json({ error: 'unitId is required' });
      return;
    }
    // Optional: scheduledAt (valid ISO datetime when present). Absent → the
    // tour is created timeless ('requested') and no reminders are armed.
    const scheduledAt = b['scheduledAt'];
    if (scheduledAt !== undefined && !isValidIso(scheduledAt)) {
      res.status(400).json({ error: 'scheduledAt must be a valid ISO 8601 datetime' });
      return;
    }
    // Required: tourType (allowlisted)
    if (!isTourType(b['tourType'])) {
      res.status(400).json({ error: `tourType must be one of: ${TOUR_TYPES.join(', ')}` });
      return;
    }

    // Timeless create: OMIT scheduledAt entirely (never undefined/null) so the
    // sparse byScheduledAt GSI stays sparse; status is 'requested' until booked.
    // scheduledAt is CANONICALIZED to toISOString() at the boundary: a zoneless
    // datetime-local string would otherwise be parsed in the SERVER's timezone
    // by computeDueAt, and the byScheduledAt GSI compares range keys
    // lexicographically — mixed canonical/raw forms mis-bucket range queries.
    const tour = await tours.create({
      tenantId: b['tenantId'] as string,
      unitId: b['unitId'] as string,
      tourType: b['tourType'] as TourType,
      ...(scheduledAt !== undefined
        ? { scheduledAt: new Date(scheduledAt as string).toISOString() }
        : { status: 'requested' satisfies TourStatus }),
    });

    // Arm the reminder ladder (best-effort side effect) — only once a time exists.
    // Invariant: no reminder rows may ever exist for a 'requested' / time-less tour.
    if (scheduledAt !== undefined) {
      await armTourReminders(tour, getNow(), {
        tourRemindersRepo: reminders,
        settingsRepo,
        logger: log,
      });
      // A reminder ladder now exists — nudge the contact timeline's pinned
      // "Upcoming" section to refetch live (scheduled-message-visibility Task 6).
      // ID-only, advisory payload; a requested/timeless create arms nothing so
      // it deliberately does NOT emit.
      events.emit('scheduled.updated', { contactId: tour.tenantId });
    }

    // Dual-write the lifecycle event to the tenant timeline + property audit —
    // ONLY for a scheduled create (a timeless 'requested' create emits nothing).
    if (tour.status === 'scheduled') {
      await recordTourEvent(tour, 'tour_scheduled', 'tour_scheduled', 'Tour scheduled');
    }

    log.info({ tourId: tour.tourId, tenantId: tour.tenantId, unitId: tour.unitId }, 'tour created via api');
    res.status(201).json({ tour });
  });

  // GET /api/tours — list tours by tenantId, unitId, scheduled range (from+to),
  // or status. Priority: tenantId > unitId > from+to > status.
  // All existing modes are unchanged; ?status= is a new sole-filter option.
  // Still returns 400 with no filter at all.
  router.get('/', async (req, res) => {
    const tenantId = req.query['tenantId'];
    const unitId = req.query['unitId'];
    const from = req.query['from'];
    const to = req.query['to'];
    const statusFilter = req.query['status'];

    let tourList: TourItem[];
    if (typeof tenantId === 'string' && tenantId.length > 0) {
      tourList = await tours.listByTenant(tenantId);
    } else if (typeof unitId === 'string' && unitId.length > 0) {
      tourList = await tours.listByUnit(unitId);
    } else if (
      typeof from === 'string' && from.length > 0 &&
      typeof to === 'string' && to.length > 0
    ) {
      if (!isValidIso(from) || !isValidIso(to)) {
        res.status(400).json({ error: 'from and to must be valid ISO 8601 datetimes' });
        return;
      }
      tourList = await tours.listByScheduledRange(from, to);
    } else if (typeof statusFilter === 'string' && statusFilter.length > 0) {
      // Validate the status value against the known enum before hitting DynamoDB.
      if (!isTourStatus(statusFilter)) {
        res.status(400).json({ error: `status must be one of: ${TOUR_STATUSES.join(', ')}` });
        return;
      }
      tourList = await tours.listByStatus(statusFilter);
    } else {
      res.status(400).json({
        error: 'one of tenantId, unitId, from+to, or status is required',
      });
      return;
    }

    res.json({ tours: tourList });
  });

  // GET /api/tours/:tourId — one tour. 404 when not found.
  router.get('/:tourId', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    res.json({ tour });
  });

  // GET /api/tours/:tourId/activity?limit=&before= - the tour page's Activity
  // card read (tour-detail-page 1a; resolves tour-activity-no-tour-page-surface
  // once the card lands in 1b). Serves the tour's OWN audit trail (entityKey
  // `tours#<tourId>`: tour_scheduled / tour_rescheduled / tour_took_place /
  // tour_no_show / tour_canceled / tour_outcome / tour_group_opened /
  // tour_converted) NEWEST-FIRST via auditRepo.listByEntity, projected onto
  // TourActivityEvent (fixed-key whitelist, never the raw payload). Paging is
  // the PLACEMENT-HISTORY pattern (E-D1): bounded ?limit= (1..MAX, default
  // DEFAULT) + optional ?before= exclusive `ts` upper bound (a row's `id`) for
  // load-more. 404 unknown tour. Forward-only - no backfill, same policy as
  // the unit Activity card. PII (doc section 9): ids/counts only in logs.
  router.get('/:tourId/activity', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const limit = parseActivityLimit(req.query['limit']);
    if (limit === undefined) {
      res.status(400).json({ error: `limit must be an integer 1..${MAX_ACTIVITY_LIMIT}` });
      return;
    }
    const before =
      typeof req.query['before'] === 'string' && req.query['before'].length > 0
        ? req.query['before']
        : undefined;
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const rows = await audit.listByEntity(`tours#${tourId}`, {
      limit,
      ...(before !== undefined && { before }),
    });
    const projected = rows.map(toTourActivityEvent);
    log.info({ tourId, returned: projected.length }, 'tour activity served');
    res.json({ events: projected });
  });

  // GET /api/tours/:tourId/roster - the People card payload (contact-rosters
  // Task 5). Serves the ONE shared serializer (lib/rosterResolution.
  // describeRoster) so the tour and placement cards can never disagree about
  // who is on a roster or how a row is labeled. 404 unknown tour.
  //
  // PII (doc section 9): the RESPONSE carries names + phone last4 to the authed
  // client; the LOG line carries ids and counts only, and the full phone never
  // leaves the server.
  router.get('/:tourId/roster', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const view = await describeRoster(
      { conversations, units, contacts, log },
      {
        type: 'tour',
        id: tour.tourId,
        tenantId: tour.tenantId,
        unitId: tour.unitId,
        ...(tour.groupThreadId !== undefined && { groupThreadId: tour.groupThreadId }),
        ...(tour.roster !== undefined && { roster: tour.roster }),
      },
    );
    log.info(
      { tourId, source: view.source, memberCount: view.members.length },
      'tour roster served',
    );
    res.json(view);
  });

  // -------------------------------------------------------------------------
  // Roster EDITING (contact-rosters Task 10)
  // -------------------------------------------------------------------------
  //
  //   POST   /:tourId/roster/members            { contactId } | { phone }
  //   DELETE /:tourId/roster/members/:memberKey
  //   POST   /:tourId/roster/reset
  //   POST   /:tourId/roster/live-members       { contactId }
  //   DELETE /:tourId/roster/live-members/:memberKey
  //   GET    /:tourId/roster/preview-open
  //   POST   /:tourId/roster/preview-add        { contactId }
  //
  // The split is D1's: the PLAN endpoints edit the override and REFUSE (409
  // thread_exists) once a thread exists; the LIVE endpoints call through to
  // the thread's own roster and refuse (409 no_thread) before one does. The
  // dashboard NEVER auto-resubmits a plan edit through the live path - a
  // silent plan edit must not become a text nobody confirmed (spec section 7).
  //
  // Every mutating endpoint answers with the SAME payload GET /roster serves,
  // so one shape re-renders the card.
  //
  // PII (doc section 9): bodies carry names + last4; logs carry ids/counts.

  /** The resolver + serializer deps (lib/rosterResolution), built once. */
  const rosterDeps: RosterResolutionDeps = { conversations, units, contacts, log };

  /** Everything services/relayMembers touches for the LIVE call-through. */
  const memberDeps: RelayMemberDeps = {
    conversations,
    contacts,
    audit,
    activityEvents,
    poolNumbers,
    events,
    log,
  };

  /** The resolver's owner view of a tour (thread pointer + plan override). */
  function rosterOwnerOf(tour: TourItem): RosterOwner {
    return {
      type: 'tour',
      id: tour.tourId,
      tenantId: tour.tenantId,
      unitId: tour.unitId,
      ...(tour.groupThreadId !== undefined && { groupThreadId: tour.groupThreadId }),
      ...(tour.roster !== undefined && { roster: tour.roster }),
    };
  }

  /** The plan-write state the conditional writes guard on. */
  const planStateOf = (tour: TourItem): RosterPlanState => ({
    ...(tour.roster !== undefined && { roster: tour.roster }),
    ...(tour.rosterVersion !== undefined && { rosterVersion: tour.rosterVersion }),
  });

  const planStoreFor = (tourId: string): RosterPlanStore => ({
    reload: async () => {
      const fresh = await tours.get(tourId);
      return fresh === undefined ? undefined : planStateOf(fresh);
    },
    setRoster: async (roster, expectedVersion) =>
      planStateOf(await tours.setRoster(tourId, roster, expectedVersion)),
    clearRoster: () => tours.clearRoster(tourId),
  });

  /** The thread pointer, or undefined. A `provisioning:<tourId>` claim sentinel
   *  COUNTS as a thread: a plan edit during that window would be consumed or
   *  lost by the provision it is racing. */
  const threadIdOf = (tour: TourItem): string | undefined =>
    typeof tour.groupThreadId === 'string' && tour.groupThreadId.length > 0
      ? tour.groupThreadId
      : undefined;

  const sendRefusal = (res: Response, refusal: RosterEditRefusal): void => {
    res.status(refusal.status).json({
      error: refusal.error,
      ...(refusal.message !== undefined && { message: refusal.message }),
    });
  };

  /** Re-read + serialize - the 200 body of every mutating roster endpoint. */
  async function respondWithRoster(res: Response, tourId: string): Promise<void> {
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const view = await describeRoster(rosterDeps, rosterOwnerOf(tour));
    log.info({ tourId, source: view.source, memberCount: view.members.length }, 'tour roster edited');
    res.json(view);
  }

  /** The clock + org window a preview evaluates quiet hours against. */
  async function quietHoursState(): Promise<QuietHoursState> {
    return { nowIso: getNow(), window: await readQuietHoursWindow(settingsRepo, log) };
  }

  // --- PLAN writes (no thread) ---------------------------------------------

  router.post('/:tourId/roster/members', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    if (threadIdOf(tour) !== undefined) {
      sendRefusal(res, ROSTER_THREAD_EXISTS);
      return;
    }
    const entry = parseRosterEntryInput(req.body);
    if ('error' in entry) {
      res.status(400).json({ error: 'invalid_member', message: entry.error });
      return;
    }
    const outcome = await applyRosterPlanEdit(rosterDeps, planStoreFor(tourId), {
      owner: { type: 'tour', id: tour.tourId, tenantId: tour.tenantId, unitId: tour.unitId },
      state: planStateOf(tour),
      edit: { kind: 'add', entry },
      notFoundError: 'tour_not_found',
    });
    if (!outcome.ok) {
      sendRefusal(res, outcome.refusal);
      return;
    }
    await respondWithRoster(res, tourId);
  });

  router.delete('/:tourId/roster/members/:memberKey', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    if (threadIdOf(tour) !== undefined) {
      sendRefusal(res, ROSTER_THREAD_EXISTS);
      return;
    }
    const outcome = await applyRosterPlanEdit(rosterDeps, planStoreFor(tourId), {
      owner: { type: 'tour', id: tour.tourId, tenantId: tour.tenantId, unitId: tour.unitId },
      state: planStateOf(tour),
      edit: { kind: 'remove', memberKey: String(req.params['memberKey'] ?? '') },
      notFoundError: 'tour_not_found',
    });
    if (!outcome.ok) {
      sendRefusal(res, outcome.refusal);
      return;
    }
    await respondWithRoster(res, tourId);
  });

  // RESET = delete the override. The roster then re-resolves from the property
  // on every read, so a later change of primary contact is picked up.
  router.post('/:tourId/roster/reset', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    if (threadIdOf(tour) !== undefined) {
      sendRefusal(res, ROSTER_THREAD_EXISTS);
      return;
    }
    await tours.clearRoster(tourId);
    await respondWithRoster(res, tourId);
  });

  // --- LIVE call-through (a thread exists, any status) ---------------------

  router.post('/:tourId/roster/live-members', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const threadId = threadIdOf(tour);
    if (threadId === undefined) {
      sendRefusal(res, ROSTER_NO_THREAD);
      return;
    }
    const resolvedCandidate = await resolveRosterCandidate(contacts, req.body);
    if (!resolvedCandidate.ok) {
      sendRefusal(res, resolvedCandidate.refusal);
      return;
    }
    const { candidate } = resolvedCandidate;
    const conversation = await conversations.getById(threadId);
    if (!conversation) {
      sendRefusal(res, ROSTER_UNAVAILABLE);
      return;
    }
    // Spec section 7 carve-out: a CLOSED thread's add is silent AND immediate.
    // There is nobody to announce to on a closed thread, so it is never
    // deferred either (slice 6 leaves this branch alone).
    const announce = conversation.status !== 'closed';
    const result = await addMemberToRelay(
      memberDeps,
      threadId,
      { contactId: candidate.contactId, phone: candidate.phone },
      { announce, ...(actor !== undefined && { actor }) },
    );
    if (!result.ok) {
      sendRefusal(res, result.refusal);
      return;
    }
    await respondWithRoster(res, tourId);
  });

  // The SERVER locates the participant row (by contactId or `phone:<E164>`)
  // and removes it by THE PHONE STORED ON THAT ROW - the client only ever
  // holds a memberKey and phoneLast4. Immediate; never deferred, never
  // announced.
  router.delete('/:tourId/roster/live-members/:memberKey', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const threadId = threadIdOf(tour);
    if (threadId === undefined) {
      sendRefusal(res, ROSTER_NO_THREAD);
      return;
    }
    const result = await removeMemberFromRelay(
      memberDeps,
      threadId,
      String(req.params['memberKey'] ?? ''),
      // refuseLastMember: the roster floor holds on live threads too (spec:
      // "a thread's participants never go empty") - the card disables the
      // last row's remove, this is the server backstop.
      { refuseLastMember: true, ...(actor !== undefined && { actor }) },
    );
    if (!result.ok) {
      sendRefusal(res, result.refusal);
      return;
    }
    await respondWithRoster(res, tourId);
  });

  // --- Previews (server-composed; the client never rebuilds a body) --------

  router.get('/:tourId/roster/preview-open', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    if (threadIdOf(tour) !== undefined) {
      // Never preview an open that can only 409.
      sendRefusal(res, { status: 409, error: 'relay_already_provisioned' });
      return;
    }
    const preview = await buildOpenPreview(rosterDeps, rosterOwnerOf(tour), await quietHoursState());
    if (!preview.ok) {
      sendRefusal(res, preview.refusal);
      return;
    }
    res.json(preview.preview);
  });

  router.post('/:tourId/roster/preview-add', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    // A pre-open add sends nothing, so there is no body to preview: refuse
    // rather than render a message that will never go out.
    if (threadIdOf(tour) === undefined) {
      sendRefusal(res, ROSTER_NO_THREAD);
      return;
    }
    const resolvedCandidate = await resolveRosterCandidate(contacts, req.body);
    if (!resolvedCandidate.ok) {
      sendRefusal(res, resolvedCandidate.refusal);
      return;
    }
    const preview = await buildAddPreview(
      rosterDeps,
      rosterOwnerOf(tour),
      resolvedCandidate.candidate,
      await quietHoursState(),
    );
    if (!preview.ok) {
      sendRefusal(res, preview.refusal);
      return;
    }
    res.json(preview.preview);
  });

  // PATCH /api/tours/:tourId — partial update with transition guards.
  router.patch('/:tourId', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const b = body as Record<string, unknown>;

    // Unknown-field check.
    const unknownFields = Object.keys(b).filter((k) => !PATCH_ALLOWED.has(k));
    if (unknownFields.length > 0) {
      res.status(400).json({ error: `unknown field(s): ${unknownFields.join(', ')}` });
      return;
    }

    // Must supply at least one patchable field.
    if (Object.keys(b).length === 0) {
      res.status(400).json({ error: 'patch body must include at least one field' });
      return;
    }

    // Validate individual fields when present.
    const newScheduledAt = b['scheduledAt'];
    const newStatus = b['status'];
    const newOutcome = b['outcome'];
    const newMoveForward = b['moveForward'];

    if (newScheduledAt !== undefined && !isValidIso(newScheduledAt)) {
      res.status(400).json({ error: 'scheduledAt must be a valid ISO 8601 datetime' });
      return;
    }
    if (newStatus !== undefined && !isTourStatus(newStatus)) {
      res.status(400).json({ error: `status must be one of: ${TOUR_STATUSES.join(', ')}` });
      return;
    }
    if (newOutcome !== undefined && !isTourOutcome(newOutcome)) {
      res.status(400).json({ error: `outcome must be one of: ${TOUR_OUTCOMES.join(', ')}` });
      return;
    }
    if (newMoveForward !== undefined && typeof newMoveForward !== 'boolean') {
      res.status(400).json({ error: 'moveForward must be a boolean' });
      return;
    }

    // Fetch the current tour to check transition legality.
    const current = await tours.get(tourId);
    if (!current) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }

    const currentStatus = current.status as TourStatus;

    // --- Status transition guard ---
    // Rules:
    //   - 'closed' is terminal: no status change is allowed from 'closed'.
    //   - 'requested' is a CREATE-ONLY initial state: nothing transitions into
    //     it, and the only ways out are booking (-> scheduled, which requires a
    //     time) or canceling - toured/no_show presuppose a time.
    //   - The only path back to 'scheduled' is via canReschedule() (i.e. from
    //     requested/scheduled/canceled/no_show - NOT toured/closed).
    if (newStatus !== undefined) {
      const targetStatus = newStatus as TourStatus;

      if (currentStatus === 'closed') {
        // closed is fully terminal — no transitions allowed.
        res.status(409).json({ error: 'illegal_status_transition', detail: `a closed tour cannot be changed (current: closed, requested: ${targetStatus})` });
        return;
      }

      if (targetStatus === 'requested') {
        // requested is only ever set at create — a tour with (or past) a time
        // cannot claim to be timeless again.
        res.status(409).json({ error: 'illegal_status_transition', detail: `a tour cannot move back to requested (current: ${currentStatus})` });
        return;
      }

      if (currentStatus === 'requested' && targetStatus !== 'scheduled' && targetStatus !== 'canceled') {
        // Booking is the only forward path out of requested (the diagram's
        // booking step is what advances the tour); toured/no_show on a tour
        // that never had a time would break booking semantics - e.g. an
        // unreschedulable 'toured' dead end with no ladder ever armed.
        res.status(409).json({ error: 'illegal_status_transition', detail: `a requested tour can only be booked (scheduled) or canceled (requested: ${targetStatus})` });
        return;
      }

      if (targetStatus === 'scheduled' && !canReschedule(currentStatus)) {
        // Only reschedulable statuses may go back to 'scheduled'.
        res.status(409).json({ error: 'illegal_status_transition', detail: `cannot reschedule from status: ${currentStatus}` });
        return;
      }

      if (
        targetStatus === 'scheduled' &&
        newScheduledAt === undefined &&
        current.scheduledAt === undefined
      ) {
        // 'scheduled' means a time exists — a tour that never had one (e.g.
        // still 'requested') cannot be scheduled without a scheduledAt.
        res.status(400).json({ error: 'scheduledAt is required to schedule this tour' });
        return;
      }
    }

    // --- Reschedule (scheduledAt only, no status change) ---
    // If only scheduledAt is being changed (not a status transition), the tour
    // must be in a reschedulable state.
    if (newScheduledAt !== undefined && newStatus === undefined) {
      if (!canReschedule(currentStatus)) {
        res.status(409).json({ error: 'illegal_status_transition', detail: `cannot reschedule from status: ${currentStatus}` });
        return;
      }
    }

    // --- Exit gate guard ---
    // The exit gate records the decision on a TOURED tour (diagram: outcome is
    // logged after the visit). This also makes a closed tour's decision
    // immutable — outcome-only patches used to bypass the closed-terminal 409,
    // letting `convertible` flip after closure (the field downstream Post-Tour
    // conversion trusts).
    if ((newOutcome !== undefined || newMoveForward !== undefined) && currentStatus !== 'toured') {
      res.status(409).json({ error: 'illegal_exit_gate', detail: `the exit gate records a decision on a toured tour (current: ${currentStatus})` });
      return;
    }

    // --- Build the patch ---
    // scheduledAt is CANONICALIZED (toISOString) at the boundary — see the
    // create route for why (server-TZ parsing in computeDueAt + lexicographic
    // byScheduledAt GSI range compares).
    // Exit gate: outcome + moveForward → also set convertible.
    const patch: Record<string, unknown> = {};
    const scheduledAtIso =
      newScheduledAt !== undefined ? new Date(newScheduledAt as string).toISOString() : undefined;
    if (scheduledAtIso !== undefined) patch['scheduledAt'] = scheduledAtIso;
    if (newStatus !== undefined) patch['status'] = newStatus;
    // Booking / revival: a scheduledAt patch with no explicit status on a
    // requested (booking), canceled, or no_show (revival) tour auto-advances to
    // 'scheduled' in the same update - a fresh time on a dead-but-reschedulable
    // tour must never leave it reading Canceled/No show with a live ladder.
    if (
      scheduledAtIso !== undefined &&
      newStatus === undefined &&
      (currentStatus === 'requested' || currentStatus === 'canceled' || currentStatus === 'no_show')
    ) {
      patch['status'] = 'scheduled' satisfies TourStatus;
    }
    if (newOutcome !== undefined) patch['outcome'] = newOutcome;
    if (newMoveForward !== undefined) {
      patch['moveForward'] = newMoveForward;
      // Exit gate: convertible is true iff moveForward is true.
      patch['convertible'] = newMoveForward === true;
    }

    let tour: TourItem;
    try {
      tour = await tours.patch(tourId, patch);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'tour_not_found' });
        return;
      }
      throw err;
    }

    // Reminder side effects after a successful patch, keyed on the EFFECTIVE
    // post-patch status — arming must never happen on a tour that is not live
    // (e.g. PATCH {scheduledAt, status:'canceled'} must not text "Your tour is
    // confirmed" at the whole group), and a terminal transition (toured / no_show
    // / canceled / closed) must cancel the still-pending rungs (a tenant who
    // showed up, or a tour flagged no-show, must never get a later "your tour is
    // tomorrow" reminder).
    const effectiveStatus = (patch['status'] ?? currentStatus) as TourStatus;
    const armable = effectiveStatus === 'scheduled';
    // Re-arm on a time change, or on an explicit move INTO 'scheduled' (a
    // status-only revival from canceled/no_show uses the stored time - its
    // rungs were canceled and must come back).
    const rearmTrigger = scheduledAtIso !== undefined || patch['status'] === 'scheduled';
    // Whether the reminder ladder changed on this patch — drives the ONE
    // scheduled.updated emit below (arm/reschedule OR cancel, never both).
    let ladderChanged = false;
    if (armable && rearmTrigger) {
      await cancelTourReminders(tourId, { tourRemindersRepo: reminders, logger: log });
      await armTourReminders(tour, getNow(), {
        tourRemindersRepo: reminders,
        settingsRepo,
        logger: log,
      });
      ladderChanged = true;
    } else if (
      effectiveStatus === 'canceled' ||
      effectiveStatus === 'closed' ||
      effectiveStatus === 'toured' ||
      effectiveStatus === 'no_show'
    ) {
      // Dead, completed, or no-show: nothing left to auto-remind, so cancel any
      // still-pending rungs. The no-show check-in is a MANUAL send from the tour
      // page now (not an auto-armed rung), so a no_show tour has nothing to
      // preserve - and canceling stops its day_before/morning_of/en_route from
      // later firing "your tour is tomorrow" at a tour already flagged no-show.
      await cancelTourReminders(tourId, { tourRemindersRepo: reminders, logger: log });
      ladderChanged = true;
    }
    // ONE emit after the cancel+arm pair (scheduled-message-visibility Task 6):
    // the contact timeline's pinned "Upcoming" section refetches so the
    // rescheduled/canceled future item moves live. ID-only, advisory payload.
    if (ladderChanged) {
      events.emit('scheduled.updated', { contactId: tour.tenantId });
    }

    // Tour lifecycle → tenant timeline + property (unit) audit (WS4). Each
    // surfaced transition dual-writes both surfaces (best-effort, idempotent per
    // REAL transition). We key on `effectiveStatus` (patch['status'] ?? current)
    // — NOT the body-only `newStatus` — so booking/revival auto-advances (which
    // set patch['status']='scheduled' with body newStatus undefined) are caught.
    // Each INTO-status guard is against `currentStatus` (a no-op re-PATCH to the
    // same status never re-emits). PII: ids/type only (never the label) in logs.
    const t = { tenantId: current.tenantId, unitId: current.unitId, tourId };
    // A bare time change on a tour that stays 'scheduled' is a reschedule - but
    // ONLY when the time actually changed. A no-op re-PATCH to the identical
    // scheduledAt must emit nothing (mirroring the INTO-status milestones'
    // `currentStatus !== X` idempotency). scheduledAtIso is canonicalized
    // (toISOString) exactly as the stored current.scheduledAt is, so a string
    // compare cleanly detects a genuine change.
    const wasReschedule =
      scheduledAtIso !== undefined &&
      currentStatus === 'scheduled' &&
      effectiveStatus === 'scheduled' &&
      scheduledAtIso !== current.scheduledAt;
    if (effectiveStatus === 'scheduled' && currentStatus !== 'scheduled') {
      await recordTourEvent(t, 'tour_scheduled', 'tour_scheduled', 'Tour scheduled');
    } else if (wasReschedule) {
      await recordTourEvent(t, 'tour_scheduled', 'tour_rescheduled', 'Tour rescheduled');
    }
    if (effectiveStatus === 'toured' && currentStatus !== 'toured') {
      await recordTourEvent(t, 'tour_took_place', 'tour_took_place', 'Tour took place');
    }
    if (effectiveStatus === 'no_show' && currentStatus !== 'no_show') {
      await recordTourEvent(t, 'tour_no_show', 'tour_no_show', 'Tour no-show');
    }
    if (effectiveStatus === 'canceled' && currentStatus !== 'canceled') {
      await recordTourEvent(t, 'tour_canceled', 'tour_canceled', 'Tour canceled');
    }
    // Exit gate: `newOutcome`/`newMoveForward` are the parsed body locals; the
    // gate already 409'd unless currentStatus==='toured'. Idempotent: emit only
    // when the outcome was previously unset — a second identical PATCH won't
    // re-emit (current.outcome is the pre-patch value).
    const outcomeNewlySet = newOutcome !== undefined && current.outcome === undefined;
    if (outcomeNewlySet) {
      await recordTourEvent(
        t,
        'tour_outcome',
        'tour_outcome',
        `Tour outcome - ${newMoveForward === true ? 'moved forward' : 'not a fit'}`,
      );
    }

    // D5 close-nag safety net (AF-1/CF-1): a terminal tour event that leaves the
    // linked group open past it - canceled, or an exit-gate "not a fit" (NOT
    // move-forward, which continues into a placement and keeps the thread) -
    // arms the 28-day close-nag (set-if-absent) on the group so a forgotten
    // group still surfaces on Today even if the operator dismissed the inline
    // "Also close the group text?" ask. Best-effort - never fails the patch.
    const tourWentCanceled = effectiveStatus === 'canceled' && currentStatus !== 'canceled';
    const tourNotAFit =
      newMoveForward === false || (outcomeNewlySet && newOutcome === 'not_a_fit');
    if (tourWentCanceled || tourNotAFit) {
      await armRelayCloseNagIfOpen({ conversationsRepo: conversations, logger: log }, tour.groupThreadId, 'tour');
    }

    // Live tour-page refresh (tour-detail-page 1a): advise dashboards this tour
    // changed, mirroring placement.updated. Best-effort fire-and-forget (the bus
    // isolates listeners); ID + status only - never names/phones/labels (PII).
    events.emit('tour.updated', { tourId, status: tour.status });

    log.info({ tourId, fields: Object.keys(patch).length }, 'tour patched via api');
    res.json({ tour });
  });

  /**
   * Resolve the tour's relay roster through the ONE shared resolver
   * (lib/rosterResolution.ts): the roster PLAN when the operator materialized
   * one, else the property default (tenant + the unit's primaryContact, with
   * the landlord-of-record fallback). Returns a stable, dashboard-consumable
   * detail string when the roster cannot make a relay (the route maps it to
   * 400 relay_member_unresolvable).
   *
   * A member with no phone is EXCLUDED from the SMS members rather than failing
   * the whole open - a relay needs two reachable people, and who those are is
   * the roster's business, not this function's. Fewer than two left => the
   * ladder below names exactly which rung failed (the same six strings the
   * dashboard has always surfaced).
   */
  async function resolveTourMembers(
    tour: TourItem,
  ): Promise<{ members: ConversationParticipant[] } | { unresolvable: string }> {
    const resolved = await resolveRoster(
      { conversations, units, contacts, log },
      {
        type: 'tour',
        id: tour.tourId,
        tenantId: tour.tenantId,
        unitId: tour.unitId,
        ...(tour.groupThreadId !== undefined && { groupThreadId: tour.groupThreadId }),
        ...(tour.roster !== undefined && { roster: tour.roster }),
      },
    );
    // Unreachable from this route (the one-thread-per-tour guard above already
    // refused a tour carrying a pointer), but the resolver's contract is
    // explicit: an unreadable thread is NEVER silently re-resolved.
    if (resolved.source === 'unavailable') {
      return { unresolvable: 'the group thread could not be read' };
    }

    const members: ConversationParticipant[] = [];
    const seenPhones = new Set<string>();
    for (const member of resolved.members) {
      const phone = member.phone;
      if (typeof phone !== 'string' || phone.length === 0) continue; // unreachable member
      if (seenPhones.has(phone)) continue; // one slot per number (shared phones)
      seenPhones.add(phone);
      members.push({
        phone,
        contactId: member.contactId ?? '',
        ...(member.name !== undefined && { name: member.name }),
      });
    }
    if (members.length >= 2) return { members };

    // Too thin to relay. Name the rung that failed - these strings are the
    // dashboard's error copy and are asserted verbatim by the API tests.
    if (resolved.source === 'plan') {
      return { unresolvable: 'this tour roster has fewer than two reachable members' };
    }
    const tenant = await contacts.getById(tour.tenantId);
    if (!tenant) return { unresolvable: 'tenant contact not found' };
    const tenantPhone =
      typeof tenant.phone === 'string' && tenant.phone.length > 0
        ? normalizeToE164(tenant.phone)
        : undefined;
    if (tenantPhone === undefined) return { unresolvable: 'tenant contact has no phone' };

    const unit = await units.getById(tour.unitId);
    if (!unit) return { unresolvable: 'unit not found (cannot resolve landlord)' };
    // The property's contact is the primaryContact row, falling back to the
    // landlord of record (D3) - the same ladder the resolver walked.
    const propertyContactId =
      unitContacts(unit).find((c) => c.primaryContact === true)?.contactId ??
      (typeof unit.landlordId === 'string' && unit.landlordId.length > 0 ? unit.landlordId : undefined);
    if (propertyContactId === undefined) {
      return { unresolvable: 'unit has no landlord (cannot resolve landlord)' };
    }
    const landlord = await contacts.getById(propertyContactId);
    if (!landlord) return { unresolvable: 'landlord contact not found' };
    const landlordPhone =
      typeof landlord.phone === 'string' && landlord.phone.length > 0
        ? normalizeToE164(landlord.phone)
        : undefined;
    if (landlordPhone === undefined) return { unresolvable: 'landlord contact has no phone' };
    // Both rungs resolve and share ONE number (tenant === property contact):
    // a relay needs two distinct parties.
    return { unresolvable: 'this tour roster has fewer than two reachable members' };
  }

  // POST /api/tours/:tourId/relay — provision a masked relay group thread for a
  // tour (Task 5). Stores the relay conversationId back on the tour as
  // groupThreadId. ONE thread per tour — an already-provisioned tour is refused
  // (409) so a second click never buys a new pool number and orphans the first.
  //
  // Body: { members?: [{ phone, contactId?, name? }, …] }
  //   - members absent or empty → AUTO-RESOLVE the roster as [tenant contact,
  //     unit's landlord contact] (phones + names from contacts); an
  //     unresolvable member → 400 { error: 'relay_member_unresolvable', detail }
  //     naming exactly which member/rung failed.
  //   - explicit members are honored as before; a member carrying contactId
  //     but no name gets the contact's display name (best-effort).
  // Returns: 201 { tour, conversation }
  //
  // PII (doc §9): log ids only (never member phones in log lines).
  router.post('/:tourId/relay', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const actor = (req as AuthedRequest).user?.userId;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Fetch the tour; 404 when missing.
    const tour = await tours.get(tourId);
    if (!tour) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }

    // Dead tours don't get group threads: a stale page's button click must not
    // buy a pool number + text [AUTO] intros for a canceled/closed tour (the
    // UI hides the control, but the route is the guard).
    if (tour.status === 'canceled' || tour.status === 'closed') {
      res.status(409).json({ error: 'tour_not_active', detail: `cannot open a group thread on a ${tour.status} tour` });
      return;
    }

    // One-thread-per-tour guard FIRST: a second provision would silently buy a
    // new pool number and overwrite groupThreadId, orphaning the live thread.
    if (typeof tour.groupThreadId === 'string' && tour.groupThreadId.length > 0) {
      res.status(409).json({ error: 'relay_already_provisioned' });
      return;
    }

    const rawMembers = body['members'];
    if (rawMembers !== undefined && !Array.isArray(rawMembers)) {
      res.status(400).json({ error: 'members must be an array' });
      return;
    }

    let members: ConversationParticipant[];
    if (rawMembers === undefined || rawMembers.length === 0) {
      // AUTO-RESOLVE (founder flow): [tenant, unit's landlord] from contacts.
      const resolved = await resolveTourMembers(tour);
      if ('unresolvable' in resolved) {
        res.status(400).json({ error: 'relay_member_unresolvable', detail: resolved.unresolvable });
        return;
      }
      members = resolved.members;
    } else {
      // Parse + normalize explicit members (reuse the same mini-validator as
      // relayGroups.ts); fill a missing name from contactId (best-effort).
      members = [];
      const seenPhones = new Set<string>();
      for (const raw of rawMembers as unknown[]) {
        if (typeof raw !== 'object' || raw === null) {
          res.status(400).json({ error: 'each member must be an object' });
          return;
        }
        const m = raw as { phone?: unknown; contactId?: unknown; name?: unknown };
        if (typeof m.phone !== 'string' || m.phone.length === 0) {
          res.status(400).json({ error: 'member.phone is required' });
          return;
        }
        const phone = normalizeToE164(m.phone);
        if (phone === undefined) {
          res.status(400).json({ error: `member.phone is not a valid phone: ${m.phone}` });
          return;
        }
        if (seenPhones.has(phone)) continue; // de-dupe
        seenPhones.add(phone);
        const contactId =
          typeof m.contactId === 'string' && m.contactId.length > 0 ? m.contactId : '';
        const name =
          typeof m.name === 'string' && m.name.trim().length > 0 ? m.name.trim() : undefined;
        members.push(
          await resolveMemberName(contacts, { phone, contactId, ...(name !== undefined && { name }) }),
        );
      }
    }

    // Property-ZIP hint for a potential tier-3 buy (area-code preference).
    // Best-effort: a missing unit/address just means no hint - never a 4xx
    // (the roster resolution above already produced its own errors if the
    // unit truly matters). The auto-resolve path fetched the unit internally
    // but does not expose it, and the explicit-members path never loads it.
    // The read is WRAPPED because of that last point: on the explicit-members
    // path this route never touched the units table before, so an unguarded
    // repo/network throw would turn a DynamoDB hiccup into a 500 on a request
    // that used to succeed - a cosmetic hint must never fail group creation.
    let postalCode: string | undefined;
    try {
      const unitForZip = await units.getById(tour.unitId);
      postalCode = zipFive(unitForZip?.address);
    } catch (err) {
      log.warn(
        { err, tourId },
        'tour relay: unit ZIP hint lookup failed - creating the group without the hint',
      );
    }

    // Atomically claim the group-thread slot BEFORE buying anything: the
    // read-guard above is check-then-act, so two overlapping POSTs could both
    // pass it, buy two pool numbers, and orphan the first thread. The claim's
    // ConditionExpression (attribute_not_exists(groupThreadId)) makes the race
    // loser 409 here, before any provisioning side effects. The sentinel is
    // replaced by the real conversation id on success and released on failure;
    // a crash inside this window leaves the sentinel behind (rare — clears by
    // removing groupThreadId), which we prefer over the double-buy.
    const claimSentinel = `provisioning:${tourId}`;
    try {
      await tours.claimGroupThread(tourId, claimSentinel);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(409).json({ error: 'relay_already_provisioned' });
        return;
      }
      throw err;
    }

    // Provision the relay group owned by this tour.
    let conversation;
    try {
      conversation = await provisionRelayGroup(
        {
          conversationsRepo: conversations,
          poolNumbersService: poolNumbers,
          auditRepo: audit,
          events,
          logger: log,
        },
        {
          members,
          owner: { type: 'tour', id: tourId },
          ...(actor !== undefined && { actor }),
          ...(postalCode !== undefined && { postalCode }),
        },
      );
    } catch (err) {
      // Provisioning failed — release the claim so a retry can provision.
      await tours.releaseGroupThreadClaim(tourId, claimSentinel);
      if (err instanceof RelayProvisioningDisabledError) {
        log.warn({ err: { name: err.name }, tourId }, 'tour relay create: number provisioning disabled');
        res.status(503).json({ error: 'relay_provisioning_disabled', message: (err as Error).message });
        return;
      }
      if (err instanceof VoiceCapabilityError) {
        log.error({ err: { name: err.name }, tourId }, 'tour relay create: no voice-capable pool number available');
        res.status(503).json({ error: 'relay_provisioning_failed', message: (err as Error).message });
        return;
      }
      throw err;
    }

    // Stamp the real groupThreadId over the claim sentinel.
    let updatedTour = await tours.patch(tourId, { groupThreadId: conversation.conversationId });

    // THE PLAN IS CONSUMED (spec D1) - and only now, AFTER the thread pointer
    // is written. From here the conversation's participants are the roster, so
    // a second persisted roster must not survive to disagree with them. Order
    // matters both ways: clearing BEFORE the pointer write would lose the plan
    // on a failed stamp, and a crash BETWEEN the two leaves a stale plan that is
    // INERT by precedence (the resolver reads participants first whenever the
    // pointer is set) - never "defensively" merge it back in.
    if (updatedTour.roster !== undefined) {
      try {
        await tours.clearRoster(tourId);
        updatedTour = { ...updatedTour };
        delete updatedTour.roster;
        delete updatedTour.rosterVersion;
      } catch (err) {
        log.error({ err, tourId }, 'tour relay: clearing the consumed roster plan failed (inert leftover)');
      }
    }

    // Connect-when-ready (T6): the group may be CONNECTING (no number yet) rather
    // than open - "opened" would be premature, so mark the audit/log accordingly.
    const connecting = conversation.status === 'connecting';

    // Tour-history milestone (tour-detail-page 1a): a tours#<tourId> audit row
    // carrying the opened thread id. Best-effort: a failed write must never fail
    // the 201. IDs only. `connecting` distinguishes a deferred-open
    // (connect-when-ready) group.
    try {
      await audit.append(`tours#${tourId}`, 'tour_group_opened', {
        tourId,
        conversationId: conversation.conversationId,
        connecting,
        ...(actor !== undefined && { actor }),
      });
    } catch (err) {
      log.error({ err, tourId }, 'tour_group audit failed (best-effort)');
    }

    // ...and a person milestone on the feed of everyone WHO IS IN THE GROUP.
    // This one is roster-driven, NOT dual-party (lib/personEvents explains the
    // split): "Group text opened" asserts membership of this conversation, so
    // it follows `members` - the roster we just provisioned - the same way
    // added_to_group_text follows the member it names. Auto-resolved rosters
    // ARE [tenant, unit landlord], so the founder flow pins exactly those two;
    // an explicit roster (a caseworker standing in for the tenant, a PM for the
    // owner) pins who is actually there, and no absent tour party. Kept OUTSIDE
    // recordTourEvent because the property (units#) Activity card deliberately
    // carries no row for it - the tour's own trail already does. The pin fires
    // even on the `connecting` path (no pool number yet): the route has no
    // status gate and the tour Activity card already shows it, so this is
    // parity, not a new claim. Best-effort, like every write above.
    await recordRosterMilestone(
      { activityEvents, log },
      {
        members,
        type: 'tour_group_opened',
        label: 'Group text opened',
        refType: 'tour',
        refId: tourId,
      },
    );

    // Live tour-page refresh (tour-detail-page 1a): ID + status only (no PII).
    events.emit('tour.updated', { tourId, status: updatedTour.status });

    log.info(
      { tourId, conversationId: conversation.conversationId, memberCount: members.length, connecting },
      connecting ? 'tour relay group provisioned (connecting - awaiting number)' : 'tour relay group provisioned',
    );
    res.status(201).json({ tour: updatedTour, conversation });
  });

  return router;
}
