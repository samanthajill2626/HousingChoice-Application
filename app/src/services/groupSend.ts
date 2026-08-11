// Group send service - a staff reply into a NATIVE carrier group text
// (group-texting spec 6.2). Deliberately NOT `sendMessage`, which is
// structurally 1:1: it texts a single `participant_phone` and refuses the WHOLE
// send on one contact's opt-out. A group has N handsets, the carrier fans out
// for us, and a suppressed member is filtered per-recipient BY TWILIO - so the
// shapes do not fit and forcing them together would break both.
//
// Order of business, and the reasons the order is not arbitrary:
//   1. the thread is a group text with a roster we can actually address;
//   2. > 9 members  -> refuse BEFORE any contact read (it is a property of the
//      thread, not of anyone in it, and reading nine contacts to report a cap
//      is wasted work and a misleading error);
//   3. any member's contact soft-DELETED -> refuse, naming them (parity with
//      sendMessage's fence; deletion means "unreachable until restored");
//   4. any member holding NEITHER `consent_method` NOR `group_participation_at`
//      -> refuse, naming them. Defense in depth: every creation path stamps the
//      basis, so this should be unreachable;
//   5. no rail -> ensureGroupRail INLINE (the send-time backstop of spec 6.1).
//
// Suppressed members are NOT excluded app-side (spec 4.4): Twilio drops them
// per-recipient with a 21610 receipt, which is what records the suppression.
// Excluding them here would silently change who is in the group text.
//
// SEND-INTENT is documented PARITY with every existing send path: no
// exactly-once guarantee exists anywhere in this app (a lost HTTP response plus
// a staff re-click duplicates on 1:1, relay and broadcast alike). Filed as
// `docs/issues/exactly-once-send-intent`, out of scope here.
//
// PII (doc 9): log lines carry ids, counts and codes - never a body, never a
// phone. Refusal MESSAGES name a member by display name because they are shown
// to the staff member who already sees the roster on screen.
import { mergeContext } from '../lib/context.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import {
  createGroupConversationsAdapter,
  GroupConversationsUnavailableError,
  type GroupConversationsPort,
} from '../adapters/groupConversations.js';
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../adapters/messaging.js';
import { createAuditRepo, type AuditRepo } from '../repos/auditRepo.js';
import { createContactsRepo, isDeleted, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  buildGroupSendDueRow,
  buildTsMsgId,
  createMessagesRepo,
  GROUP_DUE_CLEANUP_MS,
  GROUP_SEND_STALENESS_MS,
  type DeliveryStatus,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import { groupMemberKey } from './groupMembers.js';
import { createGroupReceiptsService, type GroupReceiptsService } from './groupReceipts.js';
import { createGroupRailService, hasActiveGroupRail, type GroupRailEnsurer } from './groupRail.js';
import { ConversationNotFoundError, SendRefusedError, SmsSendingDisabledError } from './sendMessage.js';

/**
 * Max OUTSIDE members one group send can address. Twilio documents 10
 * participants per group conversation and our projected business number
 * consumes one. Mirrors the composer's `MAX_SENDABLE_MEMBERS` - if these two
 * ever drift, staff get a send button that produces a 409.
 */
export const MAX_SENDABLE_GROUP_MEMBERS = 9;

// --- Typed refusals (the route maps every one of these) --------------------

/** A non-group thread handed to the group send path. Defense in depth. */
export class NotAGroupTextError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} is not a group_text - use the 1:1 or relay send path`, 'not_a_group_text');
  }
}

/** A group thread with no roster cannot be addressed at all. */
export class GroupRosterEmptyError extends SendRefusedError {
  constructor(conversationId: string) {
    super(`group text ${conversationId} has no members to send to`, 'group_roster_empty');
  }
}

export class GroupTooManyMembersError extends SendRefusedError {
  constructor(conversationId: string, memberCount: number) {
    super(
      `group text ${conversationId} has ${memberCount} members, more than the ${MAX_SENDABLE_GROUP_MEMBERS} a group send can reach - reply one to one`,
      'group_too_many_members',
    );
  }
}

export class GroupMemberDeletedError extends SendRefusedError {
  constructor(conversationId: string, memberLabel: string) {
    super(
      `${memberLabel} is a deleted contact - restore them, or reply one to one (group text ${conversationId})`,
      'group_member_deleted',
    );
  }
}

export class GroupMemberNoConsentError extends SendRefusedError {
  constructor(conversationId: string, memberLabel: string) {
    super(
      `${memberLabel} has no recorded SMS consent basis - group send refused (group text ${conversationId})`,
      'group_member_no_consent',
    );
  }
}

/** No Conversations rail could be established, so there is nowhere to post. */
export class GroupRailUnavailableError extends SendRefusedError {
  constructor(conversationId: string, reason: string) {
    super(
      `group text ${conversationId} has no usable Conversations rail: ${reason}`,
      'group_rail_unavailable',
    );
  }
}

// --- Service ----------------------------------------------------------------

export interface GroupSendInput {
  conversationId: string;
  body: string;
  /** Persisted + audited. Group v1 has no automated senders, so this is human. */
  author?: 'teammate' | 'ai';
  /** The signed-in user, for the audit trail. */
  actorUserId?: string;
}

export interface GroupSendOutcome {
  conversationId: string;
  providerSid: string;
  tsMsgId: string;
  status: DeliveryStatus;
}

export interface GroupSendServiceDeps {
  config?: AppConfig;
  logger?: Logger;
  groupConversations?: GroupConversationsPort;
  // Narrow Picks so a test fake is four functions, not a whole repo.
  conversationsRepo?: Pick<ConversationsRepo, 'getById' | 'touchLastActivity'>;
  messagesRepo?: Pick<MessagesRepo, 'append'>;
  contactsRepo?: Pick<ContactsRepo, 'findByPhone'>;
  auditRepo?: Pick<AuditRepo, 'append'>;
  events?: EventBus;
  /** The ONE authoritative rail path (T6.1). Defaults to the real service. */
  rail?: GroupRailEnsurer;
  /** Drains receipts that beat this send's own append (spec 15.2a). */
  receipts?: GroupReceiptsService;
  /** Clock seam (the staleness deadline). */
  now?: () => Date;
}

export type GroupSendService = (input: GroupSendInput) => Promise<GroupSendOutcome>;

/** A member's display for a refusal a human reads: name, else the raw number. */
function memberLabel(member: ConversationParticipant): string {
  const name = member.name?.trim();
  return name !== undefined && name.length > 0 ? name : member.phone;
}

export function createGroupSendService(deps: GroupSendServiceDeps = {}): GroupSendService {
  const config = deps.config ?? loadConfig();
  const log = deps.logger ?? defaultLogger;
  const port =
    deps.groupConversations ??
    createGroupConversationsAdapter({ config, ...(deps.logger !== undefined && { logger: deps.logger }) });
  const conversations =
    deps.conversationsRepo ?? createConversationsRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const messages =
    deps.messagesRepo ?? createMessagesRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const contacts =
    deps.contactsRepo ?? createContactsRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const audit = deps.auditRepo ?? createAuditRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const events = deps.events ?? appEvents;
  // T6.6(b): the send-time BACKSTOP is live. Eager creation at detection and
  // migration is the normal path; this covers the thread that slipped through -
  // and it is the same ensureGroupRail those two call, never a second create.
  const rail =
    deps.rail ??
    createGroupRailService({
      config,
      ...(deps.logger !== undefined && { logger: deps.logger }),
    });
  const receipts =
    deps.receipts ??
    createGroupReceiptsService({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const now = deps.now ?? ((): Date => new Date());

  return async function groupSend(input) {
    const { conversationId, body, author = 'teammate', actorUserId } = input;
    mergeContext({ conversationId });

    // (1) The thread.
    const conversation = await conversations.getById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);
    if (conversation.type !== 'group_text') throw new NotAGroupTextError(conversationId);

    const members = conversation.participants ?? [];
    if (members.length === 0) throw new GroupRosterEmptyError(conversationId);

    // (2) The cap - a property of the THREAD, checked before any member read.
    if (members.length > MAX_SENDABLE_GROUP_MEMBERS) {
      log.warn(
        { conversationId, memberCount: members.length },
        'group send refused: roster is larger than a group conversation can address',
      );
      throw new GroupTooManyMembersError(conversationId, members.length);
    }

    // (3)+(4) One read per member, then the two fences in order. Both are
    // whole-send refusals on purpose: a group text is one message to one thread,
    // so there is no "send to the others" that leaves the roster intact.
    const resolved = await Promise.all(
      members.map(async (member) => ({ member, contact: await contacts.findByPhone(member.phone) })),
    );
    for (const { member, contact } of resolved) {
      if (contact !== undefined && isDeleted(contact)) {
        log.warn(
          { conversationId, contactId: contact.contactId },
          'group send refused: a member contact is soft-deleted',
        );
        throw new GroupMemberDeletedError(conversationId, memberLabel(member));
      }
    }
    for (const { member, contact } of resolved) {
      // The group basis is `group_participation_at` OR an ordinary
      // `consent_method` (hasSmsConsent). A member with NO contact record has
      // neither - absence of a basis is not a basis.
      const hasBasis =
        contact !== undefined &&
        (hasSmsConsent(contact) || typeof contact.group_participation_at === 'string');
      if (!hasBasis) {
        log.warn(
          { conversationId, contactId: contact?.contactId },
          'group send refused: a member has no recorded SMS consent basis',
        );
        throw new GroupMemberNoConsentError(conversationId, memberLabel(member));
      }
    }

    // (5) The rail. Send-time creation is the BACKSTOP (spec 6.1): eager
    // creation at detection/migration is the normal path, and this covers the
    // thread that slipped through.
    let conversationSid = conversation.twilio_conversation_sid;
    let participantMap = conversation.twilio_participant_map ?? {};
    if (!hasActiveGroupRail(conversation)) {
      const ensured = await rail.ensureGroupRail({ conversationId, members });
      if (ensured.twilioConversationSid === undefined) {
        log.warn(
          { conversationId, railStatus: ensured.status },
          'group send refused: no Conversations rail could be established',
        );
        throw new GroupRailUnavailableError(conversationId, ensured.reason ?? ensured.status);
      }
      conversationSid = ensured.twilioConversationSid;
      participantMap = ensured.participantMap ?? {};
    }

    // The rail was built with the business number as its PROJECTED address, and
    // that same number is the only valid Author. Unset, there is nothing to post
    // as - refuse rather than let Twilio attribute the message to `system`.
    const businessNumber = config.businessPhoneNumber;
    if (businessNumber === undefined || businessNumber.length === 0) {
      log.error(
        { conversationId },
        'group send refused: BUSINESS_PHONE_NUMBER is unset, so the rail has no author to post as',
      );
      throw new GroupRailUnavailableError(conversationId, 'BUSINESS_PHONE_NUMBER is not configured');
    }

    // (6) The post. The adapter owns the A2P kill switch (spec invariant 13.7);
    // both of its typed failures become SendRefusedErrors here, because the send
    // route maps ONLY that family - an untranslated throw would 500 and tell
    // staff nothing.
    let posted;
    try {
      posted = await port.postGroupMessage({
        conversationSid: conversationSid as string,
        author: businessNumber,
        body,
      });
    } catch (err) {
      if (err instanceof AdapterSmsSendingDisabledError) throw new SmsSendingDisabledError();
      if (err instanceof GroupConversationsUnavailableError) {
        throw new GroupRailUnavailableError(conversationId, err.message);
      }
      throw err;
    }

    // (7) Persist. ONE transactional append carries three things that must not
    // be able to exist without each other (worklist A13):
    //   - the message row with the parent delivery map PRE-SEEDED per member
    //     (setRecipientDelivery is child-only and cannot seed a parent, so a
    //     receipt arriving before a seed would hit a ValidationException);
    //   - the rail SNAPSHOT, so a late receipt stays mappable even after the
    //     rail is recreated with fresh MBxx values;
    //   - the staleness DUE ROW, which after spec 16.2 is the ONLY detector of
    //     a dead receipts webhook. Enqueuing it after the append would leave a
    //     window where a send exists with nothing watching it.
    const deliveryRecipients: Record<string, RelayRecipientDelivery> = {};
    for (const member of members) deliveryRecipients[groupMemberKey(member.phone)] = { status: 'queued' };

    const at = now();
    const deadlineAt = new Date(at.getTime() + GROUP_SEND_STALENESS_MS).toISOString();
    // The EXPORTED builder, never a hand-rolled copy of it: this back-pointer is
    // what the staleness sweep resolves the message by, and a drifted key would
    // make every check return `missing`, count as cleared, and report a dead
    // receipts webhook as healthy forever.
    const tsMsgIdForDue = buildTsMsgId(posted.dateCreated, posted.messageSid);
    const appended = await messages.append({
      conversationId,
      providerSid: posted.messageSid,
      providerTs: posted.dateCreated,
      type: 'sms',
      direction: 'outbound',
      author,
      body,
      deliveryStatus: 'queued',
      deliveryRecipients,
      groupRailSnapshot: { conversationSid: conversationSid as string, participantMap },
      dueRow: buildGroupSendDueRow({
        conversationId,
        tsMsgId: tsMsgIdForDue,
        providerSid: posted.messageSid,
        deadlineAt,
        expiresAt: Math.floor((at.getTime() + GROUP_DUE_CLEANUP_MS) / 1000),
      }),
    });

    // (7b) Drain any receipt that beat the append. Twilio can deliver an
    // `onDeliveryUpdated` for this IMxx before the transaction above commits,
    // and such a receipt parks itself rather than being dropped - this is where
    // it gets applied. Best-effort: a drain failure must not fail a send that
    // already left, and the receipt is still parked for the next attempt.
    try {
      await receipts.drainParked(posted.messageSid);
    } catch (err) {
      log.error(
        { err, conversationId, providerSid: posted.messageSid },
        'group send: draining parked delivery receipts failed (the send itself succeeded)',
      );
    }

    // (8) Inbox touch + audit trail (ids only, never the body).
    const touched = await conversations.touchLastActivity(conversationId, body, posted.dateCreated);
    await audit.append(`conversations#${conversationId}`, 'message_sent', {
      providerSid: posted.messageSid,
      automated: false,
      author,
      memberCount: members.length,
      ...(actorUserId !== undefined && { actor: actorUserId }),
    });

    events.emit('message.persisted', {
      conversationId,
      tsMsgId: appended.tsMsgId,
      direction: 'outbound',
      deliveryStatus: 'queued',
    });
    events.emit('conversation.updated', toConversationUpdatedEvent(touched));

    log.info(
      {
        conversationId,
        providerSid: posted.messageSid,
        memberCount: members.length,
        bodyLength: body.length,
      },
      'group text sent',
    );

    return {
      conversationId,
      providerSid: posted.messageSid,
      tsMsgId: appended.tsMsgId,
      status: 'queued',
    };
  };
}
