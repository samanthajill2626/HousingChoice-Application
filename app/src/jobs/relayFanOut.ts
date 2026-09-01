// relay.fanOut (M1.7) — fan an inbound relay-group message out to the OTHER
// members, throttled and idempotent.
//
// The relayed message is stored ONCE (the inbound SOURCE message); this job
// NEVER persists N outbound copies. It sends one provider message per
// recipient FROM the pool number, sender-name-prefixed, and records each send
// in the source message's delivery_recipients map + a relaysid pointer (so the
// per-recipient delivery callback can find the right slot).
//
// Idempotency (SQS at-least-once + our own continuation re-enqueues):
//   - the job execution marker (existing pattern) guards the WHOLE job per
//     envelope jobId;
//   - per recipient, a slot already in a TERMINAL state (sent/delivered/
//     failed) is SKIPPED, so a redelivered/continuation job never double-sends.
//
// Error handling per recipient:
//   - transient (429 / Twilio 30022) → re-enqueue a continuation relay.fanOut
//     for the REMAINING recipients with exponential backoff (attempt cap 3);
//   - 30007 (carrier filtering) → mark the recipient failed, NEVER retry;
//   - SendRefusedError (opt-out / breaker / manual) → mark the recipient
//     failed and CONTINUE with the others.
//
// PII (doc §9): never log the body, the sender's phone, or member phones —
// IDs / member keys / counts only, correlated via the pino mixin.
import {
  createMessagingAdapter,
  type CarrierMessageSender,
  type MessagingAdapter,
  type MessageTransportIntent,
  type SendMessageParams,
} from '../adapters/messaging.js';
import { createMediaStore, type MediaStore } from '../adapters/mediaStore.js';
import { getContext } from '../lib/context.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { TokenBucket } from '../lib/tokenBucket.js';
import {
  createConversationsRepo,
  type ConversationParticipant,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import { createContactsRepo, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  createMessagesRepo,
  mediaAttachmentsOf,
  relayMemberKey,
  type MessageItem,
  type MessagesRepo,
  type RelayRecipientDelivery,
  type TransportMutationOutcome,
} from '../repos/messagesRepo.js';
import { TRANSPORT_SCHEMA_VERSION } from '../lib/messageTransport.js';
import { SMS_BRAND_NAME } from '../lib/smsCompliance.js';
import { SendRefusedError } from '../services/sendMessage.js';
import {
  isMemberSuppressed,
  logSafeMemberKey,
  sendRelayAnnouncement,
} from '../services/relayAnnouncements.js';
import { resolveMessage } from '../messages/index.js';
import { defineJobHandler, enqueue } from './jobs.js';

// Canonical home moved to services/relayAnnouncements.ts (tourReminders.ts and
// this module's fan-out loop import it from here historically) — re-exported.
export { isMemberSuppressed } from '../services/relayAnnouncements.js';

export const RELAY_FANOUT_JOB = 'relay.fanOut';
export const RELAY_INTRO_JOB = 'relay.intro';
export const RELAY_MEMBER_ADDED_JOB = 'relay.memberAdded';

/** Continuation cap: a transient failure re-enqueues at most this many times. */
export const MAX_FANOUT_ATTEMPTS = 3;

/**
 * Outbound MMS presign TTL for relay legs (design Sec 7): 1 hour. Presigned
 * PER LEG at leg-send time - never batched up front - so a token-bucket-paced
 * roster or a backed-off continuation never hands Twilio an expired URL.
 */
export const RELAY_PRESIGN_TTL_SECONDS = 3600;

/** Exponential backoff for the transient-failure continuation: 5s, 10s, 20s. */
export function fanOutBackoffMs(attempt: number): number {
  return 5_000 * 2 ** (attempt - 1);
}

/** Twilio transient error codes that warrant a backed-off continuation. */
const TRANSIENT_CODES = new Set(['429', '30022']);
/** Twilio carrier-filtering: NEVER retry (re-sending filtered content compounds harm). */
const CARRIER_FILTERED_CODE = '30007';

/** Neutral sender label when a member has no resolved name (never leak phone). */
const ANONYMOUS_SENDER_LABEL = 'A member';

/**
 * FIX 2 — neutral team label prefixed on a TEAM-authored relay message (a
 * teammate posting into the thread from the dashboard). There is no member
 * sender, so the prefix must be this team label — NEVER a phone number. A2P
 * (spec section 5): the SMS-facing sender label always comes from the single
 * source of truth in lib/smsCompliance.ts, never from a literal spelled here --
 * that stays true even now that the SMS brand and the internal name are both
 * "HousingChoice".
 */
export const TEAM_SENDER_LABEL = SMS_BRAND_NAME;

/**
 * FIX 2 — senderKey sentinel for a TEAM message: it matches no member key, so
 * the fan-out excludes NO member (every member receives the team message) and
 * resolves the prefix from senderNameOverride instead of a member's name.
 */
export const TEAM_SENDER_KEY = 'team';

export interface RelayFanOutPayload {
  relayConversationId: string;
  /** SK of the source (inbound) message whose body is being relayed. */
  sourceTsMsgId: string;
  /** Member key (relayMemberKey) of the sender — never a recipient. */
  senderKey: string;
  /**
   * FIX 2 — explicit sender-prefix label for a TEAM message (a teammate posting
   * from the dashboard): there is no member sender to derive a name from, so
   * this neutral team label is the prefix. NEVER a phone. Absent on a normal
   * member-relayed message (the prefix comes from the sender member's name).
   */
  senderNameOverride?: string;
  /** 1-based continuation attempt (absent = first run, treated as 1). */
  attempt?: number;
  /**
   * When set (continuation only), restrict fan-out to these recipient member
   * keys — the remaining recipients after a transient failure. Absent = all
   * non-sender members.
   */
  recipientKeys?: string[];
}

export function parseRelayFanOutPayload(payload: unknown): RelayFanOutPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayFanOut: payload is not an object');
  }
  const p = payload as Partial<RelayFanOutPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayFanOut: missing relayConversationId');
  }
  if (typeof p.sourceTsMsgId !== 'string' || p.sourceTsMsgId.length === 0) {
    throw new Error('relayFanOut: missing sourceTsMsgId');
  }
  if (typeof p.senderKey !== 'string' || p.senderKey.length === 0) {
    throw new Error('relayFanOut: missing senderKey');
  }
  const senderNameOverride =
    typeof p.senderNameOverride === 'string' && p.senderNameOverride.length > 0
      ? p.senderNameOverride
      : undefined;
  const attempt =
    typeof p.attempt === 'number' && Number.isInteger(p.attempt) && p.attempt >= 1
      ? p.attempt
      : 1;
  const recipientKeys =
    Array.isArray(p.recipientKeys) && p.recipientKeys.every((k) => typeof k === 'string')
      ? p.recipientKeys
      : undefined;
  return {
    relayConversationId: p.relayConversationId,
    sourceTsMsgId: p.sourceTsMsgId,
    senderKey: p.senderKey,
    ...(senderNameOverride !== undefined && { senderNameOverride }),
    attempt,
    ...(recipientKeys !== undefined && { recipientKeys }),
  };
}

