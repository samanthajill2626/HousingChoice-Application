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
import { VoiceCapabilityError } from '../adapters/messaging.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { relayMemberKey } from '../repos/messagesRepo.js';
import { provisionRelayGroup } from '../services/relayProvisioning.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { RELAY_MEMBER_ADDED_JOB } from '../jobs/relayFanOut.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { type ContactItem, createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  type ConversationItem,
  type ConversationParticipant,
  createConversationsRepo,
  type ConversationsRepo,
  getOwner,
  RosterConflictError,
} from '../repos/conversationsRepo.js';
import { createToursRepo, type ToursRepo } from '../repos/toursRepo.js';
import {
  createTourRemindersRepo,
  type TourRemindersRepo,
} from '../repos/tourRemindersRepo.js';
import { resolveMessage } from '../messages/index.js';
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
  /** BE2/C2: emit added_to_group_text / removed_from_group_text milestones. */
  activityEventsRepo?: ActivityEventsRepo;
  /** The group thread's "Upcoming" bucket (GET /conversations/:id/scheduled):
   *  resolve the owner tour + its not-yet-sent reminder rungs. */
  toursRepo?: ToursRepo;
  tourRemindersRepo?: TourRemindersRepo;
  events?: EventBus;
}

/** Resolved display name from a contact's firstName/lastName, or undefined.
 *  Exported for the tour relay route (tours.ts), which auto-resolves rosters. */
export function nameFromContact(contact: ContactItem | undefined): string | undefined {
  if (!contact) return undefined;
  // Part-wise trim BEFORE the join (legacy padded parts must not render an
  // interior gap; new writes arrive trimmed via trimJsonBody).
  const first = typeof contact.firstName === 'string' ? contact.firstName.trim() : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName.trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}

/** Resolve a member's display name: explicit > contact-derived > undefined.
 *  Best-effort — an unknown contactId passes the member through nameless.
 *  Shared with the tour relay route (tours.ts). */
export async function resolveMemberName(
  contacts: ContactsRepo,
  member: ConversationParticipant,
): Promise<ConversationParticipant> {
  if (member.name !== undefined) return member;
  if (member.contactId && member.contactId.length > 0) {
    const contact = await contacts.getById(member.contactId);
    const name = nameFromContact(contact);
    if (name !== undefined) return { ...member, name };
  }
  return member;
}

