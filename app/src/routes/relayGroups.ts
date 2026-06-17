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
// Pool numbers: create provisions one (poolNumbers service); closing releases
// it to quarantine; reopening provisions a fresh one. The intro message is
// throttle-sent via an immediate relay.intro job (naming everyone connected).
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
import { provisionRelayGroup } from '../services/relayProvisioning.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { type ContactItem, createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  type ConversationItem,
  type ConversationParticipant,
  createConversationsRepo,
  type ConversationsRepo,
  RosterConflictError,
} from '../repos/conversationsRepo.js';
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
  events?: EventBus;
}

/** Resolved display name from a contact's firstName/lastName, or undefined. */
function nameFromContact(contact: ContactItem | undefined): string | undefined {
  if (!contact) return undefined;
  const first = typeof contact.firstName === 'string' ? contact.firstName : '';
  const last = typeof contact.lastName === 'string' ? contact.lastName : '';
  const joined = `${first} ${last}`.trim();
  return joined.length > 0 ? joined : undefined;
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

  const router = Router();

  /** Resolve a member's display name: explicit > contact-derived > undefined. */
  async function resolveMemberName(member: ConversationParticipant): Promise<ConversationParticipant> {
    if (member.name !== undefined) return member;
    if (member.contactId && member.contactId.length > 0) {
      const contact = await contacts.getById(member.contactId);
      const name = nameFromContact(contact);
      if (name !== undefined) return { ...member, name };
    }
    return member;
  }

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
      members.push(await resolveMemberName(parsed));
    }

    // Provision via the shared primitive (provision pool → create relay → assign
    // → audit → intro → emit). A standalone (no-case) relay — the test scaffold;
    // the product path is POST /api/cases/:caseId/relay. Typed refusals map to
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
    const member = await resolveMemberName(parsed);
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
      // FIX 1 — CLOSE: clear pool_number FIRST (atomic status='closed' + REMOVE
      // pool_number, conditional on status='open'), THEN release the captured
      // number. Clearing first means an inbound arriving in the window no
      // longer resolves via getByPoolNumber() (the sparse byPoolNumber GSI
      // drops it the instant the attribute is removed), so it can never fan
      // out a closed thread. The release runs AFTER, and only if THIS call won
      // the close — a concurrent/duplicate close fails the precondition and we
      // no-op (idempotent), skipping the release so we never double-quarantine.
      const oldPoolNumber = conversation.pool_number;
      try {
        updated = await conversations.setRelayStatus(conversationId, 'closed', null, 'open');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Already closed (concurrent/duplicate close) — idempotent no-op.
          log.info({ conversationId }, 'relay close: already closed — idempotent no-op');
          res.json({ conversation });
          return;
        }
        throw err;
      }
      if (typeof oldPoolNumber === 'string' && oldPoolNumber.length > 0) {
        try {
          await poolNumbers.release(oldPoolNumber);
        } catch (err) {
          log.error({ err, conversationId }, 'relay close: pool number release failed — closed anyway');
        }
      }
      await audit.append(`conversations#${conversationId}`, 'relay_group_closed', {
        actor,
      });
    } else {
      // FIX 1 — REOPEN: ALWAYS provision a FRESH number; NEVER reuse the
      // conversation's stale pool_number (the old one is in quarantine — reusing
      // it is the collision bug). Then flip status='open' conditional on
      // status='closed'. If that condition fails (already open / concurrent
      // reopen), release the freshly-provisioned number back so it never leaks.
      let poolNumber: string;
      try {
        const provisioned = await poolNumbers.provisionForPlacement(conversationId);
        poolNumber = provisioned.poolNumber;
      } catch (err) {
        // Kill-switch refusal (M1.7): reopen needs a fresh number but live
        // provisioning is off — refuse cleanly (no purchase). Stable 503 code +
        // actionable message; audit the refusal (actor + reason, no PII).
        if (err instanceof RelayProvisioningDisabledError) {
          log.warn({ err: { name: err.name }, conversationId, actor }, 'relay reopen: number provisioning disabled');
          await audit.append(`conversations#${conversationId}`, 'relay_provisioning_disabled', {
            actor,
            reason: 'reopen',
          });
          res
            .status(503)
            .json({ error: 'relay_provisioning_disabled', message: err.message });
          return;
        }
        if (err instanceof VoiceCapabilityError) {
          res.status(503).json({ error: 'pool_number_unavailable' });
          return;
        }
        throw err;
      }
      try {
        updated = await conversations.setRelayStatus(conversationId, 'open', poolNumber, 'closed');
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Already open (concurrent/duplicate reopen) — release the number we
          // just provisioned so it isn't leaked, then idempotent no-op.
          try {
            await poolNumbers.release(poolNumber);
          } catch (releaseErr) {
            log.error({ err: releaseErr, conversationId }, 'relay reopen: releasing the unused fresh number failed');
          }
          log.info({ conversationId }, 'relay reopen: already open — released fresh number, idempotent no-op');
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
