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
// Suppressed members are NOT excluded app-side (spec 4.4): we post to the whole
// conversation and Twilio decides per recipient. Excluding them here would
// silently change who is in the group text - and a roster change is a NEW thread
// identity by construction (spec 4.1), so it would fork every other member's
// handset thread.
//
// WHAT WE DO INSTEAD, and why (live QA round 2, L3): Twilio does not merely drop
// a suppressed member's copy, it SKIPS THE PARTICIPANT - no leg, no delivery
// attempt, no 21610, and therefore NO DELIVERY RECEIPT, EVER. So a slot seeded
// `queued` for a member we already know is suppressed can never move, and the
// per-send staleness sweep raised a FALSE "receipts silent" ERROR on every send
// to that group. The suppression state is already available through the
// number-scoped seam at this point, so we SEED that member's slot terminal
// (see services/groupDelivery). Labelling, not excluding.
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
import { summarizeError } from '../lib/errors.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { hasSmsConsent } from '../lib/smsCompliance.js';
import { sharedA2pBucket, TokenBucketBusyError, type TokenBucket } from '../lib/tokenBucket.js';
import {
  createGroupConversationsAdapter,
  GroupConversationsAuthorRejectedError,
  GroupConversationsUnavailableError,
  type GroupConversationsPort,
} from '../adapters/groupConversations.js';
import { SmsSendingDisabledError as AdapterSmsSendingDisabledError } from '../adapters/messaging.js';
// The SAME team sentinel every other multi-party writer uses - imported, never
// re-declared, so the dashboard's one attribution rule cannot drift from it.
import { TEAM_SENDER_KEY } from '../jobs/relayFanOut.js';
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
import { deriveGroupDeliveryStatus, suppressedSlot } from './groupDelivery.js';
import { groupMemberKey } from './groupMembers.js';
import { createGroupReceiptsService, type GroupReceiptsService } from './groupReceipts.js';
import {
  createGroupRailService,
  hasActiveGroupRail,
  railAuthorVerified,
  type GroupRailEnsurer,
} from './groupRail.js';
import { readNumberSuppression } from './numberSuppression.js';
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

/**
 * The post failed for a reason that says NOTHING about the rail - a network
 * timeout, a 429, a 5xx (fix wave 2, adversarial 2 / conformance F4). Wave 1
 * translated every such failure into `group_rail_unavailable`, which told staff
 * the thread has no rail when the rail is fine and RETRYING is the right move -
 * the opposite of what a rail refusal conveys. Separate code, retryable status,
 * so the two diagnoses can never be confused again.
 */
export class GroupSendFailedError extends SendRefusedError {
  constructor(conversationId: string, reason: string) {
    super(
      `group text ${conversationId} could not be sent right now: ${reason}`,
      'group_send_failed',
    );
  }
}

/**
 * The A2P meter could not pay this send inside its bound (fix wave 2,
 * adversarial 16). Interactive, so it refuses rather than parking the Express
 * request behind the queue indefinitely. Nothing was spent and nothing was
 * posted - a retry is exactly right.
 */
export class GroupSendBusyError extends SendRefusedError {
  constructor(conversationId: string) {
    super(
      `group text ${conversationId} is waiting on outbound throughput - try again in a moment`,
      'group_send_busy',
    );
  }
}

/**
 * How long an interactive group send may wait on the shared A2P meter before it
 * refuses. Nine members at the shipped 1/sec default is ~8s of legitimate
 * pacing, so the bound has to clear that with room; past it the queue is deep
 * enough that a staff member is better told to try again than left watching a
 * spinner. Well inside any reverse-proxy idle timeout.
 */
