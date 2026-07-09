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
import { createMessagingAdapter, type MessagingAdapter } from '../adapters/messaging.js';
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
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import { SMS_BRAND_NAME } from '../lib/smsCompliance.js';
import { SendRefusedError } from '../services/sendMessage.js';
import { resolveMessage } from '../messages/index.js';
import { defineJobHandler, enqueue } from './jobs.js';

export const RELAY_FANOUT_JOB = 'relay.fanOut';
export const RELAY_INTRO_JOB = 'relay.intro';

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
 * (spec §5): the SMS-facing sender label is the registered brand (single source
 * of truth), never the internal "HousingChoice" name.
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
 * Intro body naming everyone connected (M1.7). Uses member display names where
 * known, a neutral count phrasing otherwise — NEVER a phone number (PII). E.g.
 * "Tenant Place LLC. Reply STOP to opt out. You're connected with Alice, Bob,
 * and Carol on this number."
 *
 * A2P (spec §5): the intro is a first-contact message, so it is PREPENDED with
 * RELAY_INTRO_IDENTITY (business identity + "Reply STOP to opt out.") — today's
 * intro carried neither. The identity comes from the single source of truth.
 */
export function composeIntroBody(memberNames: (string | undefined)[]): string {
  const named = memberNames
    .map((n) => (n && n.trim().length > 0 ? n.trim() : undefined))
    .filter((n): n is string => n !== undefined);
  const connection =
    named.length === 0
      ? (() => {
          const others = Math.max(memberNames.length - 1, 0);
          return others > 0
            ? `You're now connected with ${others} other ${others === 1 ? 'person' : 'people'} on this number. Reply here and everyone in the group sees it.`
            : `You're now connected on this number. Reply here and the group sees it.`;
        })()
      : (() => {
          const list =
            named.length === 1
              ? named[0]
              : named.length === 2
                ? `${named[0]} and ${named[1]}`
                : `${named.slice(0, -1).join(', ')}, and ${named[named.length - 1]}`;
          return `You're now connected with ${list} on this number. Reply here and everyone in the group sees it.`;
        })();
  // The RELAY_INTRO_IDENTITY prefix + a space is folded into the `relay.intro`
  // catalog default; the count-plurality / Oxford-list `connection` string feeds
  // the {members} token. Net sent text is byte-identical to before.
  return resolveMessage('relay.intro', { members: connection });
}

export interface RelayIntroPayload {
  relayConversationId: string;
}

export function parseRelayIntroPayload(payload: unknown): RelayIntroPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('relayIntro: payload is not an object');
  }
  const p = payload as Partial<RelayIntroPayload>;
  if (typeof p.relayConversationId !== 'string' || p.relayConversationId.length === 0) {
    throw new Error('relayIntro: missing relayConversationId');
  }
  return { relayConversationId: p.relayConversationId };
}