/** Terminal recipient states never re-sent (idempotency). */
function isTerminal(status: RelayRecipientDelivery['status'] | undefined): boolean {
  return status === 'sent' || status === 'delivered' || status === 'failed';
}

/** Compose the relayed body: "<SenderName>: <body>" — never leaks a phone. */
export function composeRelayBody(senderName: string | undefined, body: string): string {
  const label = senderName && senderName.trim().length > 0 ? senderName : ANONYMOUS_SENDER_LABEL;
  return `${label}: ${body}`;
}

/**
 * FIRST name only, for the connection sentence below. The stored display name is
 * the "First Last" join (lib/rosterResolution.ts), which read as over-formal in a
 * group intro: the founder reported 2026-08-20 that a landlord came through as
 * "First Last" while the tenant came through as a bare first name. That was never
 * a data difference - most imported tenant contacts simply have no lastName on
 * file, so the join yields one token and LOOKED right. Everyone gets first names
 * now, so the two render alike.
 *
 * Deliberately accepted: two members sharing a first name are ambiguous here
 * (founder's call, 2026-08-20 - a natural-sounding intro is worth it).
 */
function firstNameOnly(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name.trim();
}

/**
 * The "You're now connected with …" connection sentence shared by the intro
 * and the member-added announcement. Uses member FIRST names where known, a
 * neutral count phrasing otherwise — NEVER a phone number (PII).
 */
export function composeConnectionSentence(memberNames: (string | undefined)[]): string {
  const named = memberNames
    .map((n) => (n && n.trim().length > 0 ? firstNameOnly(n) : undefined))
    .filter((n): n is string => n !== undefined);
  if (named.length === 0) {
    const others = Math.max(memberNames.length - 1, 0);
    return others > 0
      ? `You're now connected with ${others} other ${others === 1 ? 'person' : 'people'} on this number. Reply here and everyone in the group sees it.`
      : `You're now connected on this number. Reply here and the group sees it.`;
  }
  const list =
    named.length === 1
      ? named[0]
      : named.length === 2
        ? `${named[0]} and ${named[1]}`
        : `${named.slice(0, -1).join(', ')}, and ${named[named.length - 1]}`;
  return `You're now connected with ${list} on this number. Reply here and everyone in the group sees it.`;
}

