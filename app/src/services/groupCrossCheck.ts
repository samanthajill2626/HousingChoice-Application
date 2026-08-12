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
// THE LEDGER IS A CLAIM, NOT A CHECK-THEN-ACT (fix wave 5, adversarial 3/9).
// "Either can win the race and neither order is a fault" is the stated intent,
// and the first implementation only delivered it for STRICTLY ORDERED wins:
// each half Queried (eventually consistent) for the other half's row and then
// deleted it unconditionally without inspecting the result. Two webhooks fired
// by ONE carrier message could each miss the other - by a true interleave or by
// read lag alone - banking a credit AND a pending row for the same message,
// which raised `group_crosscheck_inbound_missing` at ERROR on healthy traffic
// and left an orphaned credit to absorb a LATER genuine miss. False firing
// "trains the operator to ignore the one alarm that matters" (groupDelivery.ts),
// and this is the only detector of `OtherRecipients` disappearing.
//
// So matching is decided by ONE strongly-consistent atomic `ADD` on a single
// per-pair state item carrying a signed balance (positive = events awaiting
// their filings, negative = filings banked as credits). Both halves move the
// same counter, so neither can miss the other and neither can double-consume;
// the `evt#` rows survive only as the alarm index, claimed with a
// ConsistentRead plus a CONDITIONAL delete whose result is checked.
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
  GROUP_CROSSCHECK_DUE_PARTITION,
  GROUP_CROSSCHECK_GRACE_MS,
  type MessagesRepo,
} from '../repos/messagesRepo.js';
import { normalizeToE164 } from '../lib/phone.js';
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
  /** Due rows examined from the cross-check's own deadline partition. */
  scanned: number;
  alarms: CrossCheckAlarm[];
}

/**
 * THE ONE PAIR-KEY BUILDER, used by BOTH halves of the ledger.
 *
 * The match only works if the classic side and the Conversations side produce
 * the IDENTICAL string, and they derive it from different Twilio params
 * (`From` vs the event `Author`). Spec 4.1 makes normalization part of the
 * contract, so it happens HERE rather than at two call sites that can drift: a
 * single non-canonical address would otherwise send every event for that member
 * pending and alarm `group_crosscheck_inbound_missing` on healthy traffic.
 */
export function groupCrossCheckMemberKey(author: string): string {
  return groupMemberKey(normalizeToE164(author) ?? author);
}

export interface ClassicInboundRecord {
  /** CHxx of the rail the thread is bound to. */
  conversationSid: string;
  /**
   * The SENDER's RAW address (the webhook's `From`). Normalized into a member
   * key by `groupCrossCheckMemberKey` here, NEVER by the caller - see above.
   */
  author: string;
  /** The classic provider SID. The ledger's dedupe key, and the log line. */
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
    | 'claimCrossCheckClassic'
    | 'bumpCrossCheckEvent'
    | 'bumpCrossCheckClassic'
    | 'releaseCrossCheckPending'
    | 'putCrossCheckPending'
    | 'claimOldestCrossCheckPending'
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

      const pairKey = groupCrossCheckPairKey(
        event.conversationSid,
        groupCrossCheckMemberKey(author),
      );
      const notBefore = new Date(at.getTime() - creditWindowMs).toISOString();
      const deadlineAt = new Date(at.getTime() + graceMs).toISOString();

      // ROW FIRST, THEN THE BALANCE (fix wave 5, adversarial 3/9). The classic
      // half claims a pending ROW whenever the balance says one exists, so the
      // row must be durable BEFORE the bump that says so - otherwise a classic
      // filing in between would find the balance positive and the row absent.
      // The cost of that ordering is this: when the bump turns out to land on a
      // banked credit, the row we just wrote is retracted below. A crash in that
      // sub-second window leaves one due row that alarms in `graceMs` - strictly
      // better than the old design, where the SAME window produced both a false
      // alarm AND an orphaned credit that masked a later real one.
      await messages.putCrossCheckPending(
        {
          pairKey,
          messageSid: event.messageSid,
          conversationSid: event.conversationSid,
          author,
          deadlineAt,
        },
        cleanupAt(at),
      );

