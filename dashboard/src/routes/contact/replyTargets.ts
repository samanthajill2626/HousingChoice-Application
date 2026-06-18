// replyTargets — resolve WHICH conversation a reply sends into for a (possibly
// multi-number) contact. Each of the contact's numbers is its own 1:1 thread, so
// "which number do we text" == "which conversation do we POST to". We derive the
// number→conversation map from the blended timeline (a message's contact-side
// phone is fromPhone when inbound, toPhone when outbound) and pick a sensible
// default (the primary number's thread). Pure + tested.
import type { ContactPhone, TimelineItem } from '../../api/index.js';

export interface ReplyTarget {
  phone: string;
  label?: string;
  conversationId: string;
}

export interface ReplyTargets {
  /** The contact's numbers that have a resolvable conversation (primary first). */
  targets: ReplyTarget[];
  /** The conversation to send into by default (primary's thread, else first,
   *  else the only distinct conversation in the timeline, else null). */
  defaultConversationId: string | null;
}

export function buildReplyTargets(items: TimelineItem[], phones: ContactPhone[]): ReplyTargets {
  // Contact-side phone → most-recent conversationId (items are chronological, so a
  // later message overwrites — last wins == most recent thread for that number).
  const byPhone = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== 'message') continue;
    const cp = item.direction === 'inbound' ? item.fromPhone : item.toPhone;
    if (cp && cp.length > 0 && item.conversationId) byPhone.set(cp, item.conversationId);
  }

  // Offer the contact's OWN numbers (in their given order) that have a thread.
  const targets: ReplyTarget[] = [];
  const seen = new Set<string>();
  for (const p of phones) {
    const conv = byPhone.get(p.phone);
    if (conv && !seen.has(p.phone)) {
      targets.push({ phone: p.phone, ...(p.label !== undefined && { label: p.label }), conversationId: conv });
      seen.add(p.phone);
    }
  }

  const primaryPhone = phones.find((p) => p.primary)?.phone;
  let defaultConversationId: string | null =
    (primaryPhone ? byPhone.get(primaryPhone) : undefined) ?? targets[0]?.conversationId ?? null;

  // Fallback: if the phone map resolved nothing (e.g. numbers not on the contact
  // record yet) but the timeline has exactly one conversation, send into that.
  if (defaultConversationId === null) {
    const ids = new Set<string>();
    for (const item of items) {
      if (item.kind === 'message') ids.add(item.conversationId);
      else if (item.kind === 'call' && item.conversationId) ids.add(item.conversationId);
    }
    if (ids.size === 1) defaultConversationId = [...ids][0] ?? null;
  }

  return { targets, defaultConversationId };
}