/**
 * Intro body naming everyone connected (M1.7). E.g. "HousingChoice. You're
 * now connected with Alice, Bob, and Carol on this number. Reply here and
 * everyone in the group sees it. Reply STOP to opt out."
 *
 * A2P (spec §5): the intro is a first-contact message, so it carries the brand
 * identity (leading) and the opt-out instruction (trailing — founder wording
 * 2026-07-14: content first, STOP last). Both fold into the catalog default.
 */
export function composeIntroBody(memberNames: (string | undefined)[]): string {
  // The count-plurality / Oxford-list `connection` string feeds the {members}
  // token of the `relay.intro` catalog default (brand … opt-out shell).
  return resolveMessage('relay.intro', { members: composeConnectionSentence(memberNames) });
}

/** Neutral joined label when the added member has no resolved name (never a phone). */
const ANONYMOUS_JOINED_LABEL = 'A new member';

/**
 * Member-added announcement (founder decision 2026-07-14): one body sent to
 * the WHOLE group — the new member's first contact on this number (leading
 * brand + trailing STOP fold in like the intro) doubling as the join notice
 * for everyone else. E.g. "Hey! Carol joined this group chat. You're now
 * connected with Alice, Bob, and Carol on this number. Reply here and everyone
 * in the group sees it."
 *
 * The joiner is named by FIRST name (2026-08-20), matching the connection
 * sentence - mixing "Carol Brown joined" with "connected with ... Carol" in one
 * body reads like two different people.
 */
export function composeMemberAddedBody(
  newMemberName: string | undefined,
  memberNames: (string | undefined)[],
): string {
  const who =
    newMemberName && newMemberName.trim().length > 0
      ? firstNameOnly(newMemberName)
      : ANONYMOUS_JOINED_LABEL;
  return resolveMessage('relay.member_added', {
    joined: `${who} joined this group chat.`,
    members: composeConnectionSentence(memberNames),
  });
}

export interface RelayIntroPayload {
  relayConversationId: string;
  /**
   * false = legs-only: send the intro texts but persist NO announcement row.
   * The dev replay seam's mode (POST /__dev/relay/replay-intros re-fires
   * intros at every boot to materialize fake-phones groups — it must never
   * grow the seeded threads). Absent/true on real provisioning: the intro is
   * persisted so the dashboard thread shows it (founder decision 2026-07-14).
   */
  persist?: boolean;
}

export function parseRelayIntroPayload(payload: unknown): RelayIntroPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayIntro: payload is not an object');
  }
  const p = payload as Partial<RelayIntroPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayIntro: missing relayConversationId');
  }
  return {
    relayConversationId: p.relayConversationId,
    ...(p.persist === false && { persist: false }),
  };
}

export interface RelayMemberAddedPayload {
  relayConversationId: string;
  /** relayMemberKey of the just-added member — resolved against the CURRENT
   *  roster at job time for the display name (a raced remove degrades to the
   *  neutral joined label, never a failure). */
  addedMemberKey: string;
}

export function parseRelayMemberAddedPayload(payload: unknown): RelayMemberAddedPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayMemberAdded: payload is not an object');
  }
  const p = payload as Partial<RelayMemberAddedPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayMemberAdded: missing relayConversationId');
  }
  if (typeof p.addedMemberKey !== 'string' || p.addedMemberKey.length === 0) {
    throw new Error('relayMemberAdded: missing addedMemberKey');
  }
  return { relayConversationId: p.relayConversationId, addedMemberKey: p.addedMemberKey };
}

export interface RelayFanOutJobDeps {
  adapter?: MessagingAdapter & CarrierMessageSender;
  conversationsRepo?: ConversationsRepo;
  messagesRepo?: MessagesRepo;
  contactsRepo?: ContactsRepo;
  /**
   * Media bucket store for presigning relay-leg media (outbound MMS). Undefined
   * when MEDIA_BUCKET is unset (a no-bucket dev loop): the media-only body still
   * relays as text, but no media is attached. Lazily created on first job run.
   */
  mediaStore?: MediaStore;
  /** Shared A2P token bucket (worker boot). Optional — tests may omit pacing. */
  tokenBucket?: TokenBucket;
  logger?: Logger;
}

