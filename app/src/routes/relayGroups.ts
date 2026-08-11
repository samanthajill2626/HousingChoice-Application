// Relay-group management router (M1.7) — mounted under /api, behind requireAuth
// via the /api mount (app.ts). VAs run relay groups day-to-day, so NO admin
// gate (same posture as contacts/units).
//
//   POST   /api/relay-groups                     { members:[{contactId?,phone,name?}] } → 201 { conversation }
//   GET    /api/conversations/:id/members        → { members }
//   POST   /api/conversations/:id/members        { phone, contactId?, name? }           → { members }
//   DELETE /api/conversations/:id/members/:phone  → { members }
//   PATCH  /api/conversations/:id/close          { closed: boolean }                    → { conversation }
//
// Pool numbers: create provisions one (poolNumbers service). Closing KEEPS the
// number (burn-multiplexing: a closed group stays resolvable so late texts
// intercept to the sender's 1:1); reopening reuses the same number. The intro
// message is throttle-sent via an immediate relay.intro job (naming everyone).
//
// PII (doc §9): responses carry rosters/numbers to the authenticated client;
// LOG LINES are IDs/counts only.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { Router } from 'express';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { mergeContext } from '../lib/context.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import {
  VoiceCapabilityError,
  createMessagingAdapter,
  type MessagingAdapter,
} from '../adapters/messaging.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { createMessagesRepo, type MessagesRepo } from '../repos/messagesRepo.js';
import { createSettingsRepo, type SettingsRepo } from '../repos/settingsRepo.js';
import { provisionRelayGroup } from '../services/relayProvisioning.js';
import { sendRelayAnnouncement } from '../services/relayAnnouncements.js';
import {
  addMemberToRelay,
  parseRelayMember,
  removeMemberFromRelay,
  resolveMemberName,
  type RelayMemberDeps,
} from '../services/relayMembers.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  CLOSE_NAG_INTERVAL_MS,
  type ConversationItem,
  type ConversationParticipant,
  createConversationsRepo,
  type ConversationsRepo,
  getOwner,
} from '../repos/conversationsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import {
  createTourRemindersRepo,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { resolveMessage, resolveWithSettings } from '../messages/index.js';
import {
  composeTourReminderBody,
  UncomposableReminderError,
} from '../messages/tourCopy.js';
import {
  flushComposeFailTally,
  newComposeFailTally,
  recordComposeFail,
} from '../lib/composeFailTally.js';
import { createUnitsRepo, type UnitsRepo } from '../repos/unitsRepo.js';
import type { Address } from '../lib/address.js';
import { readQuietHoursWindow } from '../jobs/tourReminders.js';
import {
  createPoolNumbersService,
  RelayProvisioningDisabledError,
  type PoolNumbersService,
} from '../services/poolNumbers.js';
import {
  createActivityEventsRepo,
  type ActivityEventsRepo,
} from '../repos/activityEventsRepo.js';

export interface RelayGroupsRouterDeps {
  config?: AppConfig;
  logger?: Logger;
  conversationsRepo?: ConversationsRepo;
  contactsRepo?: ContactsRepo;
  auditRepo?: AuditRepo;
  poolNumbersService?: PoolNumbersService;
  /** Close sends the relay.group_closed final message via sendRelayAnnouncement
   *  (same wiring as the relay.intro chain): it persists the announcement + sends
   *  one leg per member FROM the pool number. */
  messagesRepo?: MessagesRepo;
  adapter?: MessagingAdapter;
  /** OrgSettings source for the operator-overridable close copy (resolveWithSettings). */
  settingsRepo?: SettingsRepo;
  /** BE2/C2: emit added_to_group_text / removed_from_group_text milestones. */
  activityEventsRepo?: ActivityEventsRepo;
  /** The group thread's "Upcoming" bucket (GET /conversations/:id/scheduled):
   *  resolve the owner tour + its not-yet-sent reminder rungs. */
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
  /** The owner tour's unit address, for the SAME composed reminder copy the
   *  send path and the other preview surfaces build. */
  unitsRepo?: UnitsRepo;
  events?: EventBus;
}

