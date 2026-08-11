// The CONVERSATION CROSS-CHECK (spec 8 mechanism 2, as amended by 16.1).
//
// THE FAILURE THIS EXISTS TO MAKE LOUD. Group detection reads
// `OtherRecipients{N}` off the classic messaging webhook - an UNDOCUMENTED
// Twilio parameter. If Twilio ever stops sending it, detection stops, every
// carrier group silently files as a 1:1 (or as three 1:1s), and nothing in the
// app looks broken. The tripwire (mechanism 1) catches only the media-less
// shape. This mechanism watches the same traffic through a SECOND, independent
// channel: the service-scoped Conversations webhook, whose carrier-sourced
// `onMessageAdded` events arrive because the message bound to a rail - a path
// that has nothing to do with `OtherRecipients`.
//
// IT IS A HEURISTIC AND IT SAYS SO. `onMessageAdded` carries no SM/MM
// identifier (external review finding 5; the S5-PRE addendum confirmed the live
// payload), so there is NO deterministic join between an event and the classic
// inbound that should have accompanied it. What is matched is a COUNT per
// (rail, author) pair, in arrival order, with a grace deadline:
//
//   - an event with no classic filing yet becomes PENDING with a deadline;
//   - a classic filing consumes the OLDEST pending event for its pair;
//   - a classic filing that arrives FIRST banks a CREDIT, which the event then
//     consumes (the two webhooks fire off one carrier message, so either can
//     win the race and neither order is a fault);
//   - a credit older than the match window is NOT consumable, so a quiet period
//     cannot bank credits that mask a later genuine miss;
//   - anything still pending past its deadline alarms ONCE, from the T6.3 sweep.
//
// COVERAGE, HONESTLY (spec 8). The cross-check sees only threads that HAVE a
// rail. Under eager creation that is every converted group from migration day
// and every detected group within seconds - but the brief pre-rail window and
// rail-ineligible threads (a >9 roster) fall back to mechanisms 1 and 3.
//
// THE ACCOUNT-GLOBAL WEBHOOK IS NOT USED (spec 16.1). Configuring a
// service-scoped webhook silences the global scope entirely - proved live. Both
// filters ride the ONE service-scoped URL, and this half consumes the
// `onMessageAdded` the S5 route dispatches to it.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { loadConfig, type AppConfig } from '../lib/config.js';
import {
  createMessagesRepo,
  groupCrossCheckPairKey,
  GROUP_CROSSCHECK_CLEANUP_MS,
  GROUP_CROSSCHECK_CREDIT_MS,
  GROUP_CROSSCHECK_DUE_KIND,
  GROUP_CROSSCHECK_GRACE_MS,
  GROUP_DUE_PARTITION,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import {
  createSettingsRepo,
  GROUP_CROSSCHECK_LAST_EVENT_AT_ID,
  type SettingsRepo,
} from '../repos/settingsRepo.js';
import { groupMemberKey } from './groupMembers.js';
import type { ConversationsMessageAddedEvent } from '../routes/webhooks/twilioConversations.js';

/** One alarm raised by the deadline sweep. */
export interface CrossCheckAlarm {
  messageSid: string;
  conversationSid: string;
  author: string;
  deadlineAt: string;
}

export interface CrossCheckSweepOutcome {
  /** Due rows examined (both kinds - the partition is shared). */
  scanned: number;
  alarms: CrossCheckAlarm[];
}

export interface ClassicInboundRecord {
  /** CHxx of the rail the thread is bound to. */
  conversationSid: string;
  /** `phone#<E164>` of the SENDER (spec 15.6 member keys are phone-scoped). */
  memberKey: string;
  /** The classic provider SID, for the log line only. */
  providerSid?: string;
}

export interface GroupCrossCheck {
  /** The `onMessageAdded` half of the shared Conversations route. */
  recordConversationEvent(event: ConversationsMessageAddedEvent): Promise<void>;
  /** Called when a group inbound is FILED onto a railed thread. Never throws. */
  recordClassicInbound(record: ClassicInboundRecord): Promise<void>;
  /** The T6.3 grace-deadline sweep. */
  sweepCrossCheckDeadlines(nowIso: string): Promise<CrossCheckSweepOutcome>;
}

export interface GroupCrossCheckDeps {
  messagesRepo?: Pick<
    MessagesRepo,
    | 'claimCrossCheckEvent'
    | 'takeCrossCheckCredit'
    | 'putCrossCheckPending'
    | 'takeCrossCheckPending'
    | 'putCrossCheckCredit'
    | 'resolveCrossCheckPending'
    | 'listDueRows'
  >;
  settingsRepo?: Pick<SettingsRepo, 'putGroupTimestamp' | 'getGroupTimestamp'>;
  config?: AppConfig;
  logger?: Logger;
  /** Our own number - an event authored by it is our post, not carrier traffic. */
  businessNumber?: string;
  now?: () => Date;
  graceMs?: number;
  creditWindowMs?: number;
  cleanupMs?: number;
}

/** How many overdue rows one sweep pass will handle. */
const SWEEP_BATCH = 50;

export function createGroupCrossCheck(deps: GroupCrossCheckDeps = {}): GroupCrossCheck {
  const log = deps.logger ?? defaultLogger;
  const messages =
    deps.messagesRepo ??
    createMessagesRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const settings =
    deps.settingsRepo ??
    createSettingsRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });
  const now = deps.now ?? ((): Date => new Date());
  const graceMs = deps.graceMs ?? GROUP_CROSSCHECK_GRACE_MS;
  const creditWindowMs = deps.creditWindowMs ?? GROUP_CROSSCHECK_CREDIT_MS;
  const cleanupMs = deps.cleanupMs ?? GROUP_CROSSCHECK_CLEANUP_MS;

  function businessNumber(): string | undefined {
    if (deps.businessNumber !== undefined) return deps.businessNumber;
    return (deps.config ?? loadConfig()).businessPhoneNumber;
  }

  /** Epoch SECONDS for the cleanup TTL. Cleanup only - never the alarm (A12). */
  function cleanupAt(from: Date): number {
    return Math.floor((from.getTime() + cleanupMs) / 1000);
  }

  return {
    async recordConversationEvent(event) {
      // FILTER (spec 15.1, confirmed load-bearing by 16.1 item 5). Only
      // carrier-sourced inbound from an EXTERNAL member counts. Our own API
      // posts produce no echo today (X-Twilio-Webhook-Enabled is deliberately
      // unset), but the filter stays as defense in depth: an echo that slipped
      // through would alarm on every single outbound group message.
      if (event.source !== 'SMS') {
        log.info(
          {
            event: 'group_crosscheck_event_ignored',
            reason: 'source',
            source: event.source,
            conversationSid: event.conversationSid,
          },
          'conversations event ignored - not carrier-sourced',
        );
        return;
      }
      const author = event.author ?? '';
      const own = businessNumber();
      if (author.length === 0 || (own !== undefined && author === own)) {
        log.info(
          {
            event: 'group_crosscheck_event_ignored',
            reason: 'author',
            conversationSid: event.conversationSid,
          },
          'conversations event ignored - author is not an external member',
        );
        return;
      }

      const at = now();
      const receivedAt = at.toISOString();
      // LIVENESS HIGH-WATER MARK. Written for every accepted event INCLUDING a
      // redelivery: a redelivery is still proof the channel is carrying traffic,
      // which is the only question this record answers.
      await settings.putGroupTimestamp(GROUP_CROSSCHECK_LAST_EVENT_AT_ID, receivedAt);

      const fresh = await messages.claimCrossCheckEvent(
        event.messageSid,
        { conversationSid: event.conversationSid, author, receivedAt },
        cleanupAt(at),
      );
      if (!fresh) {
        log.info(
          {
            event: 'group_crosscheck_event_duplicate',
            messageSid: event.messageSid,
            conversationSid: event.conversationSid,
          },
          'conversations event already recorded - redelivery ignored',
        );
        return;
      }

      const pairKey = groupCrossCheckPairKey(event.conversationSid, groupMemberKey(author));
      const notBefore = new Date(at.getTime() - creditWindowMs).toISOString();
      if (await messages.takeCrossCheckCredit(pairKey, notBefore)) {
        log.info(
          {
            event: 'group_crosscheck_event_matched',
            reason: 'credit',
            messageSid: event.messageSid,
            conversationSid: event.conversationSid,
          },
          'conversations event matched a classic inbound that arrived first',
        );
        return;
      }

      await messages.putCrossCheckPending(
        {
          pairKey,
          messageSid: event.messageSid,
          conversationSid: event.conversationSid,
          author,
          deadlineAt: new Date(at.getTime() + graceMs).toISOString(),
        },
        cleanupAt(at),
      );
    },

    async recordClassicInbound(record) {
      // NEVER throws: this runs inside the inbound webhook, and a cross-check
      // bookkeeping failure must not cost us a real message.
      try {
        const pairKey = groupCrossCheckPairKey(record.conversationSid, record.memberKey);
        const pending = await messages.takeCrossCheckPending(pairKey);
        if (pending !== undefined) {
          log.info(
            {
              event: 'group_crosscheck_event_matched',
              reason: 'filed',
              messageSid: pending.messageSid,
              conversationSid: record.conversationSid,
            },
            'conversations event matched by the classic inbound it predicted',
          );
          return;
        }
        const at = now();
        await messages.putCrossCheckCredit(
          pairKey,
          at.toISOString(),
          record.providerSid ?? at.getTime().toString(),
          cleanupAt(at),
        );
      } catch (err) {
        log.warn(
          {
            err,
            event: 'group_crosscheck_filing_failed',
            conversationSid: record.conversationSid,
          },
          'cross-check bookkeeping failed for a filed group inbound - message unaffected',
        );
      }
    },

    async sweepCrossCheckDeadlines(nowIso) {
      // Normalized: sort keys are compared LEXICOGRAPHICALLY, so '...00Z' and
      // '...00.000Z' must collapse to one form.
      const through = new Date(nowIso).toISOString();
      const due = await messages.listDueRows(GROUP_DUE_PARTITION, through, SWEEP_BATCH);
      const alarms: CrossCheckAlarm[] = [];
      for (const row of due) {
        if (row.kind !== GROUP_CROSSCHECK_DUE_KIND) continue;
        const alarm: CrossCheckAlarm = {
          messageSid: row.providerSid ?? '',
          conversationSid: row.conversationSid ?? '',
          author: row.author ?? '',
          deadlineAt: row.deadlineAt,
        };
        // THE ALARM. ERROR, because this is the one signal that says the
        // undocumented envelope may have gone away: a message reached the
        // Conversation and never reached the classic webhook.
        log.error(
          {
            event: 'group_crosscheck_inbound_missing',
            messageSid: alarm.messageSid,
            conversationSid: alarm.conversationSid,
            deadlineAt: alarm.deadlineAt,
          },
          'conversation-bound inbound missing from classic webhook',
        );
        // Resolve BEFORE returning so the alarm fires exactly once. A
        // base-table partition has no sparse-index trick: the rows must go.
        await messages.resolveCrossCheckPending(
          row.ref.conversationId,
          alarm.messageSid,
          row.deadlineAt,
        );
        alarms.push(alarm);
      }
      return { scanned: due.length, alarms };
    },
  };
}
