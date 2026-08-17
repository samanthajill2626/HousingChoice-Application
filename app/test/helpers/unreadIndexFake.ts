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
import { UNREAD_FLAG_VALUE, type ConversationItem } from '../../src/repos/conversationsRepo.js';

/**
 * The FIXTURE half of the same invariant the page function above models: a
 * conversation row is in the sparse byUnread index IFF it carries
 * `unread_flag`, and the real writers only ever stamp that alongside a nonzero
 * `unread_count`. So every fixture with unread must carry the flag, and no
 * fixture without unread may.
 *
 * Spread this into a fixture factory BEFORE its `...overrides`, so it acts as a
 * DERIVED DEFAULT rather than a rule the fixture cannot escape: a test that
 * deliberately needs a STALE index row (flagged but already read, the state a
 * lagging GSI image produces) can still say so explicitly and win.
 *
 * Deriving it centrally rather than writing `unread_flag: 'unread'` next to
 * every count is what makes the two impossible to drift apart - at the cost
 * that a reader scanning fixture literals will not SEE the flag anywhere, which
 * is why each call site carries a one-line comment pointing here.
 */
export function unreadFlagFor(source: {
  unread_count?: unknown;
}): { unread_flag?: typeof UNREAD_FLAG_VALUE } {
  const count = source.unread_count;
  return typeof count === 'number' && count > 0 ? { unread_flag: UNREAD_FLAG_VALUE } : {};
}

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
 * `limit` is honored exactly (the real Query's Limit), and `lastEvaluatedKey`
 * is returned whenever the page REACHED that limit - not merely when more rows
 * are known to remain. That is the service's rule, and the difference is
 * observable (adversarial A7): a walk over exactly n * limit rows costs one
 * MORE round trip than "items remaining" modelling suggests, and the
 * interleaving the route's cursor block is written for - a non-empty page
 * carrying a key, followed by an empty page with none - cannot occur at all
 * under the weaker model. Since the unit tests here assert on the NUMBER of
 * queryUnreadPage calls, an under-counting fake would calibrate every one of
 * those assertions one round trip short of production.
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
  // LIMIT REACHED, not "rows remain": DynamoDB stops at the Limit and hands
  // back the position it stopped at, so the caller has to ask again to learn
  // that the stream ended.
  const limitReached = page.length === opts.limit;
  return {
    items: page,
    ...(limitReached && last !== undefined && { lastEvaluatedKey: keyOf(last) }),
  };
}