export interface RelayFanOutJobDeps {
  adapter?: MessagingAdapter;
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

/**
 * Opt-out suppression for a relay recipient (spec §6 / doc §7.1). Relay sends
 * go STRAIGHT to the adapter — the 1:1 `sendMessage` opt-out gate targets the
 * thread's participant_phone (the pool number), not the individual member, so
 * it never fires here. STOP suppression MUST therefore be re-enforced at this
 * seam or an opted-out member would keep receiving relayed messages. A member
 * who STOP'd carries contact-level `sms_opt_out` (the same signal the 1:1 +
 * broadcast gates read). Resolves the member's contact by id (phone fallback).
 * Deliberately NOT wrapped in try/catch: a repo failure propagates so the caller
 * fails CLOSED (no send, job redelivers) — we never text a possibly-opted-out
 * number on a transient read error.
 *
 * Exported: the tour-reminder GROUP route (tourReminders.ts) sends direct
 * per-member adapter messages exactly like relay.intro does, so it shares
 * this suppression rule (one source of truth, no drift).
 */
export async function isMemberSuppressed(
  contacts: ContactsRepo,
  member: ConversationParticipant,
): Promise<boolean> {
  const contact =
    typeof member.contactId === 'string' && member.contactId.length > 0
      ? await contacts.getById(member.contactId)
      : await contacts.findByPhone(member.phone);
  return contact?.sms_opt_out === true;
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
    const body = typeof sourceMessage.body === 'string' ? sourceMessage.body : '';
    // Media both directions (design Sec 7): the source's DURABLE attachment keys
    // (a team MMS's hub attachments, or a member's mirrored inbound MMS keys) are
    // re-presigned PER LEG below and forwarded to the other members.
    const sourceMedia = mediaAttachmentsOf(sourceMessage);
    const hasMedia = sourceMedia.length > 0;

    // Resolve CURRENT membership at execution time (a mid-thread remove must
    // take effect on the very next fan-out). Sender is excluded by key.
    const roster = (conversation.participants ?? []) as ConversationParticipant[];
    const senderMember = roster.find((m) => relayMemberKey(m) === payload.senderKey);
    // FIX 2: a TEAM message carries an explicit override label (no member
    // sender, senderKey matches nobody so no member is excluded); a normal
    // member-relayed message derives the prefix from the sender's name.
    const senderName = payload.senderNameOverride ?? senderMember?.name;

    // Body for the leg: text (with the "<name>: " prefix) rides media along; a
    // MEDIA-ONLY source uses the relay.media_only catalog copy (no hard-coded
    // string). A source with NEITHER text NOR media is the only true no-op.
    const senderLabel =
      senderName && senderName.trim().length > 0 ? senderName : ANONYMOUS_SENDER_LABEL;
    let relayBody: string;
    if (body.length > 0) {
      relayBody = composeRelayBody(senderName, body);
    } else if (hasMedia) {
      relayBody = resolveMessage('relay.media_only', { name: senderLabel });
    } else {
      // Nothing to relay - never send an empty body.
      log.info(
        { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId },
        'relayFanOut: source has neither text nor media - nothing relayed',
      );
      return;
    }
    if (hasMedia && !mediaStore) {
      // Degenerate no-bucket config: relay the text notice, but there is no
      // store to presign the media from. Log once (IDs/counts only).
      log.warn(
        { conversationId: payload.relayConversationId, tsMsgId: payload.sourceTsMsgId, mediaCount: sourceMedia.length },
        'relayFanOut: source has media but no MediaStore - relaying body only, media dropped',
      );
    }

    let recipients = roster.filter((m) => relayMemberKey(m) !== payload.senderKey);
    if (payload.recipientKeys !== undefined) {
      const allowed = new Set(payload.recipientKeys);
      recipients = recipients.filter((m) => allowed.has(relayMemberKey(m)));
    }

    const transientRemaining: string[] = [];
    let sentCount = 0;

    for (const member of recipients) {
      const key = relayMemberKey(member);
      const priorSlot = sourceMessage.delivery_recipients?.[key];
      if (isTerminal(priorSlot?.status)) {
        continue; // already delivered/sent/failed — never double-send
      }

      // Opt-out suppression: relay bypasses the 1:1 sendMessage opt-out gate, so
      // enforce STOP here — an opted-out member is NEVER relayed to. Mark the
      // slot failed/contact_opted_out (terminal → a continuation skips it, no
      // retry) so the thread + Today attention surface can show the member is
      // suppressed. A repo failure propagates (fail CLOSED → job redelivers).
      if (await isMemberSuppressed(contacts, member)) {
        await markRecipient(messages, payload, key, {
          status: 'failed',
          errorCode: 'contact_opted_out',
        });
        // Annotate the conversation so staff get a Today attention item linking
        // to the member's contact page (they investigate/remove there). BEST-
        // EFFORT: a failure to annotate must NEVER break the fan-out. PII: log
        // IDs/keys only — the stored phone/name are DATA (for display), not a log.
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
            { err, conversationId: payload.relayConversationId, memberKey: key },
            'relayFanOut: annotating conversation with member opt-out failed — continuing',
          );
        }
        log.info(
          { conversationId: payload.relayConversationId, memberKey: key },
          'relayFanOut: recipient opted out (sms_opt_out) — skipped, not sent',
        );
        continue;
      }

      // A2P meter (FIX 6): ONE token per real outbound SMS — acquired here,
      // per recipient, inside the handler (the correct per-message meter; the
      // producers do not throttle). Paces the fan-out under the registered tier.
      await deps.tokenBucket?.acquire(1);

      // Presign the source media FRESH for THIS leg (design Sec 7: per leg, at
      // leg-send time - a paced roster or backed-off continuation must never
      // hand Twilio an expired URL). Presigned URLs are bearer tokens: passed to
      // the adapter, never logged (the leg logs member keys / counts only).
      let legMediaUrls: string[] | undefined;
      if (hasMedia && mediaStore) {
        const store = mediaStore; // pin for the closure (mediaStore is a let)
        legMediaUrls = await Promise.all(
          sourceMedia.map((a) => store.presign(a.s3Key, RELAY_PRESIGN_TTL_SECONDS)),
        );
      }

