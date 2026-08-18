// Mark-unread's WRITE step, shared by the three routes that flag a thread
// unread: POST /api/conversations/:conversationId/unread (routes/api.ts) and
// the two fan-in routes POST /api/inbox/unread { phone } and
// POST /api/inbox/:contactId/unread (routes/inbox.ts).
//
// H1 (2026-08-17). Those routes used to read the row, check isUnreadVisible and
// unread_count === 0, then call incrementUnread - a TOCTOU. A relay close
// committing between the check and the write re-flagged a CLOSED group unread,
// planting a permanently invisible byUnread resident: the bug class of
// docs/issues/inbound-reflags-closed-relay-group.md. conversationsRepo.setUnread
// carries that precondition in its own ConditionExpression instead. This module
// owns the one obligation a conditional write puts on every caller: DynamoDB
// does not say WHICH clause failed, so a refusal has to be re-read and
// classified, and the one useful retry has to be bounded.
//
// The routes keep everything that is theirs: their fast pre-checks (which give
// SPECIFIC errors this layer cannot), their status mapping, and their
// events.emit. The event bus is deliberately NOT wired in here - a lib that
// emits would make every future caller emit, and the fan-in routes and the
// conversation route do not agree on what they return.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type {
  ConversationItem,
  ConversationsRepo,
  UnreadBucket,
} from '../repos/conversationsRepo.js';
import { isUnreadVisible } from './unreadFeed.js';

/**
 * The repo surface this needs. A Pick, in the style of lib/contactThreads.ts,
 * so any fake carrying the two methods satisfies it.
 */
export type MarkUnreadRepo = Pick<ConversationsRepo, 'getById' | 'setUnread'>;

/**
 * What happened. `wrote` and `already-unread` are both SUCCESS for every
 * caller; they differ only in whether there is a write to announce. `item`
 * rides every arm where a row still exists, so the caller never re-reads to
 * build its response or its event.
 */
export type MarkUnreadResult =
  | { kind: 'wrote'; item: ConversationItem }
  | { kind: 'already-unread'; item: ConversationItem }
  | { kind: 'ineligible'; item: ConversationItem }
  | { kind: 'gone' };

/**
 * The UnreadBucket an item belongs to - the three arms of isUnreadVisible.
 * The 1:1 arm is the NEGATIVE default, mirroring isOneToOneBucket: a legacy row
 * with no `type`, and any future 1:1 type, lands in it rather than falling out
 * of every bucket.
 */
export function unreadBucketFor(conv: Pick<ConversationItem, 'type'>): UnreadBucket {
  if (conv.type === 'relay_group') return 'relay_group';
  if (conv.type === 'group_text') return 'group_text';
  return 'one_to_one';
}

type Classification =
  | { kind: 'gone' }
  | { kind: 'ineligible'; item: ConversationItem }
  | { kind: 'already-unread'; item: ConversationItem }
  | { kind: 'raced'; item: ConversationItem };

/**
 * Read a refusal. ELIGIBILITY BEFORE COUNT, always: an ineligible-AND-unread
 * thread is a real state (an inbound re-flagging a closed relay group), and a
 * count-first order would report SUCCESS for exactly that residue row - the
 * thing H1 exists to stop.
 */
function classify(item: ConversationItem | undefined): Classification {
  if (item === undefined) return { kind: 'gone' };
  if (!isUnreadVisible({ ...item, unread_count: 1 })) return { kind: 'ineligible', item };
  if ((item.unread_count ?? 0) > 0) return { kind: 'already-unread', item };
  // ACCEPTED RESIDUAL (adversarial round 2, N7). `getById` is an eventually
  // consistent GetItem, so a doubly-stale image - one reporting BOTH an eligible
  // status and a positive count for a row that is really closed and read - is
  // reported here as `already-unread` when the write was in fact refused on
  // ELIGIBILITY. The END STATE is still correct: nothing was written, so the
  // ineligible thread is not flagged, and the row cannot become a hidden
  // byUnread resident. Only the reported OUTCOME is optimistic (a success where
  // a 409 was due). Settled, if it ever matters, by passing ConsistentRead on
  // this re-read alone - it runs at most twice per refused request.
  // Eligible and read: the condition should have held, so something committed
  // and moved on between the write and this re-read.
  return { kind: 'raced', item };
}

/**
 * Flag `conv` unread through the conditional write, classifying a refusal and
 * retrying a race exactly once.
 *
 * `conv` is the caller's already-read image; it only supplies the FIRST
 * attempt's bucket. Every later decision comes from a fresh point read.
 */
export async function markUnread(
  conversations: MarkUnreadRepo,
  conv: ConversationItem,
): Promise<MarkUnreadResult> {
  const { conversationId } = conv;
  /** undefined = the condition refused; anything else is the write's own image. */
  const attempt = async (item: ConversationItem): Promise<MarkUnreadResult | undefined> => {
    try {
      const written = await conversations.setUnread(conversationId, {
        bucket: unreadBucketFor(item),
      });
      return { kind: 'wrote', item: written };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return undefined;
      throw err;
    }
  };

  const first = await attempt(conv);
  if (first !== undefined) return first;

  const firstLook = classify(await conversations.getById(conversationId));
  if (firstLook.kind !== 'raced') return firstLook;

  // ONE retry, with the bucket RECOMPUTED from the re-read. A stale bucket
  // wastes the retry in the single case where a fresh one succeeds: a type
  // transition (convertRelayGroupToGroupText is the only writer that does one).
  //
  // CONSTRAINT FOR WHOEVER ADDS THE NEXT TYPE TRANSITION (adversarial round 2,
  // N6). A recomputed bucket can only ever be as wide as the type transitions
  // the system permits, and the fan-in routes narrow their candidates to
  // `type !== 'relay_group'` (a contact who owns a pool number must not flag a
  // relay thread through there) in the ROUTE, not in the write. So a transition
  // that turned a row the fan-in filter admitted INTO a relay_group would let
  // this retry flag exactly the thread the route excluded. Unreachable today:
  // convertRelayGroupToGroupText is the only type-changing writer and it goes
  // relay_group -> group_text, never the other way. Add a transition into
  // relay_group and this retry must be given the route's admissible bucket set
  // so it can only narrow.
  const second = await attempt(firstLook.item);
  if (second !== undefined) return second;

  const secondLook = classify(await conversations.getById(conversationId));
  if (secondLook.kind !== 'raced') return secondLook;
  // A SECOND race, and no second retry. Reporting it as `ineligible` is
  // DELIBERATELY APPROXIMATE, not an oversight: two consecutive races on one
  // row are vanishingly rare, every caller maps both to the same terminal
  // refusal (409 thread_closed), and a fifth result kind would be a
  // distinction no route could act on differently.
  return { kind: 'ineligible', item: secondLook.item };
}
