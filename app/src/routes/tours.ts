// Tours router — first-class Tour entity (Tours feature).
// Mounted under /api/tours, behind requireAuth via the /api mount (app.ts).
// VAs schedule and manage tours, so NO admin gate (same posture as contacts).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt?, tourType } → 201 { tour }
//   GET   /api/tours/:tourId                                         → { tour } | 404
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
import { Router } from 'express';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  canReschedule,
  isTourOutcome,
  isTourStatus,
  TOUR_STATUSES,
  TOUR_OUTCOMES,
  type TourOutcome,
  type TourStatus,
} from '../lib/toursModel.js';
import {
  createToursRepo,
  type TourItem,
  type ToursRepo,
  type TourType,
} from '../repos/toursRepo.js';
import { armTourReminders, cancelTourReminders } from '../jobs/tourReminders.js';
import { createTourRemindersRepo, type TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { appEvents, type EventBus } from '../lib/events.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
  type ActivityEventType,
} from '../repos/activityEventsRepo.js';
import { nameFromContact, resolveMemberName } from './relayGroups.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
  type PoolNumbersService,
} from '../services/poolNumbers.js';
import { provisionRelayGroup } from '../services/relayProvisioning.js';
import { VoiceCapabilityError } from '../adapters/messaging.js';
import { normalizeToE164 } from '../lib/phone.js';
import { loadConfig, type AppConfig } from '../lib/config.js';

/** The three valid tour types. */
const TOUR_TYPES: readonly TourType[] = ['self_guided', 'landlord_led', 'pm_team'];
const TOUR_TYPE_SET: ReadonlySet<string> = new Set(TOUR_TYPES);

function isTourType(x: unknown): x is TourType {
  return typeof x === 'string' && TOUR_TYPE_SET.has(x);
}

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