export function registerRelayFanOutJobHandler(deps: RelayFanOutJobDeps = {}): void {
  const log = deps.logger ?? defaultLogger;
  // Lazy: repos/adapter touch config + DynamoDB only on first job run.
  let adapter = deps.adapter;
  let conversations = deps.conversationsRepo;
  let messages = deps.messagesRepo;
  let contacts = deps.contactsRepo;
  // MediaStore can legitimately resolve to undefined (no MEDIA_BUCKET), so a
  // separate init flag drives the lazy build (not `??=`, which would rebuild).
  let mediaStore = deps.mediaStore;
  let mediaStoreInit = deps.mediaStore !== undefined;

  defineJobHandler(RELAY_FANOUT_JOB, async (rawPayload) => {
    const payload = parseRelayFanOutPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });
    if (!mediaStoreInit) {
      mediaStore = createMediaStore();
      mediaStoreInit = true;
    }

    // Whole-job duplicate-delivery guard (existing pattern): conditionally
    // mark this envelope jobId executed BEFORE any send. A redelivery resolves
    // as a no-op so the consumer deletes the message. Per-recipient terminal
    // skips are the second layer (a continuation reuses recipientKeys).
    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.relayConversationId);
      if (!first) {
        log.info({ jobId, conversationId: payload.relayConversationId }, 'relay fan-out duplicate delivery suppressed');
        return;
      }
    } else {
      log.warn(
        { conversationId: payload.relayConversationId },
        'relayFanOut: no jobId in context — duplicate-delivery guard skipped',
      );
    }

    const conversation = await conversations.getById(payload.relayConversationId);
    if (!conversation) {
      log.warn({ conversationId: payload.relayConversationId }, 'relayFanOut: relay conversation not found — nothing to fan out');
      return;
    }
    // AF-2 status gate: the group may have CLOSED between enqueue and now (a
    // queued/continuation job outlives a close). pool_number is KEPT on close
    // (burn-multiplexing), so `status` - not pool_number presence - is the
    // authoritative closed-gate (mirrors relayAnnouncements.ts). A closed group
    // must never fan out: a late relayed message would contradict the already-
    // sent "This group chat is now closed" final message.
    if (conversation.status !== 'open') {
      log.info(
        { conversationId: payload.relayConversationId, status: conversation.status },
        'relay fan-out skipped - group not open',
      );
      return;
    }
    const poolNumber = conversation.pool_number;
    if (typeof poolNumber !== 'string' || poolNumber.length === 0) {
      log.warn({ conversationId: payload.relayConversationId }, 'relayFanOut: relay conversation has no pool number — skipping');
      return;
    }

    // Re-read the exact source message by SK (a tight window that includes it).
    const window = await messages.listByConversation(payload.relayConversationId, {
      before: bumpKey(payload.sourceTsMsgId),
      limit: 5,
    });
    const sourceMessage = window.find((m) => m.tsMsgId === payload.sourceTsMsgId);
    if (!sourceMessage) {
      log.warn({ conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId }, 'relayFanOut: source message not found');
      return;
    }
    const execution: RelayFanOutExecutionDeps = {
      adapter,
      conversations,
      messages,
      contacts,
      conversation,
      poolNumber,
      mediaStore,
      tokenBucket: deps.tokenBucket,
      log,
    };
    if (sourceMessage.transport_schema_version !== TRANSPORT_SCHEMA_VERSION) {
      await runLegacyRelayFanOut(sourceMessage, payload, execution);
      return;
    }
    await runVersionedRelayFanOut(sourceMessage, payload, execution);
  });

  // relay.intro (M1.7): on relay-group creation, announce the group to each
  // member FROM the pool number, throttled by the shared bucket. The intro
  // names everyone connected (display names where known, never a phone).
  // Persisted in the thread as a SYSTEM announcement (relayAnnouncements.ts —
  // founder decision 2026-07-14: everything sent into a relay group must be
  // visible in its dashboard thread) UNLESS payload.persist === false (the dev
  // replay seam). Idempotent via the job execution marker so a redelivery
  // never re-texts everyone or double-persists.
  defineJobHandler(RELAY_INTRO_JOB, async (rawPayload) => {
    const payload = parseRelayIntroPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });

    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.relayConversationId);
      if (!first) {
        log.info({ jobId, conversationId: payload.relayConversationId }, 'relay intro duplicate delivery suppressed');
        return;
      }
    }

    // Compose from the CURRENT roster; sendRelayAnnouncement re-validates the
    // conversation (unusable → logged no-op, matching the old intro behavior).
    const conversation = await conversations.getById(payload.relayConversationId);
    const roster = (conversation?.participants ?? []) as ConversationParticipant[];
    // An operator who EDITED the previewed intro gets exactly what they typed
    // (2026-08-20). Untouched, the attribute is absent and we compose from the
    // roster as always - which is the better default, because the roster can
    // still change between the preview and this job, and a composed body follows
    // it while a pinned one cannot. Edited text wins anyway: a human chose it.
    const edited = typeof conversation?.intro_body === 'string' ? conversation.intro_body : '';
    const body = edited.length > 0 ? edited : composeIntroBody(roster.map((m) => m.name));
    if (edited.length > 0) {
      log.info(
        { conversationId: payload.relayConversationId },
        'relay intro: sending the operator-edited body, not the composed default',
      );
    }
    await sendRelayAnnouncement(
      {
        conversationsRepo: conversations,
        messagesRepo: messages,
        contactsRepo: contacts,
        adapter,
        ...(deps.tokenBucket !== undefined && { tokenBucket: deps.tokenBucket }),
        ...(deps.logger !== undefined && { logger: deps.logger }),
      },
      {
        conversationId: payload.relayConversationId,
        body,
        kind: 'relay.intro',
        ...(payload.persist === false && { persist: false }),
      },
    );
  });

  // relay.memberAdded (founder decision 2026-07-14): announce a member added
  // to an EXISTING group to the WHOLE group — the new member's welcome (their
  // first contact on this number) doubling as everyone else's join notice.
  // Persisted as a system announcement (visible in the dashboard thread) with
  // per-member delivery slots. Idempotent via the job execution marker.
  defineJobHandler(RELAY_MEMBER_ADDED_JOB, async (rawPayload) => {
    const payload = parseRelayMemberAddedPayload(rawPayload);
    adapter ??= createMessagingAdapter({ logger: deps.logger });
    conversations ??= createConversationsRepo({ logger: deps.logger });
    messages ??= createMessagesRepo({ logger: deps.logger });
    contacts ??= createContactsRepo({ logger: deps.logger });

    const jobId = getContext()?.jobId;
    if (typeof jobId === 'string' && jobId.length > 0) {
      const first = await messages.putJobExecutionMarker(jobId, payload.relayConversationId);
      if (!first) {
        log.info({ jobId, conversationId: payload.relayConversationId }, 'relay member-added duplicate delivery suppressed');
        return;
      }
    }

    const conversation = await conversations.getById(payload.relayConversationId);
    const roster = (conversation?.participants ?? []) as ConversationParticipant[];
    const added = roster.find((m) => relayMemberKey(m) === payload.addedMemberKey);
    const body = composeMemberAddedBody(
      added?.name,
      roster.map((m) => m.name),
    );
    await sendRelayAnnouncement(
      {
        conversationsRepo: conversations,
        messagesRepo: messages,
        contactsRepo: contacts,
        adapter,
        ...(deps.tokenBucket !== undefined && { tokenBucket: deps.tokenBucket }),
        ...(deps.logger !== undefined && { logger: deps.logger }),
      },
      { conversationId: payload.relayConversationId, body, kind: 'relay.member_added' },
    );
  });
}