/** Validate + normalize one member input. Returns the member or an error string. */
function parseMember(raw: unknown): ConversationParticipant | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: 'member must be an object' };
  const m = raw as { phone?: unknown; contactId?: unknown; name?: unknown };
  if (typeof m.phone !== 'string' || m.phone.length === 0) {
    return { error: 'member.phone is required' };
  }
  const phone = normalizeToE164(m.phone);
  if (phone === undefined) return { error: `member.phone is not a valid phone: ${m.phone}` };
  const contactId =
    typeof m.contactId === 'string' && m.contactId.length > 0 ? m.contactId : undefined;
  const name = typeof m.name === 'string' && m.name.trim().length > 0 ? m.name.trim() : undefined;
  return {
    phone,
    contactId: contactId ?? '',
    ...(name !== undefined && { name }),
  };
}

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
  const tours = deps.toursRepo ?? createToursRepo({ logger: deps.logger });
  const tourReminders = deps.tourRemindersRepo ?? createTourRemindersRepo({ logger: deps.logger });

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
        body: resolveMessage(`tour.${row.kind}`),
        conversationId,
        refType: 'tour' as const,
        refId: tour.tourId,
      }));
    res.json({ scheduled });
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
      const parsed = parseMember(raw);
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
    if (!conversation || conversation.type !== 'relay_group') {
      res.status(404).json({ error: 'relay_group_not_found' });
      return;
    }
    res.json({ members: conversation.participants ?? [] });
  });

  // POST /api/conversations/:id/members — idempotent add.
  router.post('/conversations/:conversationId/members', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const conversation = await conversations.getById(conversationId);
    if (!conversation || conversation.type !== 'relay_group') {
      res.status(404).json({ error: 'relay_group_not_found' });
      return;
    }
    const parsed = parseMember(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const member = await resolveMemberName(contacts, parsed);
    // addMember is idempotent on phone — capture whether this member was already
    // on the roster so we only emit added_to_group_text for a REAL add.
    const wasMember = (conversation.participants ?? []).some((p) => p.phone === member.phone);
    let updated: ConversationItem;
    try {
      updated = await conversations.addMember(conversationId, member);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'relay_group_not_found' });
        return;
      }
      // FIX 3: roster optimistic-concurrency conflict past the retry bound.
      if (err instanceof RosterConflictError) {
        res.status(409).json({ error: 'roster_conflict' });
        return;
      }
      throw err;
    }
    await audit.append(`conversations#${conversationId}`, 'relay_member_added', {
      actor,
      contactId: member.contactId || null,
    });
    // BE2/C2: a real member-add is a timeline milestone for THAT member's
    // contact (link-out to the relay conversation). Only for members with a
    // contactId; best-effort (a log failure must not fail the roster mutation).
    if (!wasMember && member.contactId && member.contactId.length > 0) {
      try {
        await activityEvents.record({
          contactId: member.contactId,
          type: 'added_to_group_text',
          label: 'Added to group text',
          refType: 'conversation',
          refId: conversationId,
        });
      } catch (err) {
        log.error({ err, conversationId }, 'relay member add: recording milestone failed');
      }
    }
    // Announce a REAL add to the WHOLE group (founder decision 2026-07-14):
    // the new member's welcome + everyone else's join notice, persisted in the
    // thread as a system announcement (relay.memberAdded job → the intro
    // chain). Best-effort — a failed enqueue must not fail the roster mutation
    // (the member IS on the roster; log + continue).
    if (!wasMember) {
      try {
        await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
          relayConversationId: conversationId,
          addedMemberKey: relayMemberKey(member),
        });
      } catch (err) {
        log.error(
          { err, conversationId },
          'relay member add: announcement enqueue failed — member added without a join notice',
        );
      }
    }
    events.emit('conversation.updated', toConversationUpdatedEvent(updated));
    log.info(
      { conversationId, memberCount: (updated.participants ?? []).length, actor },
      'relay member added via api',
    );
    res.json({ members: updated.participants ?? [] });
  });

  // DELETE /api/conversations/:id/members/:phone — idempotent remove.
  router.delete('/conversations/:conversationId/members/:phone', async (req, res) => {
    const actor = (req as AuthedRequest).user?.userId;
    const { conversationId } = req.params;
    mergeContext({ conversationId });
    const phone = normalizeToE164(String(req.params['phone'] ?? ''));
    if (phone === undefined) {
      res.status(400).json({ error: 'invalid phone' });
      return;
    }
    const conversation = await conversations.getById(conversationId);
    if (!conversation || conversation.type !== 'relay_group') {
      res.status(404).json({ error: 'relay_group_not_found' });
      return;
    }
    // Capture the member being removed (for the milestone's contactId) BEFORE
    // the mutation — removeMember is idempotent, so a no-op (absent phone)
    // leaves removedMember undefined and we emit nothing.
    const removedMember = (conversation.participants ?? []).find((p) => p.phone === phone);
    let updated: ConversationItem;
    try {
      updated = await conversations.removeMember(conversationId, phone);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        res.status(404).json({ error: 'relay_group_not_found' });
        return;
      }
      // FIX 3: roster optimistic-concurrency conflict past the retry bound.
      if (err instanceof RosterConflictError) {
        res.status(409).json({ error: 'roster_conflict' });
        return;
      }
      throw err;
    }
    await audit.append(`conversations#${conversationId}`, 'relay_member_removed', {
      actor,
    });
    // A2P — resolve the Today opt-out attention item: removing the member clears
    // their relay_opted_out_members entry (the item auto-resolves). Keyed by the
    // SAME relayMemberKey the fan-out used (contactId, else `phone#<E164>`).
    // Best-effort — a failure must not fail the remove.
    if (removedMember !== undefined) {
      const memberKey = relayMemberKey(removedMember);
      try {
        await conversations.clearRelayMemberOptedOut(conversationId, memberKey);
      } catch (err) {
        log.error({ err, conversationId }, 'relay member remove: clearing opt-out annotation failed');
      }
    }
    // BE2/C2: a real member-remove is a timeline milestone for THAT member's
    // contact. Only for members with a contactId; best-effort.
    if (removedMember?.contactId && removedMember.contactId.length > 0) {
      try {
        await activityEvents.record({
          contactId: removedMember.contactId,
          type: 'removed_from_group_text',
          label: 'Removed from group text',
          refType: 'conversation',
          refId: conversationId,
        });
      } catch (err) {
        log.error({ err, conversationId }, 'relay member remove: recording milestone failed');
      }
    }
    events.emit('conversation.updated', toConversationUpdatedEvent(updated));
    log.info(
      { conversationId, memberCount: (updated.participants ?? []).length, actor },
      'relay member removed via api',
    );
    res.json({ members: updated.participants ?? [] });
  });

  // PATCH /api/conversations/:id/close — close (release pool number) / reopen
  // (provision a fresh one). Body { closed: boolean }.
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
      // CLOSE: flip status='closed' (conditional on 'open'), KEEPING pool_number
      // so a late text still resolves the group and intercepts to the sender's
      // 1:1 (burn-multiplexing). A concurrent/duplicate close fails the
      // precondition and no-ops (idempotent). The number is NOT released.
      try {
        updated = await conversations.setRelayStatus(conversationId, 'closed', 'open');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Already closed (concurrent/duplicate close) - idempotent no-op.
          log.info({ conversationId }, 'relay close: already closed - idempotent no-op');
          res.json({ conversation });
          return;
        }
        throw err;
      }
      await audit.append(`conversations#${conversationId}`, 'relay_group_closed', {
        actor,
      });
    } else {
      // REOPEN: the number never left the record (burn-multiplexing), so reopen
      // is a pure status flip back to 'open' (conditional on 'closed') - nothing
      // is re-provisioned. A concurrent/duplicate reopen fails the precondition
      // and no-ops (idempotent).
      try {
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

  return router;
}