// nameFromContact / resolveMemberName / parseRelayMember now live in
// services/relayMembers.ts (contact-rosters Task 10) next to the member
// add/remove implementation they belong to - one home, no import cycle back
// into this router.

export function createRelayGroupsRouter(deps: RelayGroupsRouterDeps = {}): Router {
  const log = deps.logger ?? defaultLogger;
  const config = deps.config ?? loadConfig();
  const conversations = deps.conversationsRepo ?? createConversationsRepo({ logger: deps.logger });
  const contacts = deps.contactsRepo ?? createContactsRepo({ logger: deps.logger });
  const audit = deps.auditRepo ?? createAuditRepo({ logger: deps.logger });
  const activityEvents =
    deps.activityEventsRepo ?? createActivityEventsRepo({ logger: deps.logger });
  const events = deps.events ?? appEvents;
  const poolNumbers =
    deps.poolNumbersService ?? createPoolNumbersService({ config, logger: deps.logger });
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });
  const adapter = deps.adapter ?? createMessagingAdapter({ config, logger: deps.logger });
  const settings = deps.settingsRepo ?? createSettingsRepo({ logger: deps.logger });
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const tourReminders = deps.tourRemindersRepo ?? createTourRemindersRepo({ logger: deps.logger });
  const units = deps.unitsRepo ?? createUnitsRepo({ logger: deps.logger });
  // Everything the shared member add/remove implementation touches
  // (services/relayMembers) - built once from this router's resolved repos.
  const memberDeps: RelayMemberDeps = {
    conversations,
    contacts,
    audit,
    activityEvents,
    poolNumbers,
    events,
    log,
  };

  const router = Router();

  // GET /api/conversations/:id/scheduled — the group thread's "Upcoming"
  // bucket (scheduled-message-visibility parity, founder ask 2026-07-14): the
  // not-yet-sent tour-reminder rungs that WILL route to this masked group,
  // in the SAME TimelineScheduled wire shape the contact timeline ships, so
  // the shared <Timeline> renders them identically. Routing mirrors the
  // poller (jobs/tourReminders.ts) exactly: rungs land in the group only when
  // the owner tour is landlord_led/pm_team AND the group is usable (open +
  // pool number + roster); otherwise they fall back to the tenant 1:1 and
  // surface on the CONTACT timeline instead — never both. A non-relay
  // conversation gets an EMPTY bucket (200, unlike the siblings' 404): its
  // upcoming lives on the contact timeline, and the shared thread hook can
  // call this for every conversation without a special case.
  // Suppression annotations are deliberately absent: member-level opt-out
  // suppresses individual LEGS at send time, never the group send itself.
  router.get('/conversations/:conversationId/scheduled', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const conversation = await conversations.getById(conversationId);
    if (!conversation) {
      res.status(404).json({ error: 'conversation_not_found' });
      return;
    }
    const owner = conversation.type === 'relay_group' ? getOwner(conversation) : { type: null };
    const groupUsable =
      conversation.status !== 'closed' &&
      typeof conversation.pool_number === 'string' &&
      conversation.pool_number.length > 0 &&
      (conversation.participants ?? []).length > 0;
    if (owner.type !== 'tour' || !groupUsable) {
      res.json({ scheduled: [] });
      return;
    }
    const tour = await tours.get(owner.id);
    if (!tour || tour.groupThreadId !== conversationId || tour.tourType === 'self_guided') {
      res.json({ scheduled: [] });
      return;
    }
    const rows = await tourReminders.listByTour(tour.tourId);
    // The composing inputs, read ONCE per request: the ORG zone (through
    // readQuietHoursWindow, never settings.timezone - spec D8) and the owner
    // tour's unit address. A failed unit read composes without an address
    // rather than failing the bucket.
    const window = await readQuietHoursWindow(settings, log);
    let address: Address | string | undefined;
    try {
      address = (await units.getById(tour.unitId))?.address;
    } catch (err) {
      log.warn(
        { err, tourId: tour.tourId },
        'group scheduled bucket: unit read failed - composing without an address',
      );
    }
    const composeFails = newComposeFailTally();
    const scheduled = rows
      .filter(
        (r) => r.sentAt === undefined && r.canceledAt === undefined && r.skippedAt === undefined,
      )
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
      .map((row) => ({
        kind: 'scheduled' as const,
        id: `sched#tour_reminder#${row.reminderId}`,
        at: row.dueAt,
        source: 'tour_reminder' as const,
        reminderKind: row.kind,
        // Composed through the ONE composer, exactly like the send path. These
        // rungs are pending-only (the filter above), so there is no sentBody to
        // prefer. READ-PATH CONTAINMENT (spec F1): a tour with no usable
        // scheduledAt yields body: '' instead of 500ing the whole bucket.
        // DUPLICATED SHAPE (3 copies, keep in sync) - twins in
        // routes/tourReminders.ts (bodyFor) and routes/contactTimeline.ts
        // (tourReminderBodyOrEmpty). See the note on bodyFor.
        body: ((): string => {
          try {
            return composeTourReminderBody({
              kind: row.kind,
              scheduledAt: tour.scheduledAt ?? '',
              timezone: window.timezone,
              ...(address !== undefined && { address }),
            });
          } catch (err) {
            if (err instanceof UncomposableReminderError) {
              // RECORD, do not warn - this is inside a per-rung map on a thread
              // view that refetches on every SSE burst. Flushed once below.
              recordComposeFail(composeFails, row, tour);
              return '';
            }
            throw err;
          }
        })(),
        conversationId,
        refType: 'tour' as const,
        refId: tour.tourId,
      }));
    flushComposeFailTally(composeFails, log, 'group_thread_scheduled');
    // `timezone` is the zone these bodies were composed in (spec D8) - the
    // group thread renders each card's fire time in it, exactly like the
    // contact timeline. The two EMPTY-bucket early returns above omit it: they
    // have no window in hand and no row to render a time for.
    res.json({ scheduled, timezone: window.timezone });
  });

  // POST /api/relay-groups — create a relay group + provision a pool number +
  // send the intro to each member (throttled), return the conversation.
  router.post('/relay-groups', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const body = (req.body ?? {}) as { members?: unknown; tag?: unknown };
    if (!Array.isArray(body.members) || body.members.length === 0) {
      res.status(400).json({ error: 'members (non-empty array) is required' });
      return;
    }
    const tag = typeof body.tag === 'string' && body.tag.length > 0 ? body.tag : undefined;

    const members: ConversationParticipant[] = [];
    const seenPhones = new Set<string>();
    for (const raw of body.members) {
      const parsed = parseRelayMember(raw);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      if (seenPhones.has(parsed.phone)) continue; // de-dupe within the request
      seenPhones.add(parsed.phone);
      members.push(await resolveMemberName(contacts, parsed));
    }

    // Provision via the shared primitive (provision pool → create relay → assign
    // → audit → intro → emit). A standalone (no-placement) relay — the test scaffold;
    // the product path is POST /api/placements/:placementId/relay. Typed refusals map to
    // 503 here with the create-reason refusal audit.
    let conversation;
    try {
      conversation = await provisionRelayGroup(
        { conversationsRepo: conversations, poolNumbersService: poolNumbers, auditRepo: audit, events, logger: log },
        { members, ...(tag !== undefined && { tag }), ...(actor !== undefined && { actor }) },
      );
    } catch (err) {
      // Kill-switch refusal (M1.7): live provisioning is off — no number was (or
      // could be) purchased. Stable 503 + actionable message; audit (actor +
      // reason, no PII).
      if (err instanceof RelayProvisioningDisabledError) {
        log.warn({ err: { name: err.name }, actor }, 'relay group create: number provisioning disabled');
        await audit.append('relay#provisioning', 'relay_provisioning_disabled', {
          actor,
          reason: 'create',
        });
        res.status(503).json({ error: 'relay_provisioning_disabled', message: err.message });
        return;
      }
      if (err instanceof VoiceCapabilityError) {
        log.error({ err: { name: err.name } }, 'relay group create: no voice-capable pool number available');
        res.status(503).json({ error: 'pool_number_unavailable' });
        return;
      }
      throw err;
    }
    res.status(201).json({ conversation });
  });

  // GET /api/conversations/:id/members — the current roster.
  router.get('/conversations/:conversationId/members', async (req, res) => {
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const conversation = await conversations.getById(conversationId);
    // POSITIVE type guard: this router speaks for relay groups ONLY, so a native
    // group text 404s here by design (invariant 13.6). That is exactly why the
    // group thread view reads its roster from the conversation header and its
    // member state from /conversations/:id/group-members, never from this route.
    if (!conversation || conversation.type !== 'relay_group') {
      res.status(404).json({ error: 'relay_group_not_found' });
      return;
    }
    res.json({ members: conversation.participants ?? [] });
  });

  // POST /api/conversations/:id/members - idempotent add. The whole sequence
  // (connecting guard, burn claim, roster write, audit, milestone,
  // announcement, conversation.updated emit) lives in
  // services/relayMembers.addMemberToRelay - the ONE implementation the
  // owner-scoped roster call-through endpoints share.
  //
  // NOTE (contact-rosters spec section 7): STANDALONE relay groups keep this
  // RAW route and DO NOT defer for quiet hours. Deferral is owner-scoped and
  // lives on POST /api/{tours,placements}/:id/roster/live-members, the only add
  // path the dashboard uses for a tour/placement roster - so the deferral
  // machinery has exactly one add path to guard.
  router.post('/conversations/:conversationId/members', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const result = await addMemberToRelay(memberDeps, conversationId, req.body, {
      announce: true,
      ...(actor !== undefined && { actor }),
    });
    if (!result.ok) {
      const { status, error, message } = result.refusal;
      res.status(status).json({ error, ...(message !== undefined && { message }) });
      return;
    }
    res.json({ members: result.members });
  });

  // DELETE /api/conversations/:id/members/:phone - idempotent remove, and
  // SILENT (a removal announces nothing to anyone). Shared implementation:
  // services/relayMembers.removeMemberFromRelay.
  router.delete('/conversations/:conversationId/members/:phone', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    // This URL contract is PHONE-keyed, so the param is validated here and the
    // 400 stays with the route (the service also accepts a contactId or a
    // `phone:<E164>` roster key - forms this route never produces).
    const phone = normalizeToE164(String(req.params['phone'] ?? ''));
    if (phone === undefined) {
      res.status(400).json({ error: 'invalid phone' });
      return;
    }
    const result = await removeMemberFromRelay(memberDeps, conversationId, phone, {
      ...(actor !== undefined && { actor }),
    });
    if (!result.ok) {
      const { status, error, message } = result.refusal;
      res.status(status).json({ error, ...(message !== undefined && { message }) });
      return;
    }
    res.json({ members: result.members });
  });

  // PATCH /api/conversations/:id/close - close / reopen a relay group.
  // Body { closed: boolean }. Close sends the relay.group_closed FINAL message
  // to every member (while still open), then flips status='closed' KEEPING the
  // pool number (burn-multiplexing: a late text still resolves the closed group
  // and intercepts to the sender's 1:1) and clears the Today close-nag. Reopen
  // is a pure status flip - the number never left the record, nothing is
  // re-provisioned.
  router.patch('/conversations/:conversationId/close', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const body = (req.body ?? {}) as { closed?: unknown };
    if (typeof body.closed !== 'boolean') {
      res.status(400).json({ error: 'closed (boolean) is required' });
      return;
    }
    const conversation = await conversations.getById(conversationId);
    if (!conversation || conversation.type !== 'relay_group') {
      res.status(404).json({ error: 'relay_group_not_found' });
      return;
    }

    let updated: ConversationItem;
    if (body.closed) {
      const poolNumber = conversation.pool_number;
      // W3 CLOSE-ANNOUNCE DEDUP CLAIM: atomically win the right to send the ONE
      // relay.group_closed final message (claimCloseAnnounce SETs
      // close_announced_at, conditional on status=open AND the marker absent).
      // Exactly one caller wins under concurrent closes; a retry after a crash
      // between announce and flip sees the marker set and LOSES here, so it skips
      // the already-sent announcement. The (idempotent) status flip below runs
      // for winners AND losers: a loser whose group is already closed no-ops on
      // the conditional flip; a loser mid-crash-retry (still open) completes it.
      // This closes BOTH the concurrent-close double-announce TOCTOU and the
      // crash-between-announce-and-flip retry.
      const announceWon = await conversations.claimCloseAnnounce(conversationId);
      if (announceWon) {
        // (1) FINAL MESSAGE (spec 4.4): announce relay.group_closed to every
        // member while the group is STILL OPEN (the announcement gate refuses a
        // closed group). A send/persist failure LOGS and the close STILL PROCEEDS.
        try {
          const closedBody = await resolveWithSettings(
            'relay.group_closed',
            {},
            { settingsRepo: settings },
          );
          await sendRelayAnnouncement(
            {
              conversationsRepo: conversations,
              messagesRepo: messages,
              contactsRepo: contacts,
              adapter,
              events,
              ...(deps.logger !== undefined && { logger: deps.logger }),
            },
            { conversationId, body: closedBody, kind: 'group_closed' },
          );
        } catch (err) {
          log.error({ err, conversationId }, 'relay close: final announcement failed - closing anyway');
        }
      } else {
        // Lost the claim: a concurrent winner already announced, or this is a
        // crash-retry (marker set, flip not yet done). Skip the announce - the
        // idempotent flip below completes a pending close or no-ops a closed one.
        log.info(
          { conversationId },
          'relay close: announcement already claimed - skipping (idempotent/retry)',
        );
      }
      // (2) Flip status='closed' (conditional on 'open'), KEEPING pool_number so
      // a late text still resolves the group. A concurrent/duplicate close fails
      // the precondition and no-ops (idempotent). The number is NOT released - we
      // only stamp its retirement clock (noteGroupClosed) for the D7 sweep.
      try {
        updated = await conversations.setRelayStatus(conversationId, 'closed', 'open');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Already closed (concurrent/duplicate close) - idempotent no-op. AF-8:
          // re-fetch so the response body carries the ACTUAL (closed) status,
          // not our STALE pre-announce read (taken while it was still open) - a
          // concurrent-close loser must not return a dishonest status:'open' body.
          const fresh = await conversations.getById(conversationId);
          log.info({ conversationId }, 'relay close: already closed - idempotent no-op');
          res.json({ conversation: fresh ?? conversation });
          return;
        }
        throw err;
      }
      // (3) Stamp the retirement clock (best-effort): drives the 180-day D7 sweep.
      if (typeof poolNumber === 'string' && poolNumber.length > 0) {
        try {
          await poolNumbers.noteGroupClosed(poolNumber, new Date().toISOString());
        } catch (err) {
          log.error({ err, conversationId }, 'relay close: noteGroupClosed failed - closed anyway');
        }
      }
      // (4) Clear the Today close-nag (best-effort): a closed group no longer nags.
      try {
        await conversations.setCloseNagNextAt(conversationId, null);
      } catch (err) {
        log.error({ err, conversationId }, 'relay close: clearing close-nag failed - closed anyway');
      }
      await audit.append(`conversations#${conversationId}`, 'relay_group_closed', {
        actor,
      });
    } else {
      // REOPEN: the number never left the record (burn-multiplexing), so reopen
      // is a pure status flip back to 'open' (conditional on 'closed') - nothing
      // is re-provisioned. A concurrent/duplicate reopen fails the precondition
      // and no-ops (idempotent).
      // AF-3: refuse reopen when the pool number was RELEASED by retirement (D7).
      // A pure flip would mint a ZOMBIE open group on a number Twilio no longer
      // routes to us (inbound never arrives; outbound announcements/fan-out send
      // FROM a number we do not own). Read the pool record; a missing or
      // non-active record blocks with an actionable 409.
      const reopenPool = conversation.pool_number;
      if (typeof reopenPool === 'string' && reopenPool.length > 0) {
        const record = await poolNumbers.getRecord(reopenPool);
        if (!record || record.lifecycle_state !== 'active') {
          await audit.append(`conversations#${conversationId}`, 'relay_group_reopen_refused', {
            actor,
            reason: 'pool_number_released',
          });
          log.info({ conversationId }, 'relay reopen refused - pool number released');
          res.status(409).json({
            error: 'pool_number_released',
            message:
              'This relay group cannot be reopened: its number was retired after long ' +
              'inactivity. Start a new relay group instead.',
          });
          return;
        }
      }
      try {
        // W3: the open transition also REMOVEs close_announced_at (folded into
        // setRelayStatus, atomic with the flip) so a FUTURE close of this group
        // re-announces - a separate clear could crash-window into a silent close.
        updated = await conversations.setRelayStatus(conversationId, 'open', 'closed');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.info({ conversationId }, 'relay reopen: already open - idempotent no-op');
          res.json({ conversation });
          return;
        }
        throw err;
      }
      await audit.append(`conversations#${conversationId}`, 'relay_group_reopened', {
        actor,
      });
    }

    events.emit('conversation.updated', toConversationUpdatedEvent(updated));
    log.info({ conversationId, closed: body.closed, actor }, 'relay group close/reopen via api');
    res.json({ conversation: updated });
  });

  // POST /api/conversations/:id/close-nag/defer - "Keep open" from the Today nag
  // or the inline close-ask (D5): restart the 28-day close-nag clock. The
  // interval is FIXED server-side (CLOSE_NAG_INTERVAL_MS) - no client-supplied
  // timestamp (never trust an arbitrary defer target). Audited.
  router.post('/conversations/:conversationId/close-nag/defer', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const conversation = await conversations.getById(conversationId);
    if (!conversation || conversation.type !== 'relay_group') {
      res.status(404).json({ error: 'relay_group_not_found' });
      return;
    }
    // AF-9: a CLOSED group never nags, so deferring a nag onto it is a pointless
    // write (and would resurface if the group were later reopened). No-op - no
    // write, no audit (Today-card race friendly: a close landing just before a
    // Keep-open click must not stamp a stale nag field on the now-closed row).
    if (conversation.status !== 'open') {
      log.info({ conversationId }, 'close-nag defer ignored - group not open');
      res.json({ conversation });
      return;
    }
    const nextAt = new Date(Date.now() + CLOSE_NAG_INTERVAL_MS).toISOString();
    await conversations.setCloseNagNextAt(conversationId, nextAt);
    await audit.append(`conversations#${conversationId}`, 'relay_close_nag_deferred', {
      actor,
    });
    log.info({ conversationId, actor }, 'relay close-nag deferred (+28d) via api');
    const refreshed = await conversations.getById(conversationId);
    res.json({ conversation: refreshed ?? { ...conversation, close_nag_next_at: nextAt } });
  });

  return router;
}