interface RelayFanOutExecutionDeps {
  adapter: MessagingAdapter & CarrierMessageSender;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  contacts: ContactsRepo;
  conversation: Awaited<ReturnType<ConversationsRepo['getById']>> & {};
  poolNumber: string;
  mediaStore: MediaStore | undefined;
  tokenBucket: TokenBucket | undefined;
  log: Logger;
}

type RelayTransportMode =
  | { kind: 'legacy' }
  | { kind: 'versioned'; intent: MessageTransportIntent };

async function runLegacyRelayFanOut(
  source: MessageItem,
  payload: RelayFanOutPayload,
  deps: RelayFanOutExecutionDeps,
): Promise<void> {
  await runRelayFanOutExecution(source, payload, deps, { kind: 'legacy' });
}

async function runVersionedRelayFanOut(
  source: MessageItem,
  payload: RelayFanOutPayload,
  deps: RelayFanOutExecutionDeps,
): Promise<void> {
  const durableMedia = mediaAttachmentsOf(source);
  const intent = deps.adapter.classifyMessageTransport({
    hasForwardableMedia: durableMedia.length > 0 && deps.mediaStore !== undefined,
  });
  await runRelayFanOutExecution(source, payload, deps, { kind: 'versioned', intent });
}

async function runRelayFanOutExecution(
  source: MessageItem,
  payload: RelayFanOutPayload,
  deps: RelayFanOutExecutionDeps,
  transport: RelayTransportMode,
): Promise<void> {
  const { adapter, conversations, messages, contacts, conversation, poolNumber, mediaStore, log } = deps;
  const body = typeof source.body === 'string' ? source.body : '';
  const sourceMedia = mediaAttachmentsOf(source);
  const hasMedia = sourceMedia.length > 0;
  const roster = (conversation.participants ?? []) as ConversationParticipant[];
  const senderMember = roster.find((member) => relayMemberKey(member) === payload.senderKey);
  const senderName = payload.senderNameOverride ?? senderMember?.name;
  const senderLabel =
    senderName && senderName.trim().length > 0 ? senderName : ANONYMOUS_SENDER_LABEL;
  let relayBody: string;
  if (body.length > 0) {
    relayBody = composeRelayBody(senderName, body);
  } else if (hasMedia) {
    relayBody = resolveMessage('relay.media_only', { name: senderLabel });
  } else {
    log.info(
      { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId },
      'relayFanOut: source has neither text nor media - nothing relayed',
    );
    return;
  }
  if (hasMedia && !mediaStore) {
    log.error(
      {
        conversationId: payload.relayConversationId,
        tsMsgId: payload.sourceTsMsgId,
        mediaCount: sourceMedia.length,
      },
      'relayFanOut: source has media but no MediaStore - relaying body only, media dropped',
    );
  }

  const currentRoster = roster.filter((member) => relayMemberKey(member) !== payload.senderKey);
  let recipients = currentRoster;
  if (payload.recipientKeys !== undefined) {
    const allowed = new Set(payload.recipientKeys);
    recipients = recipients.filter((member) => allowed.has(relayMemberKey(member)));
  }

  let currentSource = source;
  if (transport.kind === 'versioned') {
    currentSource = await preflightVersionedRecipients(
      source,
      payload,
      recipients,
      currentRoster,
      transport.intent,
      messages,
    );
    const persistedRequests = new Set(
      recipients
        .map((member) => currentSource.delivery_recipients?.[relayMemberKey(member)]?.requestedTransport)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
    );
    if (
      (source.requested_transport !== undefined &&
        source.requested_transport !== transport.intent.requestedTransport) ||
      [...persistedRequests].some((request) => request !== transport.intent.requestedTransport)
    ) {
      log.warn(
        {
          conversationId: payload.relayConversationId,
          tsMsgId: payload.sourceTsMsgId,
          requestedTransport: source.requested_transport,
          executionTransport: transport.intent.requestedTransport,
        },
        'relayFanOut: persisted transport intent differs from execution classification',
      );
    }
  }

  const transientRemaining: string[] = [];
  let sentCount = 0;
  for (const member of recipients) {
    const key = relayMemberKey(member);
    const priorSlot = currentSource.delivery_recipients?.[key];
    if (isTerminal(priorSlot?.status)) continue;

    if (await isMemberSuppressed(contacts, conversations, member)) {
      if (transport.kind === 'versioned') {
        await setVersionedAggregationState(messages, payload, key, 'excluded', ['excluded', 'attempted']);
      }
      await persistRelayRecipientResult(messages, payload, key, {
        status: 'failed',
        errorCode: 'contact_opted_out',
      }, transport);
      try {
        await conversations.setRelayMemberOptedOut(payload.relayConversationId, key, {
          ...(member.contactId !== undefined &&
            member.contactId.length > 0 && { contactId: member.contactId }),
          phone: member.phone,
          ...(member.name !== undefined && { name: member.name }),
          at: new Date().toISOString(),
        });
      } catch (err) {
        log.error(
          {
            err,
            conversationId: payload.relayConversationId,
            memberKey: logSafeMemberKey(member),
          },
          'relayFanOut: annotating conversation with member opt-out failed - continuing',
        );
      }
      log.info(
        {
          conversationId: payload.relayConversationId,
          memberKey: logSafeMemberKey(member),
        },
        'relayFanOut: recipient opted out (sms_opt_out) - skipped, not sent',
      );
      continue;
    }

    await deps.tokenBucket?.acquire(1);
    let legMediaUrls: string[] | undefined;
    if (hasMedia && mediaStore) {
      legMediaUrls = await Promise.all(
        sourceMedia.map((attachment) =>
          mediaStore.presign(attachment.s3Key, RELAY_PRESIGN_TTL_SECONDS),
        ),
      );
    }
    const params: SendMessageParams = {
      to: member.phone,
      from: poolNumber,
      body: relayBody,
      ...(legMediaUrls !== undefined && { mediaUrls: legMediaUrls }),
    };
    const prepared =
      transport.kind === 'versioned'
        ? adapter.prepareMessageSend(transport.intent, params)
        : undefined;

    if (transport.kind === 'versioned') {
      await setVersionedAggregationState(messages, payload, key, 'attempted', ['attempted']);
    }

    let result;
    try {
      result =
        transport.kind === 'versioned'
          ? await adapter.sendPreparedMessage(prepared!)
          : await adapter.sendMessage(params);
    } catch (err) {
      if (err instanceof SendRefusedError) {
        await persistRelayRecipientResult(
          messages,
          payload,
          key,
          { status: 'failed', errorCode: err.code },
          transport,
        );
        log.warn(
          {
            conversationId: payload.relayConversationId,
            memberKey: logSafeMemberKey(member),
            refusal: err.code,
          },
          'relayFanOut: send refused for recipient - marked failed, continuing',
        );
        continue;
      }
      const code = errorCodeOf(err);
      if (code === CARRIER_FILTERED_CODE) {
        await persistRelayRecipientResult(
          messages,
          payload,
          key,
          { status: 'failed', errorCode: code },
          transport,
        );
        log.error(
          {
            conversationId: payload.relayConversationId,
            memberKey: logSafeMemberKey(member),
            errorCode: code,
          },
          'relayFanOut: carrier filtering (30007) - recipient failed, NOT retried',
        );
        continue;
      }
      if (code !== undefined && TRANSIENT_CODES.has(code)) {
        await persistRelayRecipientResult(
          messages,
          payload,
          key,
          { status: 'queued', errorCode: code },
          transport,
        );
        transientRemaining.push(key);
        log.warn(
          {
            conversationId: payload.relayConversationId,
            memberKey: logSafeMemberKey(member),
            errorCode: code,
            attempt: payload.attempt,
          },
          'relayFanOut: transient send error - deferring recipient to continuation',
        );
        continue;
      }
      throw err;
    }

    await persistRelayRecipientResult(
      messages,
      payload,
      key,
      {
        status: result.status === 'queued' ? 'queued' : 'sent',
        sid: result.providerSid,
        sentAt: result.providerTs,
        ...(transport.kind === 'versioned' &&
          result.actualTransport !== undefined && { actualTransport: result.actualTransport }),
      },
      transport,
    );
    await messages.putRelaySidPointer(result.providerSid, {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      memberKey: key,
    });
    sentCount += 1;
  }

  log.info(
    {
      conversationId: payload.relayConversationId,
      tsMsgId: payload.sourceTsMsgId,
      recipientCount: recipients.length,
      sentCount,
      deferred: transientRemaining.length,
      attempt: payload.attempt,
    },
    'relay fan-out complete',
  );

  if (transientRemaining.length === 0) return;
  const nextAttempt = (payload.attempt ?? 1) + 1;
  if (nextAttempt > MAX_FANOUT_ATTEMPTS) {
    for (const key of transientRemaining) {
      await persistRelayRecipientResult(
        messages,
        payload,
        key,
        { status: 'failed', errorCode: 'transient_cap' },
        transport,
      );
    }
    log.error(
      {
        conversationId: payload.relayConversationId,
        deferred: transientRemaining.length,
        attempt: payload.attempt,
      },
      'relayFanOut: transient retry cap reached - remaining recipients marked failed',
    );
    return;
  }
  await enqueue(
    RELAY_FANOUT_JOB,
    {
      relayConversationId: payload.relayConversationId,
      sourceTsMsgId: payload.sourceTsMsgId,
      senderKey: payload.senderKey,
      ...(payload.senderNameOverride !== undefined && {
        senderNameOverride: payload.senderNameOverride,
      }),
      attempt: nextAttempt,
      recipientKeys: transientRemaining,
    } satisfies RelayFanOutPayload,
    { runAt: new Date(Date.now() + fanOutBackoffMs(payload.attempt ?? 1)) },
  );
}