export const GROUP_SEND_METER_WAIT_MS = 20_000;

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
  // `findByParticipantPhone` is the READ half of the number-scoped suppression
  // seam (services/numberSuppression) - the same seam the roster chip and the
  // 21610 receipts path use, so the delivery slot and the member chip can never
  // disagree about one handset.
  conversationsRepo?: Pick<
    ConversationsRepo,
    'getById' | 'touchLastActivity' | 'findByParticipantPhone' | 'clearGroupRail'
  >;
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
  /**
   * The shared A2P meter (fix wave 5, adversarial 34). ONE group post becomes
   * up to nine carrier messages, so it draws N tokens for N members - and the
   * draw is now PAID in full rather than clamped to capacity (fix wave 2,
   * adversarial 3). Defaults to the process-wide instance; a test may pass its
   * own (or `null` to opt out entirely).
   *
   * PER-PROCESS, exactly like every other metered path (fix wave 2, conformance
   * F3). In a deployed app/worker split this bucket is the APP's while relay
   * fan-out, broadcasts and missed-call auto-text draw from the WORKER's, so the
   * combined rate is per-task - the meter has always had that property and this
   * does not change it. Only in local/in-process mode is it literally the same
   * instance the jobs use. Do not describe it as one bucket across processes.
   */
  tokenBucket?: Pick<TokenBucket, 'acquire'> | null;
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
  // `undefined` means "use the shared process bucket"; `null` means "no meter"
  // (tests, and any caller that has already metered).
  // A non-positive configured rate means "no A2P pacing in this environment"
  // (the console/local stacks, and every unit suite) - there is no bucket to
  // draw from, and TokenBucket refuses to be built with capacity 0.
  const tokenBucket =
    deps.tokenBucket !== undefined
      ? deps.tokenBucket
      : config.a2pRateLimitPerSec > 0
        ? sharedA2pBucket(config.a2pRateLimitPerSec)
        : null;
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

    // (5) The rail. Send-time creation is the BACKSTOP (spec 6.1): eager
    // creation at detection/migration is the normal path, and this covers the
    // thread that slipped through.
    //
    // AND THE AUTHOR CHECK (prod incident 2026-08-17). A stamped sid whose map
    // covers the roster used to be posted to blind - and 135 of 136 prod rails
    // did not carry the current business number as a participant, so every
    // staff reply was refused with 50513 while inbound kept arriving through
    // the SMS webhook. A rail verified for another (or no) author goes through
    // the ONE ensure path first, which re-reads Twilio, attaches the current
    // number, and re-stamps the row - so the post below is made into a rail
    // that can take it, and the next send skips the check entirely.
    let conversationSid = conversation.twilio_conversation_sid;
    let participantMap = conversation.twilio_participant_map ?? {};
    if (!hasActiveGroupRail(conversation) || !railAuthorVerified(conversation, businessNumber)) {
      if (hasActiveGroupRail(conversation)) {
        log.info(
          { conversationId, event: 'group_rail_author_unverified' },
          'group send: the rail is not verified for the current business number - verifying before the post',
        );
      }
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

    /** One post attempt at a given rail. */
    async function postOnce(sid: string) {
      return port.postGroupMessage({ conversationSid: sid, author: businessNumber as string, body });
    }

    /**
     * Drop a rail Twilio has refused a post into (closed/gone, or the business
     * number is not among its participants) and re-establish one through the ONE
     * authoritative ensure path - which rebuilds a dead rail and REPAIRS a live
     * one it re-adopts by UniqueName. `undefined` means the thread genuinely has
     * no rail right now - which the caller reports as such, and which is now a
     * STORED fact (the sid is cleared and `rail_failed` stamped), so the
     * re-enqueue path and the thread view can both see it.
     */
    // WORST-CASE WALL CLOCK: a healed send performs TWO metered A2P draws (N
    // tokens before the first post, N again before the post-heal retry), so an
    // interactive request can pace for roughly double GROUP_SEND_METER_WAIT_MS's
    // single-draw rationale before its one retry resolves. Accepted: heals are
    // rare (a rail died mid-send) and the meter still bounds each draw.
    async function healRail(
      deadSid: string,
    ): Promise<{ twilioConversationSid: string; participantMap: Record<string, string> } | undefined> {
      try {
        await conversations.clearGroupRail(conversationId, deadSid);
      } catch (err) {
        // A failed clear leaves the stored rail in place, so the ensure below
        // will hand back the same dead sid and the retry will refuse cleanly.
        log.error(
          { conversationId, err: summarizeError(err), event: 'group_rail_clear_failed' },
          'could not drop the closed Conversations rail - the thread stays pinned to it until this succeeds',
        );
      }
      const ensured = await rail.ensureGroupRail({ conversationId, members });
      if (ensured.twilioConversationSid === undefined) {
        log.error(
          {
            conversationId,
            railStatus: ensured.status,
            reason: ensured.reason,
            event: 'group_rail_rebuild_failed',
          },
          'the closed Conversations rail could not be rebuilt - this group text is inbound-only until it can be',
        );
        return undefined;
      }
      return {
        twilioConversationSid: ensured.twilioConversationSid,
        participantMap: ensured.participantMap ?? {},
      };
    }

    /**
     * NOTHING RAW LEAVES THIS PATH (fix wave 5, adversarial 4). A network
     * failure inside the Twilio SDK is a bare AxiosError whose enumerable
     * `config` carries the Authorization header and the POST body - here,
     * `Author=+1...&Body=<the full message text>`. Rethrowing it unchanged sent
     * it straight past api.ts's SendRefusedError-only catch into the Express
     * handler's `log.error({ err })`, which serializes every enumerable key. The
     * summary carries a name, a vendor code and a status, and nothing else.
     */
    function translatePostFailure(err: unknown): SendRefusedError {
      const summary = summarizeError(err);
      log.error(
        { conversationId, err: summary, event: 'group_send_post_failed' },
        'group send post to the Conversations rail failed',
      );
      return new GroupSendFailedError(
        conversationId,
        `${summary.name}${summary.code !== undefined ? ` (${summary.code})` : ''}`,
      );
    }

    // (5a) THE KILL SWITCH, BEFORE THE METER (fix wave 2, adversarial 16). The
    // A2P kill switch is enforced INSIDE the adapter (invariant 13.7) so no
    // direct-adapter caller can bypass it - but that is AFTER the draw, so under
    // the pre-A2P production posture (SMS_SENDING_ENABLED=false) every attempt
    // spent throughput and then refused. This is an ordering guard, not a second
    // enforcement point: the adapter still owns the refusal.
    if (config.smsSendingEnabled === false) throw new SmsSendingDisabledError();

    // (5b) THE A2P METER (fix wave 5, adversarial 34; corrected in wave 2). One
    // token per carrier message, and this post becomes one per member - the same
    // accounting relayFanOut applies per leg. Drawn AFTER every refusal gate
    // above, so a send that is going to be refused never spends throughput the
    // broadcast pacer needs.
    //
    // BOUNDED, because this is the first INTERACTIVE acquirer. `acquire`
    // serialises waiters FIFO and (unbounded) never rejects, so N queued sends
    // held N Express requests open with no ceiling. Past the bound the send
    // refuses with a retryable, staff-readable error. (A refusal may have drawn
    // part of the instalments; TokenBucketBusyError.spent says how many.)
    //
    // ONE DRAW PER POST, INCLUDING THE HEAL RETRY (fix wave 3, conformance 4).
    // The retry below emits a second full fan-out of N carrier messages, so
    // drawing once would have been the one place a single request could put 2N
    // messages on the wire for N tokens.
    async function drawMeter(): Promise<void> {
      if (tokenBucket === null) return;
      try {
        await tokenBucket.acquire(members.length, { timeoutMs: GROUP_SEND_METER_WAIT_MS });
      } catch (err) {
        if (err instanceof TokenBucketBusyError) {
          log.warn(
            { conversationId, memberCount: members.length, event: 'group_send_meter_busy' },
            'group send refused: the shared A2P meter could not admit this send inside its wait bound',
          );
          throw new GroupSendBusyError(conversationId);
        }
        throw err;
      }
    }
    await drawMeter();

    // (6) The post. The adapter owns the A2P kill switch (spec invariant 13.7);
    // its typed failures become SendRefusedErrors here, because the send route
    // maps ONLY that family - an untranslated throw would 500 and tell staff
    // nothing.
    //
    // A CLOSED OR GONE RAIL IS HEALED, ONCE (fix wave 2, adversarial 2). The
    // recovery wave 1's comment promised did not exist: `ensureGroupRail`
    // returns the STORED rail whenever the sid is stamped and the map covers the
    // roster, and nothing cleared the sid - so a rail that auto-closed after
    // creation failed EVERY send to that thread, forever, with a 409 no operator
    // action could clear. Dropping the dead sid (conditionally, so a concurrent
    // healer is never clobbered) is what makes the ensure path re-detect it.
    //
    // AN AUTHOR REFUSAL (50513) IS HEALED THE SAME WAY (prod incident
    // 2026-08-17). The verified-author check above is the row's word; this is
    // Twilio's, and Twilio wins - a participant removed in the console, or a row
    // stamped by an older build, lands here. Dropping the stored rail forces the
    // ensure path off its fast path: it re-adopts the SAME conversation by
    // UniqueName (the rail is alive, so nothing is deleted), attaches the
    // business number, re-stamps, and the retry posts into a rail that can
    // take it.
    let posted;
    try {
      posted = await postOnce(conversationSid as string);
    } catch (err) {
      if (err instanceof AdapterSmsSendingDisabledError) throw new SmsSendingDisabledError();
      if (err instanceof GroupConversationsUnavailableError || err instanceof GroupConversationsAuthorRejectedError) {
        // ERROR, not the adapter's WARN: this is the alarmed channel, and a rail
        // dying under a live thread is exactly what the alarm is for (wave 1
        // dropped it to a WARN and the 409 path logged nothing at all).
        const authorRejected = err instanceof GroupConversationsAuthorRejectedError;
        log.error(
          {
            conversationId,
            conversationSid,
            event: authorRejected ? 'group_rail_author_rejected' : 'group_rail_closed_detected',
            err: summarizeError(err),
          },
          authorRejected
            ? 'the Conversations rail refused a post because the business number is not among its participants - re-verifying and repairing it'
            : 'the Conversations rail refused a post because it is closed or gone - dropping it and rebuilding',
        );
        const healed = await healRail(conversationSid as string);
        if (healed === undefined) {
          throw new GroupRailUnavailableError(conversationId, 'the rail is closed and could not be rebuilt');
        }
        conversationSid = healed.twilioConversationSid;
        participantMap = healed.participantMap;
        // The rebuilt rail is about to carry N more carrier messages, so it pays
        // for them (fix wave 3, conformance 4). A meter that is busy here refuses
        // the send exactly as it would have up front: the first post definitively
        // did not deliver, so nothing is on the wire to be duplicated.
        await drawMeter();
        try {
          posted = await postOnce(conversationSid);
        } catch (retryErr) {
          if (retryErr instanceof AdapterSmsSendingDisabledError) throw new SmsSendingDisabledError();
          if (retryErr instanceof GroupConversationsUnavailableError) {
            throw new GroupRailUnavailableError(conversationId, 'the rebuilt rail refused this post too');
          }
          if (retryErr instanceof GroupConversationsAuthorRejectedError) {
            throw new GroupRailUnavailableError(
              conversationId,
              'the rail still refuses the business number as author after a repair',
            );
          }
          throw translatePostFailure(retryErr);
        }
      } else {
        throw translatePostFailure(err);
      }
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
    // (7a) THE SEED, and the one place a known-suppressed member is labelled.
    // Read through the SAME number-scoped seam the roster chip reads, passing
    // the contact we already resolved above so this adds no contact read. A
    // read FAILURE is not an answer: it falls back to `queued`, which is the
    // pre-existing behavior (worst case, the old false alarm) rather than
    // mislabelling a reachable member as opted out.
    const deliveryRecipients: Record<string, RelayRecipientDelivery> = {};
    for (const { member, contact } of resolved) {
      const key = groupMemberKey(member.phone);
      let suppressed = false;
      try {
        const state = await readNumberSuppression(
          { contactsRepo: contacts, conversationsRepo: conversations },
          member.phone,
          { contact },
        );
        suppressed = state.suppressed;
      } catch (err) {
        log.warn(
          { err, conversationId, contactId: contact?.contactId },
          'group send: suppression read failed - member slot seeded queued (a stuck slot is recoverable; a wrong "opted out" label is not)',
        );
      }
      deliveryRecipients[key] = suppressed ? suppressedSlot() : { status: 'queued' };
    }
    // Spec 4.3: the aggregate derives from the slots. It is `queued` for an
    // ordinary send and only differs when EVERY member is suppressed - a send
    // that reaches nobody and will never receive a receipt to say so.
    const seededStatus = deriveGroupDeliveryStatus(Object.values(deliveryRecipients));

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
      deliveryStatus: seededStatus.status,
      ...(seededStatus.errorCode !== undefined && { errorCode: seededStatus.errorCode }),
      // WHO SAID THIS (fix wave 5, adversarial 12). Attribution on a multi-party
      // timeline is resolved from `relay_sender_key` by ONE rule
      // (dashboard/src/lib/memberAttribution.ts), and every other multi-party
      // writer sets it - the 1:1/relay routes write TEAM_SENDER_KEY, inbound
      // group detection writes the member key, announcements write the system
      // key. This writer did not, so the optimistic "Team" chip the composer
      // rendered VANISHED the moment the SSE-debounced refetch replaced the
      // bubble with the server row: every inbound member bubble attributed,
      // every team bubble not, and the operator watching their own attribution
      // blink out.
      relaySenderKey: TEAM_SENDER_KEY,
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
      deliveryStatus: seededStatus.status,
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
      status: seededStatus.status,
    };
  };
}
