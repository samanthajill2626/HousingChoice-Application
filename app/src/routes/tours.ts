// Tours router — first-class Tour entity (Tours feature).
// Mounted under /api/tours, behind requireAuth via the /api mount (app.ts).
// VAs schedule and manage tours, so NO admin gate (same posture as contacts).
//
//   POST  /api/tours  { tenantId, unitId, scheduledAt?, tourType } → 201 { tour }
//   GET   /api/tours/:tourId                                         → { tour } | 404
//   GET   /api/tours?tenantId=&unitId=&from=&to=                     → { tours }
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
  const poolNumbers =
    deps.poolNumbersService ?? createPoolNumbersService({ config, logger: deps.logger });
  const events = deps.events ?? appEvents;
  const getNow = deps.now ?? (() => new Date().toISOString());

  const router = Router();

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
    const tour = await tours.create({
      tenantId: b['tenantId'] as string,
      unitId: b['unitId'] as string,
      tourType: b['tourType'] as TourType,
      ...(scheduledAt !== undefined
        ? { scheduledAt: scheduledAt as string }
        : { status: 'requested' satisfies TourStatus }),
    });

    // Arm the reminder ladder (best-effort side effect) — only once a time exists.
    if (scheduledAt !== undefined) {
      await armTourReminders(tour, getNow(), { tourRemindersRepo: reminders, logger: log });
    }

    log.info({ tourId: tour.tourId, tenantId: tour.tenantId, unitId: tour.unitId }, 'tour created via api');
    res.status(201).json({ tour });
  });

  // GET /api/tours — list tours by tenantId, unitId, or scheduled range (from+to).
  // Priority: tenantId > unitId > from+to (mirrors units.ts filter priority).
  router.get('/', async (req, res) => {
    const tenantId = req.query['tenantId'];
    const unitId = req.query['unitId'];
    const from = req.query['from'];
    const to = req.query['to'];

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
    } else {
      res.status(400).json({
        error: 'one of tenantId, unitId, or from+to is required',
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
    //   - The only path back to 'scheduled' is via canReschedule() (i.e. from
    //     scheduled/confirmed/canceled/no_show — NOT from toured or closed).
    if (newStatus !== undefined) {
      const targetStatus = newStatus as TourStatus;

      if (currentStatus === 'closed') {
        // closed is fully terminal — no transitions allowed.
        res.status(409).json({ error: 'illegal_status_transition', detail: `a closed tour cannot be changed (current: closed, requested: ${targetStatus})` });
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

    // --- Build the patch ---
    // Exit gate: outcome + moveForward → also set convertible.
    const patch: Record<string, unknown> = {};
    if (newScheduledAt !== undefined) patch['scheduledAt'] = newScheduledAt;
    if (newStatus !== undefined) patch['status'] = newStatus;
    // Booking: a scheduledAt patch on a 'requested' tour with no explicit
    // status auto-advances requested → scheduled in the same update.
    if (newScheduledAt !== undefined && newStatus === undefined && currentStatus === 'requested') {
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

    // Reminder side effects after a successful patch.
    if (newScheduledAt !== undefined) {
      // Reschedule: cancel old reminders and re-arm with the new scheduledAt.
      await cancelTourReminders(tourId, { tourRemindersRepo: reminders, logger: log });
      await armTourReminders(tour, getNow(), { tourRemindersRepo: reminders, logger: log });
    } else if (patch['status'] === 'canceled' || patch['status'] === 'closed') {
      // Terminal status: cancel all pending reminders.
      await cancelTourReminders(tourId, { tourRemindersRepo: reminders, logger: log });
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

    // Stamp the groupThreadId back on the tour.
    const updatedTour = await tours.patch(tourId, { groupThreadId: conversation.conversationId });

    log.info(
      { tourId, conversationId: conversation.conversationId, memberCount: members.length },
      'tour relay group provisioned',
    );
    res.status(201).json({ tour: updatedTour, conversation });
  });

  return router;
}
