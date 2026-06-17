// buildTimelineFallback — assembles a MESSAGES-ONLY contact timeline client-side
// when the server's person-centric timeline (GET /api/contacts/:id/timeline, §C2)
// isn't live yet (BE2). Given the contact's conversations (the inbox summaries
// whose participants include the contact) and a map of each conversation's
// messages, it flattens every SMS/MMS message into a chronological
// TimelineMessage[] — NO calls, NO milestones (those arrive with the server
// timeline). Pure + deterministic so it's unit-tested in isolation.
import type { ConversationSummary, Message, TimelineMessage } from '../../api/index.js';

/** The sort/display instant for a message: prefer provider_ts (the wire sort
 *  key's time component), else created_at. */
function instantOf(message: Message): string {
  return message.provider_ts || message.created_at || '';
}

/**
 * Flatten the contact's conversations' messages into a chronological
 * TimelineMessage[] (oldest → newest). `messagesByConvId` maps a conversationId
 * to its messages (any order — newest-first as the server returns is fine).
 * Call-type messages are excluded (the fallback is messages-only). fromPhone /
 * toPhone are derived from direction + the conversation's participant phone.
 */
export function buildTimelineFallback(
  conversations: ConversationSummary[],
  messagesByConvId: Map<string, Message[]>,
): TimelineMessage[] {
  const items: TimelineMessage[] = [];

  for (const conv of conversations) {
    const messages = messagesByConvId.get(conv.conversationId) ?? [];
    for (const m of messages) {
      if (m.type === 'call') continue; // messages-only fallback
      const inbound = m.direction === 'inbound';
      const item: TimelineMessage = {
        kind: 'message',
        id: m.tsMsgId,
        at: instantOf(m),
        conversationId: m.conversationId,
        tsMsgId: m.tsMsgId,
        direction: m.direction,
        author: m.author,
        type: m.type === 'mms' ? 'mms' : 'sms',
        delivery_status: m.delivery_status,
        // The participant phone is the EXTERNAL party. Inbound: they're the
        // sender (fromPhone); outbound: they're the recipient (toPhone). The
        // platform-side number isn't on the summary, so we leave the other side
        // undefined rather than guess.
        ...(inbound ? { fromPhone: conv.participant_phone } : { toPhone: conv.participant_phone }),
        ...(m.body !== undefined && { body: m.body }),
        ...(m.media_attachments !== undefined && { media_attachments: m.media_attachments }),
      };
      items.push(item);
    }
  }

  // Stable chronological sort. localeCompare on the ISO instant orders correctly
  // for same-format timestamps; ties keep insertion order (Array.sort is stable).
  items.sort((a, b) => a.at.localeCompare(b.at));
  return items;
}
