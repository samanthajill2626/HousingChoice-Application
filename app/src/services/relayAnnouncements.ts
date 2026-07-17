// Relay-group SYSTEM ANNOUNCEMENTS — the one chain behind every app-authored
// group send (the relay.intro welcome + the tour-reminder group rungs).
//
// Founder decision 2026-07-14: everything sent into a group text MUST be
// visible in its dashboard thread. Announcements previously sent per-member
// provider messages and persisted NOTHING, so the thread showed an empty
// timeline while members' phones received texts. This service persists the
// announcement ONCE as an outbound source message (relay_sender_key 'system',
// per-member delivery slots seeded 'queued' — the team-send shape), then sends
// one provider message per member FROM the pool number, recording each send in
// its slot + a relaysid pointer so delivery callbacks finalize the rollup chip
// exactly like a team message.
//
// The body is sent VERBATIM (announcements carry their own identity/STOP
// language) — never the relayed "<name>: " prefix.
//
// `persist: false` is the dev replay seam's mode (POST /__dev/relay/replay-
// intros re-fires intros at every boot to materialize fake-phones groups; it
// must never grow the seeded threads) — legs send, nothing is written.
//
// PII (doc §9): logs conversationId/memberKey/counts only — never a phone,
// name, or the body.
import { randomUUID } from 'node:crypto';
import type { MessagingAdapter } from '../adapters/messaging.js';
import { appEvents, toConversationUpdatedEvent, type EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import type { ContactsRepo } from '../repos/contactsRepo.js';
import type {
  ConversationParticipant,
  ConversationsRepo,
} from '../repos/conversationsRepo.js';
import {
  relayMemberKey,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';
import { SendRefusedError } from './sendMessage.js';

/**
 * relay_sender_key sentinel for a SYSTEM announcement: matches no member and
 * is not the 'team' sentinel, so the dashboard renders its own attribution
 * label ("Automated") instead of a member name or "Team".
 */
export const SYSTEM_SENDER_KEY = 'system';

/**
 * Opt-out suppression for a relay recipient (spec §6 / doc §7.1). Relay sends
 * go STRAIGHT to the adapter — the 1:1 `sendMessage` opt-out gate targets the
 * thread's participant_phone (the pool number), not the individual member, so
 * it never fires here. STOP suppression MUST therefore be re-enforced at this
 * seam or an opted-out member would keep receiving relayed messages. A member
 * who STOP'd carries contact-level `sms_opt_out` (the same signal the 1:1 +
 * broadcast gates read). Resolves the member's contact by id (phone fallback).
 * Deliberately NOT wrapped in try/catch: a repo failure propagates so the
 * caller fails CLOSED (no send) — we never text a possibly-opted-out number on
 * a transient read error.
 *
 * Canonical home (moved from relayFanOut.ts so this service never imports from
 * jobs/ — relayFanOut re-exports it for its fan-out loop + tourReminders).
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

export interface RelayAnnouncementDeps {
  conversationsRepo: ConversationsRepo;
  messagesRepo: MessagesRepo;
  contactsRepo: ContactsRepo;
  adapter: MessagingAdapter;
  /** Shared A2P pacing bucket — one token per real outbound SMS. */
  tokenBucket?: { acquire(n: number): Promise<void> };
  /** Live-update bus (defaults to the appEvents singleton). */
  events?: EventBus;
  logger?: Logger;
}

export interface RelayAnnouncementInput {
  conversationId: string;
  /** Fully-composed announcement text — sent verbatim to every member. */
  body: string;
  /** Log/observability tag for the announcement ('relay.intro', 'tour.day_before', …). */
  kind: string;
  /** false = legs-only (dev intro replay): send, persist nothing. Default true. */
  persist?: boolean;
}

export interface RelayAnnouncementResult {
  /** SK of the persisted announcement row; absent in legs-only mode. */
  tsMsgId?: string;
  sentCount: number;
}

/**
 * Log-safe member key (doc §9): the contactId when the member has one, else a
 * redaction constant. NOT relayMemberKey() — its `phone#<E164>` fallback for
 * contact-less members would put a raw phone number in the log line.
 */
function logSafeMemberKey(member: { contactId?: string }): string {
  return member.contactId !== undefined && member.contactId.length > 0
    ? member.contactId
    : 'phone-only-member';
}

/**
 * Send a system announcement into a relay group. Returns undefined (and sends
 * nothing) when the conversation is not a usable open relay group — callers
 * treat that as a logged no-op, matching the old intro behavior.
 *
 * Per-member failures mark the slot failed and CONTINUE (announcements are
 * never retried — the accepted intro/reminder tradeoff); a persistence failure
 * before any send propagates (nothing was sent, the caller may retry).
 */
export async function sendRelayAnnouncement(
  deps: RelayAnnouncementDeps,
  input: RelayAnnouncementInput,
): Promise<RelayAnnouncementResult | undefined> {
  const log = deps.logger ?? defaultLogger;
  const events = deps.events ?? appEvents;
  const { conversationId, body, kind } = input;
  const persist = input.persist !== false;

  const conversation = await deps.conversationsRepo.getById(conversationId);
  const poolNumber = conversation?.pool_number;
  const roster = (conversation?.participants ?? []) as ConversationParticipant[];
  // HARDENING (spec 4.4): `status` is now the authoritative closed-gate. Because
  // pool_number NEVER clears (burn-multiplexing keeps a closed group resolvable),
  // a CLOSED group still carries its number, so a pool_number-presence check
  // alone would let announcements leak into a closed thread. Gate on status.
  if (
    !conversation ||
    conversation.type !== 'relay_group' ||
    conversation.status !== 'open' ||
    typeof poolNumber !== 'string' ||
    poolNumber.length === 0 ||
    roster.length === 0
  ) {
    log.warn(
      { conversationId, kind },
      'relayAnnouncement: conversation unusable (missing/not relay_group/no pool number/empty roster) — skipping',
    );
    return undefined;
  }

  // Persist the announcement ONCE, slots seeded 'queued' for every member
  // (the team-send shape: the parent delivery_recipients map must exist before
  // the first per-recipient child SET). Emit the live-surface events BEFORE the
  // paced member sends so the dashboard bubble appears immediately and the
  // rollup chip counts up as legs land.
  let tsMsgId: string | undefined;
  const providerTs = new Date().toISOString();
  if (persist) {
    const deliveryRecipients: Record<string, RelayRecipientDelivery> = {};
    for (const member of roster) {
      deliveryRecipients[relayMemberKey(member)] = { status: 'queued' };
    }
    const providerSid = `system-${randomUUID()}`;
    const appended = await deps.messagesRepo.append({
      conversationId,
      providerSid,
      providerTs,
      type: 'sms',
      direction: 'outbound',
      author: 'system',
      deliveryStatus: 'queued',
      relaySenderKey: SYSTEM_SENDER_KEY,
      deliveryRecipients,
      body,
    });
    tsMsgId = appended.tsMsgId;

    // Inbox preview + thread refetch nudges — best-effort (the announcement is
    // persisted; a stale inbox row must not block the sends).
    try {
      const touched = await deps.conversationsRepo.touchLastActivity(
        conversationId,
        body,
        providerTs,
      );
      if (touched) events.emit('conversation.updated', toConversationUpdatedEvent(touched));
    } catch (err) {
      log.error({ err, conversationId, kind }, 'relayAnnouncement: touchLastActivity failed — inbox stale');
    }
    events.emit('message.persisted', {
      conversationId,
      tsMsgId,
      direction: 'outbound',
      deliveryStatus: 'queued',
    });
  }

  let sentCount = 0;
  for (const member of roster) {
    const memberKey = relayMemberKey(member);
    try {
      // Opt-out suppression: never text a STOP'd member. In persist mode the
      // slot is marked failed/contact_opted_out (terminal; the rollup chip
      // excludes opted-out slots from its totals). A suppression-read failure
      // is caught below and skips this member WITHOUT sending (fail CLOSED).
      if (await isMemberSuppressed(deps.contactsRepo, member)) {
        if (persist && tsMsgId !== undefined) {
          await markSlot(deps.messagesRepo, conversationId, tsMsgId, memberKey, {
            status: 'failed',
            errorCode: 'contact_opted_out',
          });
        }
        log.info(
          { conversationId, kind, memberKey: logSafeMemberKey(member) },
          'relayAnnouncement: member opted out (sms_opt_out) — skipped',
        );
        continue;
      }

      // A2P pacing: one token per real outbound SMS (shared combined-rate
      // bucket — same meter as the relay fan-out legs).
      await deps.tokenBucket?.acquire(1);
      const result = await deps.adapter.sendMessage({
        to: member.phone,
        from: poolNumber,
        body,
      });
      sentCount += 1;

      if (persist && tsMsgId !== undefined) {
        await markSlot(deps.messagesRepo, conversationId, tsMsgId, memberKey, {
          status: result.status === 'queued' ? 'queued' : 'sent',
          sid: result.providerSid,
          sentAt: result.providerTs,
        });
        // relaysid pointer → the per-recipient delivery callback finds this
        // slot, so the announcement's rollup chip finalizes like a team send.
        await deps.messagesRepo.putRelaySidPointer(result.providerSid, {
          conversationId,
          tsMsgId,
          memberKey,
        });
      }
    } catch (err) {
      // One member's failure must not block the others. In persist mode the
      // slot goes terminal-failed so the thread shows the honest outcome.
      if (persist && tsMsgId !== undefined) {
        try {
          await markSlot(deps.messagesRepo, conversationId, tsMsgId, memberKey, {
            status: 'failed',
            errorCode: err instanceof SendRefusedError ? err.code : (errorCodeOf(err) ?? 'send_failed'),
          });
        } catch (markErr) {
          log.error(
            { err: markErr, conversationId, kind, memberKey: logSafeMemberKey(member) },
            'relayAnnouncement: marking failed slot failed — continuing',
          );
        }
      }
      log.error(
        { err, conversationId, kind, memberKey: logSafeMemberKey(member) },
        'relayAnnouncement: send failed for a member — continuing',
      );
    }
  }

  log.info(
    { conversationId, kind, memberCount: roster.length, sentCount, persisted: persist },
    'relay announcement sent',
  );
  return { ...(tsMsgId !== undefined && { tsMsgId }), sentCount };
}

/** Persist one recipient's delivery slot on the announcement row. */
async function markSlot(
  messages: MessagesRepo,
  conversationId: string,
  tsMsgId: string,
  memberKey: string,
  delivery: RelayRecipientDelivery,
): Promise<void> {
  await messages.setRecipientDelivery(conversationId, tsMsgId, memberKey, delivery);
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