export interface ToursRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
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

  // Best-effort dual-write of a tour lifecycle event to BOTH surfaces: the
  // tenant's contact timeline (activity event) and the property's Activity card
  // (a `units#<unitId>` audit row). Each write is independently guarded — NEITHER
  // may fail the route (state is already persisted). PII-safe log: ids/type only.
  async function recordTourEvent(
    tour: { tenantId: string; unitId: string; tourId: string },
    activityType: ActivityEventType,
    auditType: string,
    label: string,
  ): Promise<void> {
    try {
      await activityEvents.record({
        contactId: tour.tenantId,
        type: activityType,
        label,
        refType: 'tour',
        refId: tour.tourId,
      });
    } catch (err) {
      log.error({ err, tourId: tour.tourId }, `${activityType} milestone record failed (best-effort)`);
    }
    try {
      await audit.append(`units#${tour.unitId}`, auditType, { tourId: tour.tourId });
    } catch (err) {
      log.error({ err, tourId: tour.tourId }, `${auditType} unit audit failed (best-effort)`);
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
      await armTourReminders(tour, getNow(), { tourRemindersRepo: reminders, logger: log });
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
    //     it, and the only ways out are booking (→ scheduled, which requires a
    //     time) or canceling — confirmed/toured/no_show all presuppose a time.
    //   - The only path back to 'scheduled' is via canReschedule() (i.e. from
    //     requested/scheduled/confirmed/canceled/no_show — NOT toured/closed).
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
        // booking step is what advances the tour); confirmed/toured/no_show on
        // a tour that never had a time would break booking semantics — e.g.
        // an unreschedulable 'toured' dead end with no ladder ever armed.
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
    // 'scheduled' in the same update — a fresh time on a dead-but-reschedulable
    // tour must never leave it reading Canceled/No show with a live ladder.
    // (confirmed keeps its status on a bare time change — a reschedule should
    // not demote a confirmed tour.)
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
    // confirmed" at the whole group), and marking 'toured' must cancel the
    // still-pending rungs (a tenant who showed up must never get the
    // no_show_checkin "you may have missed your tour" text).
    const effectiveStatus = (patch['status'] ?? currentStatus) as TourStatus;
    const armable = effectiveStatus === 'scheduled' || effectiveStatus === 'confirmed';
    // Re-arm on a time change, or on an explicit move INTO 'scheduled' (a
    // status-only revival from canceled/no_show uses the stored time — its
    // rungs were canceled and must come back). A status-only 'confirmed' patch
    // does NOT re-arm (it would re-fire the confirmation rung).
    const rearmTrigger = scheduledAtIso !== undefined || patch['status'] === 'scheduled';
    if (armable && rearmTrigger) {
      await cancelTourReminders(tourId, { tourRemindersRepo: reminders, logger: log });
      await armTourReminders(tour, getNow(), { tourRemindersRepo: reminders, logger: log });
    } else if (
      effectiveStatus === 'canceled' ||
      effectiveStatus === 'closed' ||
      effectiveStatus === 'toured'
    ) {
      // Dead or completed: nothing left to remind. (no_show keeps its pending
      // no_show_checkin — the "want to reschedule?" nudge is exactly for it.)
      await cancelTourReminders(tourId, { tourRemindersRepo: reminders, logger: log });
    }

    // Tour lifecycle → tenant timeline + property (unit) audit (WS4). Each
    // surfaced transition dual-writes both surfaces (best-effort, idempotent per
    // REAL transition). We key on `effectiveStatus` (patch['status'] ?? current)
    // — NOT the body-only `newStatus` — so booking/revival auto-advances (which
    // set patch['status']='scheduled' with body newStatus undefined) are caught.
    // Each INTO-status guard is against `currentStatus` (a no-op re-PATCH to the
    // same status never re-emits). PII: ids/type only (never the label) in logs.
    const t = { tenantId: current.tenantId, unitId: current.unitId, tourId };
    // A bare time change on a tour that stays 'scheduled' is a reschedule.
    const wasReschedule =
      scheduledAtIso !== undefined && currentStatus === 'scheduled' && effectiveStatus === 'scheduled';
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
        `Tour outcome · ${newMoveForward === true ? 'moved forward' : 'not a fit'}`,
      );
    }

    log.info({ tourId, fields: Object.keys(patch).length }, 'tour patched via api');
    res.json({ tour });
  });

  /**
   * Auto-resolve the tour's relay roster: [tenant contact, unit's landlord
   * contact] — phones + display names from contacts. Returns a stable,
   * dashboard-consumable detail string when any member is unresolvable (the
   * route maps it to 400 relay_member_unresolvable).
   */
  async function resolveTourMembers(
    tour: TourItem,
  ): Promise<{ members: ConversationParticipant[] } | { unresolvable: string }> {
    const tenant = await contacts.getById(tour.tenantId);
    if (!tenant) return { unresolvable: 'tenant contact not found' };
    const tenantPhone =
      typeof tenant.phone === 'string' && tenant.phone.length > 0
        ? normalizeToE164(tenant.phone)
        : undefined;
    if (tenantPhone === undefined) return { unresolvable: 'tenant contact has no phone' };

    const unit = await units.getById(tour.unitId);
    if (!unit) return { unresolvable: 'unit not found (cannot resolve landlord)' };
    const landlordId =
      typeof unit.landlordId === 'string' && unit.landlordId.length > 0
        ? unit.landlordId
        : undefined;
    if (landlordId === undefined) {
      return { unresolvable: 'unit has no landlord (cannot resolve landlord)' };
    }
    const landlord = await contacts.getById(landlordId);
    if (!landlord) return { unresolvable: 'landlord contact not found' };
    const landlordPhone =
      typeof landlord.phone === 'string' && landlord.phone.length > 0
        ? normalizeToE164(landlord.phone)
        : undefined;
    if (landlordPhone === undefined) return { unresolvable: 'landlord contact has no phone' };

    const tenantName = nameFromContact(tenant);
    const members: ConversationParticipant[] = [
      { phone: tenantPhone, contactId: tour.tenantId, ...(tenantName !== undefined && { name: tenantName }) },
    ];
    // De-dupe on phone (mirrors the explicit path) — a tenant who is somehow
    // also the landlord gets one roster slot.
    if (landlordPhone !== tenantPhone) {
      const landlordName = nameFromContact(landlord);
      members.push({
        phone: landlordPhone,
        contactId: landlordId,
        ...(landlordName !== undefined && { name: landlordName }),
      });
    }
    return { members };
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
    const updatedTour = await tours.patch(tourId, { groupThreadId: conversation.conversationId });

    log.info(
      { tourId, conversationId: conversation.conversationId, memberCount: members.length },
      'tour relay group provisioned',
    );
    res.status(201).json({ tour: updatedTour, conversation });
  });

  return router;
}
