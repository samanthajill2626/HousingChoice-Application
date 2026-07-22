// Queued fire-and-forget flush (relay number buying strategy T7). A team message
// composed on a CONNECTING relay group is persisted delivery_status
// 'queued_pending' and held (routes/api.ts sendRelayTeamMessage) - the group has
// no dedicated number to send from yet. When relay.numberReady opens the group
// (assignPoolNumberAndOpen) and enqueues the DEFERRED intro, it then calls
// flushQueuedMessages to release the held messages into the NORMAL relay send
// path - in created_at order, so staff see them arrive in the order they were
// composed, right after the intro.
//
// ORDERING CONTRACT: the intro is enqueued by the caller BEFORE this runs; this
// enqueues one relay fan-out per queued message in created_at ASC order. The
// fan-out handler vetoes a non-open group, so the group MUST already be open (it
// is - assignPoolNumberAndOpen flipped it before the caller reached here).
//
// A connecting group carries ONLY these queued_pending composes (it has no number,
// so no intro and no inbound land on it), but we page the whole log and filter
// defensively so a message can never be missed/lost.
//
// PII (doc section 9): logs carry only ids (conversationId) + counts - never a
// member phone/name/body.
import type { Logger } from '../lib/logger.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { createMessagesRepo, type MessageItem, type MessagesRepo } from '../repos/messagesRepo.js';
import { enqueueImmediate } from '../jobs/jobs.js';
import { RELAY_FANOUT_JOB, TEAM_SENDER_KEY, TEAM_SENDER_LABEL } from '../jobs/relayFanOut.js';

/** Page size for the queued-message scan (a connecting group's log is tiny). */
const QUEUED_SCAN_PAGE = 100;
/** Safety cap on scan pages so a repo bug can never spin forever. */
const QUEUED_SCAN_MAX_PAGES = 100;

export interface FlushQueuedMessagesDeps {
  /** Injected in tests; lazily built from config otherwise (real handler path). */
  messagesRepo?: MessagesRepo;
  logger?: Logger;
}

/**
 * Release every queued_pending outbound message on a now-open relay group into the
 * normal fan-out, in created_at order. Idempotent-safe by construction: it is
 * called exactly once per group open (the relay.numberReady handler's read-check +
 * conditional assign gate a redelivery out before it reaches here), and the
 * fan-out job carries its own duplicate-delivery guard as a second layer.
 */
export async function flushQueuedMessages(
  conversationId: string,
  deps: FlushQueuedMessagesDeps = {},
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  const messages = deps.messagesRepo ?? createMessagesRepo({ logger: deps.logger });

  // Page the whole thread, collecting outbound queued_pending messages. A
  // connecting group has only these, but paging guarantees none is dropped even
  // if the log is larger than one page (never lose a queued message).
  const pending: MessageItem[] = [];
  let before: string | undefined;
  for (let page = 0; page < QUEUED_SCAN_MAX_PAGES; page += 1) {
    const rows = await messages.listByConversation(conversationId, {
      limit: QUEUED_SCAN_PAGE,
      ...(before !== undefined && { before }),
    });
    if (rows.length === 0) break;
    for (const m of rows) {
      if (m.direction === 'outbound' && m.delivery_status === 'queued_pending') pending.push(m);
    }
    if (rows.length < QUEUED_SCAN_PAGE) break;
    // listByConversation is newest-first; page back from the oldest key seen.
    before = rows[rows.length - 1]!.tsMsgId;
  }

  if (pending.length === 0) {
    log.info(
      { conversationId, event: 'relay_flush_queued_none' },
      'flushQueuedMessages: no queued messages to release',
    );
    return;
  }

  // Preserve CREATION ORDER: sort ascending by created_at (the contract key),
  // tsMsgId as a stable tiebreak (it is provider_ts-prefixed).
  pending.sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    return a.tsMsgId < b.tsMsgId ? -1 : a.tsMsgId > b.tsMsgId ? 1 : 0;
  });

  for (const m of pending) {
    // Transition into the normal send path (queued_pending -> queued) so the
    // hub message reflects "released"; forward-only, a no-op on a redelivery.
    await messages.updateDeliveryStatus(m.provider_sid, 'queued');
    // Fan out to ALL members FROM the now-live pool number - identical envelope
    // to the open-group team send (TEAM sentinel matches no member, so none is
    // excluded; the neutral team label is the prefix).
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: conversationId,
      sourceTsMsgId: m.tsMsgId,
      senderKey: TEAM_SENDER_KEY,
      senderNameOverride: TEAM_SENDER_LABEL,
    });
  }

  log.info(
    { conversationId, count: pending.length, event: 'relay_flush_queued' },
    'flushQueuedMessages: released queued messages into the relay fan-out (created_at order)',
  );
}
