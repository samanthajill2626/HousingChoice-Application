// buildTimelineFallback — assembles a MESSAGES-ONLY contact timeline client-side
// when the server's person-centric timeline (GET /api/contacts/:id/timeline, §C2)
// isn't live yet (BE2). Given the contact's conversations (the inbox summaries
// whose participants include the contact) and a map of each conversation's
// messages, it flattens every SMS/MMS message into a chronological
// TimelineMessage[] — NO calls, NO milestones (those arrive with the server
// timeline). Pure + deterministic so it's unit-tested in isolation.
import type { ConversationSummary, Message, TimelineMessage } from '../../api/index.js';

/** The sort/display instant for a message. Prefer provider_ts / created_at; else
 *  derive it from tsMsgId — the sort key shape is "<ISO ts>#<id>", so its prefix
 *  IS the provider timestamp. Many wire/seeded messages carry only tsMsgId (no
 *  provider_ts/created_at); without this the rows tie and render newest-first. */
function instantOf(message: Message): string {
  if (message.provider_ts) return message.provider_ts;
  if (message.created_at) return message.created_at;
  return message.tsMsgId.split('#')[0] ?? '';
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
        // Relay group (M1.7): carry the per-recipient delivery map so a relay
        // SOURCE message can surface the "N member(s) opted out" note (the note
        // renders on the sender's contact page — this relay thread involves them).
        ...(m.delivery_recipients !== undefined && { delivery_recipients: m.delivery_recipients }),
        // Relay number lifecycle: a late text intercepted from a now-closed group
        // into this 1:1 carries the closed group's id - keep it so the badge renders
        // on the fallback path too (the server timeline already serializes it).
        ...(typeof m.via_closed_group === 'string' && { via_closed_group: m.via_closed_group }),
      };
      items.push(item);
    }
  }

  // Stable chronological sort. localeCompare on the ISO instant orders correctly
  // for same-format timestamps; ties keep insertion order (Array.sort is stable).
  // A message with neither provider_ts nor created_at (at === '') sorts LAST
  // rather than to the top.
  items.sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at === '') return 1;
    if (b.at === '') return -1;
    return a.at.localeCompare(b.at);
  });
  return items;
}