async function preflightVersionedRecipients(
  source: MessageItem,
  payload: RelayFanOutPayload,
  recipients: ConversationParticipant[],
  currentRoster: ConversationParticipant[],
  intent: MessageTransportIntent,
  messages: MessagesRepo,
): Promise<MessageItem> {
  const currentRosterKeys = new Set(currentRoster.map((member) => relayMemberKey(member)));
  const requestedTransport = source.requested_transport ?? intent.requestedTransport;
  for (const member of recipients) {
    const key = relayMemberKey(member);
    if (source.delivery_recipients?.[key] === undefined) {
      const outcome = await messages.initializeRecipientDelivery(
        payload.relayConversationId,
        payload.sourceTsMsgId,
        key,
        {
          status: 'queued',
          requestedTransport,
          transportAggregationState: 'planned',
        },
      );
      if (outcome !== 'created' && outcome !== 'existing') {
        throw new Error(`relayFanOut: v1 preflight initialize failed: ${outcome}`);
      }
    }
  }

  let current = await readVersionedSource(messages, payload);
  for (const member of recipients) {
    const key = relayMemberKey(member);
    const slot = current.delivery_recipients?.[key];
    if (!slot) throw new Error('relayFanOut: v1 preflight recipient slot missing');
    if (slot.transportAggregationState === undefined || canReopenExcludedSlot(slot)) {
      await setVersionedAggregationState(
        messages,
        payload,
        key,
        'planned',
        ['planned', 'attempted'],
      );
    }
  }

  current = await readVersionedSource(messages, payload);
  for (const [key, slot] of Object.entries(current.delivery_recipients ?? {})) {
    if (
      !currentRosterKeys.has(key) &&
      (slot.transportAggregationState === undefined ||
        slot.transportAggregationState === 'planned') &&
      (slot.transportAggregationState === 'planned' ||
        (slot.sid === undefined &&
          slot.sentAt === undefined &&
          slot.actualTransport === undefined))
    ) {
      await setVersionedAggregationState(
        messages,
        payload,
        key,
        'excluded',
        ['excluded', 'attempted'],
      );
    }
  }
  return readVersionedSource(messages, payload);
}