      let result;
      try {
        result = await adapter.sendMessage({
          to: member.phone,
          from: poolNumber,
          body: relayBody,
          ...(legMediaUrls !== undefined && { mediaUrls: legMediaUrls }),
        });
      } catch (err) {
        if (err instanceof SendRefusedError) {
          // Opt-out / breaker / manual — by-design refusal for THIS recipient.
          await markRecipient(messages, payload, key, { status: 'failed', errorCode: err.code });
          log.warn({ conversationId: payload.relayConversationId, memberKey: key, refusal: err.code }, 'relayFanOut: send refused for recipient — marked failed, continuing');
          continue;
        }
        // Provider-shaped error: classify by code when present.
        const code = errorCodeOf(err);
        if (code === CARRIER_FILTERED_CODE) {
          await markRecipient(messages, payload, key, { status: 'failed', errorCode: code });
          log.error({ conversationId: payload.relayConversationId, memberKey: key, errorCode: code }, 'relayFanOut: carrier filtering (30007) — recipient failed, NOT retried');
          continue;
        }
        if (code !== undefined && TRANSIENT_CODES.has(code)) {
          // Defer this recipient to a backed-off continuation; keep the slot
          // 'queued' so the continuation re-sends it.
          await markRecipient(messages, payload, key, { status: 'queued', errorCode: code });
          transientRemaining.push(key);
          log.warn({ conversationId: payload.relayConversationId, memberKey: key, errorCode: code, attempt: payload.attempt }, 'relayFanOut: transient send error — deferring recipient to continuation');
          continue;
        }
        // Unknown error: leave the recipient queued and let the job FAIL so
        // SQS redelivers the whole envelope (the marker is per-jobId; the
        // redelivery is a fresh jobId via the visibility timeout).
        throw err;
      }

      // Success: record the per-recipient send result + the relaysid pointer.
      const delivery: RelayRecipientDelivery = {
        status: result.status === 'queued' ? 'queued' : 'sent',
        sid: result.providerSid,
        sentAt: result.providerTs,
      };
      await markRecipient(messages, payload, key, delivery);
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

    // Transient continuation: re-enqueue the remaining recipients with backoff,
    // capped. enqueue() with runAt routes through SQS DelaySeconds (5/10/20s is
    // well within the 12min cap), so the backoff is EXACT — no EventBridge 60s
    // floor inflating a 5s wait to 60s.
    if (transientRemaining.length > 0) {
      const nextAttempt = (payload.attempt ?? 1) + 1;
      if (nextAttempt > MAX_FANOUT_ATTEMPTS) {
        // Cap reached: mark the still-deferred recipients failed so the thread
        // shows the honest outcome (no silent black hole).
        for (const key of transientRemaining) {
          await markRecipient(messages, payload, key, { status: 'failed', errorCode: 'transient_cap' });
        }
        log.error(
          { conversationId: payload.relayConversationId, deferred: transientRemaining.length, attempt: payload.attempt },
          'relayFanOut: transient retry cap reached — remaining recipients marked failed',
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
  });

  // relay.intro (M1.7): on relay-group creation, announce the group to each
  // member FROM the pool number, throttled by the shared bucket. The intro
  // names everyone connected (display names where known, never a phone). Not
  // persisted as a relayed message — it is a system announcement; idempotent
  // via the job execution marker so a redelivery never re-texts everyone.
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

    const conversation = await conversations.getById(payload.relayConversationId);
    const poolNumber = conversation?.pool_number;
    if (!conversation || typeof poolNumber !== 'string' || poolNumber.length === 0) {
      log.warn({ conversationId: payload.relayConversationId }, 'relayIntro: relay conversation/pool number missing — skipping');
      return;
    }
    const roster = (conversation.participants ?? []) as ConversationParticipant[];
    const body = composeIntroBody(roster.map((m) => m.name));
    let sentCount = 0;
    for (const member of roster) {
      await deps.tokenBucket?.acquire(1);
      try {
        // Opt-out suppression: skip an opted-out member (the intro is a
        // first-contact send — never text a STOP'd number). A repo error is
        // caught below and skips this member (fail CLOSED for the intro).
        if (await isMemberSuppressed(contacts, member)) {
          log.info(
            { conversationId: payload.relayConversationId, memberKey: relayMemberKey(member) },
            'relayIntro: member opted out (sms_opt_out) — intro skipped',
          );
          continue;
        }
        await adapter.sendMessage({ to: member.phone, from: poolNumber, body });
        sentCount += 1;
      } catch (err) {
        // One member's intro failure must not block the others.
        log.error({ err, conversationId: payload.relayConversationId, memberKey: relayMemberKey(member) }, 'relayIntro: intro send failed for a member — continuing');
      }
    }
    log.info({ conversationId: payload.relayConversationId, memberCount: roster.length, sentCount }, 'relay intro sent');
  });
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
