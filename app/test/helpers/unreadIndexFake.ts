// The ONE in-memory model of the sparse byUnread GSI, shared by every
// conversations-repo fake (design 2026-08-16).
//
// WHY A SHARED HELPER RATHER THAN A PER-FAKE COPY: a `queryUnreadPage` that
// silently returns [] is indistinguishable from an empty index, so a stubbed
// fake makes unread route tests pass while proving nothing. Deriving every
// fake's page from this one function means the invariant under test - "a row is
// in the index IFF it carries unread_flag" - is modeled identically everywhere,
// and a fake can no longer drift into agreeing with a broken implementation.
//
// It deliberately mirrors the REAL index semantics, not a convenient
// approximation:
//   - membership is the FLAG, never the counter (that is what the sparse GSI
//     keys on, and the two can only disagree if production is broken);
//   - order is (last_activity_at DESC, conversationId DESC) - a TUPLE, because
//     equal timestamps are ordinary and the trailing table key is what breaks
//     the tie;
//   - the resume key is the SYNTHESIZED FULL KEY
//     { unread_flag, last_activity_at, conversationId }, so a caller can resume
//     from any item it has seen. An index-POSITION key (`{ idx }`, as
//     listByLastActivity's fakes use) cannot express that and would quietly
//     repeat or skip a row at a timestamp tie.
import type { ConversationItem } from '../../src/repos/conversationsRepo.js';

/** The exclusive-start / last-evaluated key shape the real GSI hands back. */
export interface UnreadIndexKey extends Record<string, unknown> {
  unread_flag: 'unread';
  last_activity_at: string;
  conversationId: string;
}

/**
 * Newest-activity-first, ties broken by conversationId descending. Takes the
 * bare (timestamp, id) tuple so a resume KEY - which is not a conversation -
 * can be compared without inventing a partial item.
 */
function compareUnreadDesc(
  a: { last_activity_at: string; conversationId: string },
  b: { last_activity_at: string; conversationId: string },
): number {
  if (a.last_activity_at !== b.last_activity_at) {
    return a.last_activity_at < b.last_activity_at ? 1 : -1;
  }
  if (a.conversationId !== b.conversationId) {
    return a.conversationId < b.conversationId ? 1 : -1;
  }
  return 0;
}

function keyOf(item: ConversationItem): UnreadIndexKey {
  return {
    unread_flag: 'unread',
    last_activity_at: item.last_activity_at,
    conversationId: item.conversationId,
  };
}

/**
 * One page of the byUnread index over an in-memory item collection.
 *
 * `limit` is honored exactly (the real Query's Limit); `lastEvaluatedKey` is
 * returned ONLY when more flagged rows remain after the page, which is how the
 * repo contract signals "keep paging".
 */
export function queryUnreadPageFromItems(
  items: Iterable<ConversationItem>,
  opts: { limit: number; exclusiveStartKey?: Record<string, unknown> },
): { items: ConversationItem[]; lastEvaluatedKey?: Record<string, unknown> } {
  const ordered = [...items]
    .filter((c) => c.unread_flag === 'unread')
    .sort(compareUnreadDesc);

  const start = opts.exclusiveStartKey;
  const startTs =
    typeof start?.['last_activity_at'] === 'string' ? start['last_activity_at'] : undefined;
  const startId =
    typeof start?.['conversationId'] === 'string' ? start['conversationId'] : undefined;
  // EXCLUSIVE: keep only what sorts strictly AFTER the key in the same order.
  const remaining =
    startTs === undefined || startId === undefined
      ? ordered
      : ordered.filter(
          (c) => compareUnreadDesc(c, { last_activity_at: startTs, conversationId: startId }) > 0,
        );

  const page = remaining.slice(0, opts.limit);
  const last = page[page.length - 1];
  const more = remaining.length > page.length;
  return {
    items: page,
    ...(more && last !== undefined && { lastEvaluatedKey: keyOf(last) }),
  };
}