function canReopenExcludedSlot(slot: RelayRecipientDelivery): boolean {
  return (
    slot.transportAggregationState === 'excluded' &&
    slot.status !== 'failed' &&
    slot.errorCode !== 'contact_opted_out' &&
    slot.sid === undefined &&
    slot.sentAt === undefined &&
    slot.actualTransport === undefined
  );
}

async function readVersionedSource(
  messages: MessagesRepo,
  payload: RelayFanOutPayload,
): Promise<MessageItem> {
  const source = await messages.getByTsMsgId(
    payload.relayConversationId,
    payload.sourceTsMsgId,
  );
  if (!source || source.transport_schema_version !== TRANSPORT_SCHEMA_VERSION) {
    throw new Error('relayFanOut: v1 preflight source missing or changed schema');
  }
  return source;
}

async function setVersionedAggregationState(
  messages: MessagesRepo,
  payload: RelayFanOutPayload,
  memberKey: string,
  next: NonNullable<RelayRecipientDelivery['transportAggregationState']>,
  acceptableStates: NonNullable<RelayRecipientDelivery['transportAggregationState']>[],
): Promise<void> {
  const outcome = await messages.setRecipientTransportAggregationState(
    payload.relayConversationId,
    payload.sourceTsMsgId,
    memberKey,
    next,
  );
  if (outcome === 'updated' || outcome === 'idempotent') return;
  if (outcome === 'conflict') {
    const source = await readVersionedSource(messages, payload);
    const current = source.delivery_recipients?.[memberKey]?.transportAggregationState;
    if (current !== undefined && acceptableStates.includes(current)) return;
  }
  throw new Error(`relayFanOut: v1 preflight aggregation failed: ${outcome}`);
}

