// The unread read model (design 2026-08-16, spec 4.3) - the ONE place that
// turns the sparse `byUnread` GSI into "what the human should see as unread".
//
// It is deliberately LAYERED, because three surfaces (the nav badge, the
// Unread page, Today) used to each carry their own idea of unread and could
// therefore disagree with one another in production:
//
//   LAYER 1 - iterateUnreadConversations: conversation-level. A LAZY,
//     PULL-BASED async generator over the index that applies the visibility
//     rules and yields only passers, while counting EVERY raw item it looked
//     at against the caller's budget.
//   LAYER 2 - collectUnreadRows (below, Task 4): row-identity level.
//
// WHY LAZY, AND NOT A MATERIALIZED BATCH: the badge is the app's
// highest-frequency request (every SPA boot plus every debounced conversation
// event, per connected dashboard). A batch-then-slice reader has to scan the
// WHOLE index before its own cap can apply, which makes the badge cost
// O(all unread) instead of O(rows it needs) and collapses two different
// meanings of "exhausted" into one flag. Because this is a generator, a
// consumer that stops pulling stops the underlying Query paging - the walk
// does only the work its consumer asked for. Any change here that buffers
// ahead of the consumer silently undoes that, so the unit tests assert on the
// NUMBER OF queryUnreadPage CALLS, not just on the items.
//
// PII (doc 9): this module logs ids, counts and event names only.
import { logger as defaultLogger, type Logger } from './logger.js';
import { createRateLimitedWarn, type WarnSink } from './rateLimitedWarn.js';
import {
  GROUP_TEXT_STATUS,
  UNREAD_FLAG_VALUE,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';

/**
 * Raw index items ONE REQUEST may scan (spec 4.3). A safety ceiling, not a
 * per-call allowance: a caller that runs several collects threads the
 * REMAINING budget through each one so the whole request stays under it.
 */
export const UNREAD_WALK_LIMIT = 2000;

/** Scanned-items tripwire: past this, the accrual classes need revisiting. */
export const UNREAD_WALK_WARN = 500;

/** Rows fetched per internal Query page (spec 4.3: "Query Limit ~100"). */
const UNREAD_QUERY_PAGE_SIZE = 100;

/** Minimum gap between tripwire WARNs (the signal is the RATE, not each hit). */
const UNREAD_WARN_INTERVAL_MS = 5 * 60_000;

/**
 * Partition-key prefixes of the repo's POINTER items (phone/email claims and
 * reply-token pointers). Those carry only a key plus a ref, so they cannot
 * structurally enter a sparse GSI - this is belt-and-braces so a hand-written
 * fixture, a backfill Scan, or a future pointer shape can never be mistaken
 * for a conversation.
 */
const POINTER_PARTITION_PREFIXES = ['phone#', 'email#', 'token#'] as const;

/**
 * ONE process-wide rate-limited WARN whose DESTINATION logger is chosen PER
 * CALL.
 *
 * lib/rateLimitedWarn.ts binds its logger at construction, but these tripwires
 * have to land on the CALLER's correlated child logger while the throttle
 * itself must be SHARED: two limiter instances would be two independent
 * 5-minute windows, and the flood they exist to bound would simply double. So
 * each limiter is built once, at MODULE scope, over a sink that forwards to
 * whichever logger most recently fired it. (Module scope is a new shape for
 * this repo - the only other call sites, routes/webhooks/twilio.ts, are
 * router-factory-scoped, which is effectively module scope there because
 * production builds one router per process. Here two consumers in two files
 * share one limiter, so factory scope would not work.)
 *
 * ACCEPTED: a TRAILING FLUSH fired by the limiter's own timer lands on the
 * last caller's logger rather than the one that was suppressed. These lines
 * are process-level tripwires whose content does not depend on the request.
 */
function moduleRateLimitedWarn(
  intervalMs: number,
): (logger: Logger | undefined, fields: Record<string, unknown>, message: string) => void {
  let destination: WarnSink = defaultLogger;
  const limited = createRateLimitedWarn({
    intervalMs,
    logger: {
      warn(fields, message) {
        destination.warn(fields, message);
      },
    },
  });
  return (logger, fields, message) => {
    if (logger !== undefined) destination = logger;
    limited(fields, message);
  };
}

const warnWalkScanned = moduleRateLimitedWarn(UNREAD_WARN_INTERVAL_MS);

/** A position in the byUnread stream: the index's (RANGE, table key) tuple. */
export interface UnreadScanPosition {
  lastActivityAt: string;
  conversationId: string;
}

/**
 * The walk's live accounting, MUTATED as the generator advances so a consumer
 * that stops pulling can still read exactly where it stopped.
 */
export interface UnreadWalkState {
  /** Position of the last RAW item scanned - advances through filtered runs. */
  scanPosition?: UnreadScanPosition;
  /** The underlying Query stream ended (no LastEvaluatedKey). */
  scanExhausted: boolean;
  /** Raw items consumed from the budget (visible AND invisible). */
  scanned: number;
}

/**
 * The GSI's FULL key for a position: hash + range + the trailing table key.
 * The table key is what disambiguates rows sharing one `last_activity_at`, so
 * a caller can resume from any item it has seen - not only from a raw
 * LastEvaluatedKey.
 */
export function toExclusiveStartKey(position: UnreadScanPosition): Record<string, unknown> {
  return {
    unread_flag: UNREAD_FLAG_VALUE,
    last_activity_at: position.lastActivityAt,
    conversationId: position.conversationId,
  };
}

/**
 * Is this conversation in the 1:1 bucket (i.e. NOT one of the two group
 * kinds)? Mirrors the inbox reader's NEGATIVE test rather than enumerating the
 * 1:1 types, so a LEGACY row with no `type` - and any future 1:1 type - lands
 * in the 1:1 bucket by default instead of vanishing from every reader.
 */
export function isOneToOneBucket(conv: Pick<ConversationItem, 'type'>): boolean {
  return conv.type !== 'relay_group' && conv.type !== 'group_text';
}

/**
 * The visibility rules, spec 4.3 step 2 - THE definition of "unread the human
 * should see", shared by both layers, Today, and the tests.
 *
 * The `unread_count` check defends WITHIN-IMAGE inconsistency only (an
 * un-backfilled row, a hypothetical broken writer). It cannot detect GSI
 * REPLICATION LAG: a stale index entry's projected attributes are stale in
 * lockstep with its key, so a just-read conversation still reads as unread
 * here. That staleness is accepted by design (spec section 6).
 */
export function isUnreadVisible(item: ConversationItem): boolean {
  if (POINTER_PARTITION_PREFIXES.some((prefix) => item.conversationId.startsWith(prefix))) {
    return false;
  }
  if (typeof item.unread_count !== 'number' || item.unread_count <= 0) return false;
  if (item.type === 'relay_group') return item.status === 'open' || item.status === 'connecting';
  if (item.type === 'group_text') return item.status === GROUP_TEXT_STATUS;
  return item.status === 'open';
}

/**
 * LAZY visible-unread iterator (spec 4.3 layer 1).
 *
 * Queries `byUnread` newest-first in internal pages, fetching the NEXT page
 * only when the consumer keeps pulling. Yields items passing
 * `isUnreadVisible`; counts EVERY scanned raw item against `opts.budget` and
 * mutates `state` as it goes, so the caller can stop pulling at any point and
 * read the position, the scanned count and whether the stream ended.
 *
 * `state.scanPosition` always advances through fully-filtered runs, so a long
 * stretch of invisible rows can never dead-end the feed: a caller resuming
 * from the position it read is past them.
 */
export async function* iterateUnreadConversations(
  deps: { conversations: Pick<ConversationsRepo, 'queryUnreadPage'>; logger?: Logger },
  opts: { startAfter?: UnreadScanPosition; budget: number },
  state: UnreadWalkState,
): AsyncGenerator<ConversationItem> {
  let exclusiveStartKey =
    opts.startAfter === undefined ? undefined : toExclusiveStartKey(opts.startAfter);
  let more = true;
  // Once per WALK. The module-scope limiter is what makes this a RATE across
  // requests; firing per scanned item would only inflate its suppressedCount
  // with item counts and blur the "is this happening at all" signal.
  let warned = false;

  while (more && state.scanned < opts.budget) {
    const page = await deps.conversations.queryUnreadPage({
      // Never ask for more than the budget still allows: an over-large Limit
      // would bill reads the caller has no allowance to consume.
      limit: Math.min(UNREAD_QUERY_PAGE_SIZE, opts.budget - state.scanned),
      ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
    });
    exclusiveStartKey = page.lastEvaluatedKey;
    more = page.lastEvaluatedKey !== undefined;

    if (page.items.length === 0) {
      // An UNFILTERED Query never returns an empty page WITH a
      // LastEvaluatedKey (a LEK means the Limit or the 1MB cap was reached,
      // and both imply items). Bail rather than loop anyway: nothing on this
      // path advances `scanned`, so a misbehaving adapter or fake could
      // otherwise spin forever inside a request.
      if (!more) state.scanExhausted = true;
      return;
    }

    for (const item of page.items) {
      state.scanned += 1;
      state.scanPosition = {
        lastActivityAt: item.last_activity_at,
        conversationId: item.conversationId,
      };
      if (!warned && state.scanned > UNREAD_WALK_WARN) {
        warned = true;
        warnWalkScanned(
          deps.logger,
          {
            event: 'unread_walk_scan_tripwire',
            scanned: state.scanned,
            threshold: UNREAD_WALK_WARN,
            budget: opts.budget,
          },
          'unread feed: raw byUnread scan passed the walk tripwire - revisit index accrual',
        );
      }
      if (!isUnreadVisible(item)) continue;
      yield item;
    }

    // Reached ONLY when the consumer pulled through the whole page: a consumer
    // that stopped mid-page leaves the generator suspended at its `yield`, and
    // "the stream ended" is precisely what such a consumer does NOT know.
    if (!more) state.scanExhausted = true;
  }
}
