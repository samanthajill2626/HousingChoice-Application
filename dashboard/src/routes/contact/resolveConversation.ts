// resolveConversation — find the single conversation to send a reply into, from
// the timeline items. The reply box can only send when EXACTLY one conversation
// is involved (the message endpoint is per-conversation; with a multi-number /
// multi-thread contact there's no unambiguous target yet — the picker that
// chooses is a future affordance). Returns the conversationId when unambiguous,
// else null (the reply box disables Send with a tooltip). Pure + tested.
import type { TimelineItem } from '../../api/index.js';

export function resolveSingleConversation(items: TimelineItem[]): string | null {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === 'message') ids.add(item.conversationId);
    else if (item.kind === 'call' && item.conversationId) ids.add(item.conversationId);
  }
  return ids.size === 1 ? [...ids][0] ?? null : null;
}
