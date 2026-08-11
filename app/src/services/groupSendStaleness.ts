// T6.4 - the per-send delivery-staleness alarm.
//
// WHY THIS IS LOAD-BEARING. The S5-PRE addendum proved (live) that classic
// Programmable Messaging status callbacks do NOT fire for Conversations-
// originated sends: delivery state arrives SOLELY as service-scoped
// `onDeliveryUpdated`. So there is no second delivery channel, and a receipts
// webhook that dies - misconfigured URL, rotated auth token, a filter someone
// removed in the console - is completely silent. Every group send would look
// "sent" forever and nobody would know. This sweep is the ONLY detector of that
// failure.
//
// THE PREDICATE IS NOT relayFanOut.isTerminal (worklist A18). That one counts
// `sent` as terminal and omits `undelivered` - both wrong here. `sent` means the
// message left Twilio, NOT that it arrived, and a receipts webhook that dies
// after the `sent` transition is EXACTLY the failure this alarm exists to
// catch. The group-local terminal set is {delivered, failed, undelivered}.
//
// THE DUE ROW IS TRANSACTIONAL WITH THE APPEND (S5/T5.2, worklist A13), so a
// crash anywhere after the message row exists still leaves the send monitored -
// there is no window where a message is stored and unwatched. Its `expires_at`
// is a 30-day CLEANUP horizon far past the 10-minute alarm deadline (A12): TTL
// is best-effort and up to 48h late, so it can only ever reap a row the sweep
// already had every chance to act on. TTL is never the alarm.
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import {
  createMessagesRepo,
  GROUP_DUE_PARTITION,
  GROUP_SEND_DUE_KIND,
  type MessageItem,
  type MessagesRepo,
  type RelayRecipientDelivery,
} from '../repos/messagesRepo.js';

/**
 * Terminal for THIS alarm: the leg reached the handset, or Twilio told us it
 * never will. `queued` and `sent` are NON-terminal - a slot stuck at `sent` is
 * the silent-webhook symptom itself.
 */
export const GROUP_TERMINAL_DELIVERY_STATUSES: ReadonlySet<string> = new Set([
  'delivered',
  'failed',
  'undelivered',
]);

export function isGroupDeliveryTerminal(status: string | undefined): boolean {
  return status !== undefined && GROUP_TERMINAL_DELIVERY_STATUSES.has(status);
}

export type StalenessOutcome =
  /** At least one slot is still non-terminal past the deadline. */
  | 'alarmed'
  /** Every slot reached a terminal state - the due row is resolved. */
  | 'cleared'
  /** The message row is gone (retention, a deleted thread) - resolve and move on. */
  | 'missing';

export interface StalenessCheck {
  outcome: StalenessOutcome;
  /** Member keys still non-terminal, with the status they are stuck at. */
  stuck: Array<{ memberKey: string; status: string }>;
}

export interface GroupSendStalenessService {
  /**
   * Check ONE group send. Exposed directly for the `__dev` seam, which lets an
   * e2e spec drive the alarm for a known message instead of waiting out a
   * ten-minute deadline.
   */
  checkMessage(ref: {
    conversationId: string;
    tsMsgId: string;
    providerSid?: string;
  }): Promise<StalenessCheck>;
  /** The T6.3 duty: every overdue send due-row, alarmed or cleared. */
  sweepSendStaleness(nowIso: string): Promise<{
    scanned: number;
    alarmed: number;
    cleared: number;
  }>;
}

export interface GroupSendStalenessDeps {
  messagesRepo?: Pick<MessagesRepo, 'getByTsMsgId' | 'listDueRows' | 'deleteDueRow'>;
  logger?: Logger;
}

/** How many overdue send rows one sweep pass will handle. */
const SWEEP_BATCH = 50;

function slotsOf(message: MessageItem): Array<[string, RelayRecipientDelivery]> {
  const map = message.delivery_recipients ?? {};
  return Object.entries(map);
}

export function createGroupSendStaleness(
  deps: GroupSendStalenessDeps = {},
): GroupSendStalenessService {
  const log = deps.logger ?? defaultLogger;
  const messages =
    deps.messagesRepo ??
    createMessagesRepo({ ...(deps.logger !== undefined && { logger: deps.logger }) });

  async function check(ref: {
    conversationId: string;
    tsMsgId: string;
  }): Promise<StalenessCheck> {
    // The due row carries the message's exact primary key, so this is a POINT
    // GET - no query, no scan, one read per overdue send.
    const message = await messages.getByTsMsgId(ref.conversationId, ref.tsMsgId);
    if (message === undefined) return { outcome: 'missing', stuck: [] };
    // Spec 15.9: the map is SEEDED at send time and is never empty, so an
    // "empty map" branch would be dead code. A genuinely empty map here means
    // the seed itself failed, which is a real non-terminal state - report it.
    const stuck = slotsOf(message)
      .filter(([, slot]) => !isGroupDeliveryTerminal(slot.status))
      .map(([memberKey, slot]) => ({ memberKey, status: slot.status }));
    return { outcome: stuck.length > 0 ? 'alarmed' : 'cleared', stuck };
  }

  return {
    async checkMessage(ref) {
      return check(ref);
    },

    async sweepSendStaleness(nowIso) {
      // Normalized: the sort key is compared LEXICOGRAPHICALLY, so '...00Z' and
      // '...00.000Z' must collapse to one form.
      const through = new Date(nowIso).toISOString();
      const due = await messages.listDueRows(GROUP_DUE_PARTITION, through, SWEEP_BATCH);
      let alarmed = 0;
      let cleared = 0;
      for (const row of due) {
        if (row.kind !== GROUP_SEND_DUE_KIND) continue;
        const result = await check(row.ref);
        if (result.outcome === 'alarmed') {
          alarmed += 1;
          log.error(
            {
              event: 'group_send_receipts_stale',
              conversationId: row.ref.conversationId,
              providerSid: row.providerSid,
              stuck: result.stuck.length,
              statuses: [...new Set(result.stuck.map((s) => s.status))],
            },
            'group delivery receipts silent - check Conversations service webhook config',
          );
        } else {
          cleared += 1;
        }
        // Resolve either way: an alarmed send has raised its ONE alarm, and a
        // cleared send has nothing left to watch. Leaving the row would alarm
        // the same send on every sweep from here to the TTL horizon.
        await messages.deleteDueRow(row.partition, row.sortKey);
      }
      return { scanned: due.length, alarmed, cleared };
    },
  };
}