async function persistRelayRecipientResult(
  messages: MessagesRepo,
  payload: RelayFanOutPayload,
  memberKey: string,
  delivery: RelayRecipientDelivery,
  transport: RelayTransportMode,
): Promise<void> {
  if (transport.kind === 'legacy') {
    await markRecipient(messages, payload, memberKey, delivery);
    return;
  }
  const outcome: TransportMutationOutcome = await messages.applyRecipientSendResult(
    payload.relayConversationId,
    payload.sourceTsMsgId,
    memberKey,
    delivery,
  );
  if (outcome === 'missing' || outcome === 'legacy_noop') {
    throw new Error(`relayFanOut: v1 recipient result failed: ${outcome}`);
  }
}

/** Persist one recipient's delivery slot on the source message. */
async function markRecipient(
  messages: MessagesRepo,
  payload: RelayFanOutPayload,
  memberKey: string,
  delivery: RelayRecipientDelivery,
): Promise<void> {
  await messages.setRecipientDelivery(
    payload.relayConversationId,
    payload.sourceTsMsgId,
    memberKey,
    delivery,
  );
}

/**
 * Exclusive `before` bound that INCLUDES the target SK: append the maximal
 * BMP code point so `tsMsgId < before` is true for the target itself (and any
 * later SK in the same second is excluded — relay sources are inbound, one at
 * a time, so the 5-item window comfortably contains it).
 */
function bumpKey(tsMsgId: string): string {
  return `${tsMsgId}￿`;
}

/** Best-effort provider error-code extraction (Twilio attaches `code`). */
function errorCodeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return String(code);
    if (typeof code === 'string' && code.length > 0) return code;
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return String(status);
  }
  return undefined;
}
