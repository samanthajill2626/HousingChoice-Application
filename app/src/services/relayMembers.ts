// Relay-group MEMBERSHIP - the ONE implementation of "add a member to a relay
// group" / "remove a member from a relay group" (contact-rosters Task 10).
//
// Extracted VERBATIM from the two routes/relayGroups.ts member routes so the
// standalone relay routes AND the owner-scoped roster call-through endpoints
// (routes/tours.ts, routes/placements.ts) run the SAME sequence: burn claim ->
// roster write -> audit -> milestone -> announcement enqueue -> opt-out clear
// -> conversation.updated emit. A second copy of this sequence is how the burn
// invariant (W1) or a milestone quietly diverges between two surfaces.
//
// The functions REFUSE rather than respond: they return a typed refusal
// (status + error token + optional message) and the route renders it, so the
// relay routes keep their exact wire contract while the roster endpoints can
// re-map or re-word anything they need to.
//
// PII (doc section 9): logs + audit rows carry actor/ids/counts only - never a
// phone number.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { normalizeToE164 } from '../lib/phone.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { RELAY_MEMBER_ADDED_JOB } from '../jobs/relayFanOut.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ContactItem, ContactsRepo } from '../repos/contactsRepo.js';
import {
  type ConversationItem,
  type ConversationParticipant,
  type ConversationsRepo,
  RosterConflictError,
} from '../repos/conversationsRepo.js';
import { relayMemberKey } from '../repos/messagesRepo.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { PoolNumbersService } from './poolNumbers.js';

/** Resolved display name from a contact's firstName/lastName, or undefined. */
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
 *  Best-effort - an unknown contactId passes the member through nameless. */