      const landed = await messages.bumpCrossCheckEvent(
        pairKey,
        notBefore,
        at.toISOString(),
        cleanupAt(at),
      );
      if (landed === 'credit') {
        await messages.resolveCrossCheckPending(pairKey, event.messageSid, deadlineAt);
        log.info(
          {
            event: 'group_crosscheck_event_matched',
            reason: 'credit',
            messageSid: event.messageSid,
            conversationSid: event.conversationSid,
          },
          'conversations event matched a classic inbound that arrived first',
        );
      }
    },

    async recordClassicInbound(record) {
      // NEVER throws: this runs inside the inbound webhook, and a cross-check
      // bookkeeping failure must not cost us a real message.
      try {
        const memberKey = groupCrossCheckMemberKey(record.author);
        const pairKey = groupCrossCheckPairKey(record.conversationSid, memberKey);
        const at = now();
        // DEDUPE, SYMMETRIC WITH THE CONVERSATIONS HALF. Twilio redelivers the
        // messaging webhook, and this step is NOT idempotent on its own: the
        // credit's sort key carries a fresh `filedAt`, so a redelivery banked a
        // SECOND credit for the pair. Nothing ever consumes that phantom - until
        // detection genuinely breaks and an event arrives whose classic filing
        // never came, at which point the phantom absorbs it, no pending row is
        // written and NO ALARM EVER FIRES. That is precisely the failure this
        // guardrail exists to detect, so the classic half must be as
        // dedupe-safe as `claimCrossCheckEvent` already makes the other one.
        if (record.providerSid !== undefined) {
          const fresh = await messages.claimCrossCheckClassic(
            record.providerSid,
            {
              conversationSid: record.conversationSid,
              memberKey,
              filedAt: at.toISOString(),
            },
            cleanupAt(at),
          );
          if (!fresh) {
            log.info(
              {
                event: 'group_crosscheck_classic_duplicate',
                providerSid: record.providerSid,
                conversationSid: record.conversationSid,
              },
              'classic group inbound already recorded in the cross-check ledger - redelivery ignored',
            );
            return;
          }
        }
        // ONE ATOMIC STEP decides matched-or-credit (fix wave 5, adversarial
        // 3/9). It replaces a Query-then-unconditional-Delete that could both
        // miss a row written moments earlier AND let two concurrent filings
        // consume the same one.
        const landed = await messages.bumpCrossCheckClassic(
          pairKey,
          at.toISOString(),
          cleanupAt(at),
        );
        if (landed !== 'matched') return; // credit banked for an event still in flight

        const pending = await messages.claimOldestCrossCheckPending(pairKey);
        if (pending === undefined) {
          // The balance said a pending event existed and its row was not
          // claimable. The event half writes the row BEFORE the bump, so the
          // only way here is a crash between those two writes on the other side.
          // The balance already accounts for this filing; say so and stop.
          log.warn(
            {
              event: 'group_crosscheck_pending_row_missing',
              conversationSid: record.conversationSid,
            },
            'cross-check balance reported a pending event with no claimable row',
          );
          return;
        }
        log.info(
          {
            event: 'group_crosscheck_event_matched',
            reason: 'filed',
            messageSid: pending.messageSid,
            conversationSid: record.conversationSid,
          },
          'conversations event matched by the classic inbound it predicted',
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
      // THE CROSS-CHECK'S OWN PARTITION. It used to share one with the
      // send-staleness sweep and drop the other kind AFTER the Limit was spent,
      // so a backlog of one kind starved the other exactly when both webhooks
      // were most likely broken at once. The kind guard below is now a
      // structural assertion, not a filter: a foreign row here is a bug.
      const due = await messages.listDueRows(
        GROUP_CROSSCHECK_DUE_PARTITION,
        through,
        SWEEP_BATCH,
      );
      const alarms: CrossCheckAlarm[] = [];
      for (const row of due) {
        if (row.kind !== GROUP_CROSSCHECK_DUE_KIND) {
          log.error(
            { event: 'group_due_partition_foreign_row', kind: row.kind, sortKey: row.sortKey },
            'a non-cross-check row is sitting in the cross-check deadline partition',
          );
          continue;
        }
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
        // ...and give the slot back to the pair balance (fix wave 5). We have
        // stopped waiting for this event, so it must stop counting as pending -
        // otherwise a very late classic filing would silently "match" a message
        // we already reported missing, and the ledger would drift by one forever.
        await messages.releaseCrossCheckPending(row.ref.conversationId);
        alarms.push(alarm);
      }
      return { scanned: due.length, alarms };
    },
  };
}