export async function resolveMemberName(
  contacts: Pick<ContactsRepo, 'getById'>,
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
export function parseRelayMember(raw: unknown): ConversationParticipant | { error: string } {
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

/** Everything the two operations touch. Both routers already hold all of it. */
export interface RelayMemberDeps {
  conversations: ConversationsRepo;
  contacts: ContactsRepo;
  audit: AuditRepo;
  activityEvents: ActivityEventsRepo;
  poolNumbers: PoolNumbersService;
  events: EventBus;
  log: Logger;
}

/** A refusal the caller renders verbatim (the relay routes' exact contract). */
export interface RelayMemberRefusal {
  status: number;
  error: string;
  message?: string;
}

export type RelayMemberResult =
  | {
      ok: true;
      conversation: ConversationItem;
      members: ConversationParticipant[];
      /** false when the call was an idempotent no-op (already/never a member). */
      changed: boolean;
    }
  | { ok: false; refusal: RelayMemberRefusal };

/**
 * Add ONE member to a relay group (idempotent on phone).
 *
 * `announce: false` skips ONLY the relay.member_added announcement - the
 * roster write, the burn claim, the audit row, the milestone and the
 * conversation.updated emit are unchanged. The roster call-through uses it for
 * a CLOSED thread (spec section 7: silent and immediate, never deferred);
 * the standalone relay route always announces.
 */
export async function addMemberToRelay(
  deps: RelayMemberDeps,
  conversationId: string,
  memberInput: unknown,
  opts: { announce: boolean; actor?: string },
): Promise<RelayMemberResult> {
  const { conversations, contacts, audit, activityEvents, poolNumbers, events, log } = deps;
  const actor = opts.actor;
  const conversation = await conversations.getById(conversationId);
  if (!conversation || conversation.type !== 'relay_group') {
    return { ok: false, refusal: { status: 404, error: 'relay_group_not_found' } };
  }
  // D11: a CONNECTING group has NO pool number yet, so a member add would
  // SILENTLY SKIP the burn-claim (the burn gate below is `pool_number` present)
  // - breaking the burn-multiplexing invariant + letting a future group reuse
  // this number for an unburned phone. Refuse member mutations until connected.
  // PII: actor + reason only (never the phone).
  if (conversation.status === 'connecting') {
    await audit.append(`conversations#${conversationId}`, 'relay_member_add_refused', {
      actor,
      reason: 'group_connecting',
    });
    return {
      ok: false,
      refusal: {
        status: 409,
        error: 'group_connecting',
        message:
          'This group text is still connecting to its number. Add members once it is connected.',
      },
    };
  }
  const parsed = parseRelayMember(memberInput);
  if ('error' in parsed) {
    return { ok: false, refusal: { status: 400, error: parsed.error } };
  }
  const member = await resolveMemberName(contacts, parsed);
  // addMember is idempotent on phone - capture whether this member was already
  // on the roster so we only emit added_to_group_text for a REAL add.
  const wasMember = (conversation.participants ?? []).some((p) => p.phone === member.phone);
  // W1 BURN GAP: a NEW member must be BURNED onto the group's pool number
  // BEFORE the roster mutation, or (a) they might already be rostered on
  // another group sharing this number - breaking (To,From) resolution (wrong
  // delivery / privacy leak) - and (b) an unburned add lets a FUTURE group
  // containing this phone legitimately reuse the same number (reuse consults
  // only burned_phones). ever_member_phones records the phones THIS group has
  // burned here, so the rule is:
  //   (1) already a current participant -> unchanged idempotent add (no burn);
  //   (2) already in ever_member_phones -> burned by THIS group already
  //       (remove-then-re-add) -> allowed WITHOUT a new claim;
  //   (3) else burnClaim FIRST - on conflict 409, on success the roster + the
  //       ever_member_phones provenance are written together (addMember).
  // CRASH-ORDERING: burn-then-roster. A crash between the two leaves a
  // burned-but-unrostered phone - the CONSERVATIVE direction (blocks reuse,
  // never mis-routes; consistent with burn-forever). Never roster-then-burn.
  // LEGACY: a pre-W1 group has no ever_member_phones; a new phone is not a
  // current participant, so rule (3) claims it, and addMember then initializes
  // the set from the current roster (their burns belong to this group).
  if (!wasMember) {
    const rawEver = conversation.ever_member_phones;
    const everSet =
      rawEver instanceof Set ? rawEver : Array.isArray(rawEver) ? new Set(rawEver) : undefined;
    const burnedByThisGroup = everSet !== undefined && everSet.has(member.phone);
    const poolNumber = conversation.pool_number;
    if (!burnedByThisGroup && typeof poolNumber === 'string' && poolNumber.length > 0) {
      const burned = await poolNumbers.burnMember(poolNumber, member.phone);
      if (!burned) {
        // PII (doc section 9): actor + reason only - NEVER the phone in the audit/log.
        await audit.append(`conversations#${conversationId}`, 'relay_member_add_refused', {
          actor,
          reason: 'phone_conflict_on_number',
        });
        log.info(
          { conversationId, actor },
          'relay member add refused - phone already burned on this number',
        );
        return {
          ok: false,
          refusal: {
            status: 409,
            error: 'phone_conflict_on_number',
            message:
              'This person already has a group text history on this number. Start a new ' +
              'group text with them instead.',
          },
        };
      }
    }
  }
  let updated: ConversationItem;
  try {
    updated = await conversations.addMember(conversationId, member);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { ok: false, refusal: { status: 404, error: 'relay_group_not_found' } };
    }
    // FIX 3: roster optimistic-concurrency conflict past the retry bound.
    if (err instanceof RosterConflictError) {
      return { ok: false, refusal: { status: 409, error: 'roster_conflict' } };
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
  // thread as a system announcement (relay.memberAdded job -> the intro
  // chain). Best-effort - a failed enqueue must not fail the roster mutation
  // (the member IS on the roster; log + continue).
  if (!wasMember && opts.announce) {
    try {
      await enqueueImmediate(RELAY_MEMBER_ADDED_JOB, {
        relayConversationId: conversationId,
        addedMemberKey: relayMemberKey(member),
      });
    } catch (err) {
      log.error(
        { err, conversationId },
        'relay member add: announcement enqueue failed - member added without a join notice',
      );
    }
  }
  events.emit('conversation.updated', toConversationUpdatedEvent(updated));
  log.info(
    { conversationId, memberCount: (updated.participants ?? []).length, actor },
    'relay member added via api',
  );
  return {
    ok: true,
    conversation: updated,
    members: updated.participants ?? [],
    changed: !wasMember,
  };
}

/**
 * Remove ONE member from a relay group (idempotent), NEVER announcing
 * anything (spec D7: removal is immediate and silent).
 *
 * `memberKey` is the roster payload's key: a `contactId`, a `phone:<E164>`, or
 * a bare E.164 phone (what the standalone relay route's `:phone` param is).
 * A CONTACT-keyed remove resolves to THE PHONE STORED ON THAT PARTICIPANT ROW
 * - never the contact's current phone, which silently no-ops when the number
 * was corrected after they joined (spec section 7).
 */
export async function removeMemberFromRelay(
  deps: RelayMemberDeps,
  conversationId: string,
  memberKey: string,
  opts: { actor?: string } = {},
): Promise<RelayMemberResult> {
  const { conversations, audit, activityEvents, events, log } = deps;
  const actor = opts.actor;
  const conversation = await conversations.getById(conversationId);
  if (!conversation || conversation.type !== 'relay_group') {
    return { ok: false, refusal: { status: 404, error: 'relay_group_not_found' } };
  }
  // D11: refuse roster mutations while CONNECTING (parity with the add guard -
  // the roster is frozen until the group opens on its number).
  if (conversation.status === 'connecting') {
    return {
      ok: false,
      refusal: {
        status: 409,
        error: 'group_connecting',
        message:
          'This group text is still connecting to its number. Remove members once it is connected.',
      },
    };
  }
  const participants = conversation.participants ?? [];
  const phone = resolveRemovalPhone(participants, memberKey);
  if (phone === undefined) {
    return { ok: false, refusal: { status: 404, error: 'member_not_found' } };
  }
  // Capture the member being removed (for the milestone's contactId) BEFORE
  // the mutation - removeMember is idempotent, so a no-op (absent phone)
  // leaves removedMember undefined and we emit nothing.
  const removedMember = participants.find((p) => p.phone === phone);
  let updated: ConversationItem;
  try {
    updated = await conversations.removeMember(conversationId, phone);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return { ok: false, refusal: { status: 404, error: 'relay_group_not_found' } };
    }
    // FIX 3: roster optimistic-concurrency conflict past the retry bound.
    if (err instanceof RosterConflictError) {
      return { ok: false, refusal: { status: 409, error: 'roster_conflict' } };
    }
    throw err;
  }
  await audit.append(`conversations#${conversationId}`, 'relay_member_removed', {
    actor,
  });
  // A2P - resolve the Today opt-out attention item: removing the member clears
  // their relay_opted_out_members entry (the item auto-resolves). Keyed by the
  // SAME relayMemberKey the fan-out used (contactId, else `phone#<E164>`).
  // Best-effort - a failure must not fail the remove.
  if (removedMember !== undefined) {
    const key = relayMemberKey(removedMember);
    try {
      await conversations.clearRelayMemberOptedOut(conversationId, key);
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
  return {
    ok: true,
    conversation: updated,
    members: updated.participants ?? [],
    changed: removedMember !== undefined,
  };
}

/**
 * Which PHONE a `memberKey` removes.
 *
 * - `phone:<E164>` / a bare phone -> that number, present on the roster or not
 *   (the relay route's idempotent-remove contract).
 * - anything else -> a contactId, matched against the participant rows; the
 *   answer is THE ROW'S stored phone. No matching row -> undefined (404).
 */
function resolveRemovalPhone(
  participants: ConversationParticipant[],
  memberKey: string,
): string | undefined {
  const key = memberKey.trim();
  if (key.length === 0) return undefined;
  if (key.startsWith('phone:')) {
    const raw = key.slice('phone:'.length);
    return normalizeToE164(raw) ?? (raw.length > 0 ? raw : undefined);
  }
  const asPhone = normalizeToE164(key);
  if (asPhone !== undefined) return asPhone;
  const row = participants.find((p) => p.contactId === key);
  return row?.phone;
}
