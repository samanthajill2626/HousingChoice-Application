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
//   LAYER 2 - collectUnreadRows: row-identity level. Groups layer-1 items into
//     ROW CANDIDATES (one per contact / unknown number / group thread) and
//     stops pulling the moment `maxRows` are emitted. The badge COUNTS these
//     candidates and the Unread page HYDRATES them, so the two surfaces can no
//     longer disagree about what a row is.
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
import { isDeleted, type ContactItem, type ContactsRepo } from '../repos/contactsRepo.js';
import {
  GROUP_TEXT_STATUS,
  UNREAD_FLAG_VALUE,
  type ConversationItem,
  type ConversationsRepo,
} from '../repos/conversationsRepo.js';
import type { MessagesRepo } from '../repos/messagesRepo.js';

/**
 * Raw index items ONE REQUEST may scan (spec 4.3). A safety ceiling, not a
 * per-call allowance: a caller that runs several collects threads the
 * REMAINING budget through each one so the whole request stays under it.
 */
export const UNREAD_WALK_LIMIT = 2000;

/** Scanned-items tripwire: past this, the accrual classes need revisiting. */
export const UNREAD_WALK_WARN = 500;

/**
 * Row candidates the badge count stops at (spec 4.4). A capped count is a
 * FLOOR, which is why the wire carries `capped` alongside the number.
 */
export const BADGE_COUNT_CAP = 100;

/**
 * Deleted-contact resurfacing probes ONE REQUEST may issue before the tripwire
 * fires (spec 4.4). A separate tripwire from the scanned-items one because the
 * two costs grow INDEPENDENTLY: tens of deleted residents degrade the badge
 * long before 500 items are scanned.
 */
export const UNREAD_DELETED_PROBE_WARN = 25;

/**
 * WASTED resurfacing probes ONE REQUEST may issue before it stops probing
 * (review fix wave 2, adversarial r2 findings 1-2; spec 4.4 amended).
 *
 * A WASTED probe is one whose answer was "still hidden": a read that bought no
 * row. Those are the unbounded population - a hidden deleted candidate never
 * counts toward `maxRows`, so the row cap cannot stop them, and a wall of them
 * made the badge (the app's highest-frequency request) pay one contact Query
 * PLUS one message probe per row, thousands of serial round trips, to answer
 * zero.
 *
 * A PRODUCTIVE probe - one that resurfaces a contact - is NOT counted here.
 * Resurfacing is the product rule (spec 4.3 step 2), a fresh inbound puts those
 * rows at the HEAD of the index, and the rows they emit are already bounded by
 * `maxRows`. Fix wave 1 counted them too, which capped the badge at 26 in an
 * ordinary world.
 *
 * Past this many wasted probes IN ONE REQUEST, further deleted-contact threads
 * are treated as hidden WITHOUT being read, and the result reports `truncated`
 * - the count is a FLOOR. THE WALK CONTINUES: live contacts, unknowns, groups
 * and relay threads behind the wall are still counted and still emitted, which
 * is the difference between bounding the probes and bounding the walk (fix wave
 * 1 did the latter and dead-ended the page at zero rows).
 *
 * DELIBERATELY ONE ABOVE THE WARN THRESHOLD: tripping the bound must always be
 * a state the tripwire also reports, otherwise the fix would silence the very
 * signal that says accrual needs attention.
 */
export const UNREAD_DELETED_PROBE_LIMIT = UNREAD_DELETED_PROBE_WARN + 1;

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
 *
 * ALSO ACCEPTED, and NOT a leak (adversarial A12): `destination` holds the last
 * caller's request-scoped child logger until the NEXT call replaces it, so
 * between bursts the module pins one request's logger and its correlation
 * context indefinitely. That is one small object, never a growing set, and the
 * alternative - clearing it after each call - would cost the trailing flush its
 * destination entirely.
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
const warnProbeBurst = moduleRateLimitedWarn(UNREAD_WARN_INTERVAL_MS);
const warnBadgeZero = moduleRateLimitedWarn(UNREAD_WARN_INTERVAL_MS);

/**
 * Fire the SILENT-ZERO tripwire: the badge answered 0 while its walk stopped
 * early, so unread rows exist that the number does not represent (conformance
 * C1).
 *
 * The client renders a zero as NO BADGE, which is indistinguishable from
 * genuinely caught up, and giving the badge an indeterminate rendering is out
 * of scope for v1 (docs/issues/unread-budget-truncation-has-no-forward-path.md
 * stays open for the UI affordance). Until then the SERVER is the only place
 * this state can be observed at all, so it says so here - rate limited, because
 * the badge is the app's highest-frequency request and the signal is the RATE.
 *
 * IT CARRIES `skipped` TOO (adversarial r3 finding 6 / conformance r3 finding
 * 8). `probes` is pinned at UNREAD_DELETED_PROBE_LIMIT whenever the bound
 * engaged, so alone it can only say "this is happening", never "how bad": the
 * skipped count is what distinguishes a 26-deep wall from a 2,600-deep one, and
 * this is the ONE line that names the zero-count state.
 */
export function warnTruncatedZeroCount(
  logger: Logger | undefined,
  fields: { scanned: number; probes: number; skipped: number },
): void {
  warnBadgeZero(
    logger,
    { event: 'unread_badge_truncated_zero', ...fields },
    'unread badge: reported 0 while the walk stopped early - unread rows exist behind the answer',
  );
}

/**
 * Fire the deleted-resurfacing-probe tripwire for a REQUEST's probe total.
 *
 * The WARN lives with the CALLER, not inside `collectUnreadRows`, because the
 * Unread page's fill-or-exhaust loop makes MANY collects per request: a
 * per-collect threshold could never fire for a request that spent 5 probes in
 * each of ten collects. Callers accumulate `CollectResult.deletedProbes` and
 * `CollectResult.skippedDeletedThreads` across their collects and call this
 * once, with the request totals. No-ops when neither is interesting.
 *
 * ATTEMPTED, WASTED AND SKIPPED ARE SEPARATE FIELDS (adversarial r2 finding 7).
 * Once the bound caps the reads, `probes` alone is a CONSTANT on the badge path,
 * so on its own it can only ever say "this is happening" - never "how bad". The
 * skipped count is free (it needs no read) and is what distinguishes 26 deleted
 * residents from 2,600, i.e. how urgent the cleanup is.
 *
 * THE THRESHOLD KEYS ON WASTED + SKIPPED, NEVER ON ATTEMPTED (conformance r3
 * finding 1). Fix wave 2 exempted PRODUCTIVE probes from the BOUND - resurfacing
 * a deleted contact is the product rule, and those rows are bounded by `maxRows`
 * - but left this tripwire keyed on probes attempted, so the very world that
 * wave declared healthy (50 resurfaced contacts, counted in full) raised
 * "revisit index accrual" on every badge request. Productive probes are still
 * REPORTED, on the `probes` field; they simply cannot trip the alarm.
 */
export function warnDeletedProbes(
  logger: Logger | undefined,
  totals: { probes: number; wasted: number; skipped: number },
): void {
  if (totals.wasted + totals.skipped <= UNREAD_DELETED_PROBE_WARN) return;
  warnProbeBurst(
    logger,
    {
      event: 'unread_deleted_probe_tripwire',
      probes: totals.probes,
      wasted: totals.wasted,
      skipped: totals.skipped,
      threshold: UNREAD_DELETED_PROBE_WARN,
    },
    'unread feed: deleted-contact resurfacing probes passed the tripwire - revisit index accrual',
  );
}

/**
 * Fire the scanned-items tripwire for a REQUEST's raw-scan total.
 *
 * The sibling of `warnDeletedProbes`, and it exists for the same reason: the
 * iterator's own tripwire (below) fires on PER-WALK state, so a request whose
 * fill-or-exhaust loop scans 200 raw items in each of three collects trips
 * nothing while spec 4.3 defines the tripwire as 500 scanned PER REQUEST. A
 * multi-collect caller accumulates `budget - remainingBudget` and calls this
 * once. No-ops at or below the threshold.
 *
 * It is bound to the SAME module-scope limiter as the in-iterator warn, never a
 * second instance - so when a single request manages to trip both, the limiter
 * swallows the duplicate instead of emitting the line twice.
 */
export function warnUnreadScanned(logger: Logger | undefined, scanned: number): void {
  if (scanned <= UNREAD_WALK_WARN) return;
  warnWalkScanned(
    logger,
    {
      event: 'unread_walk_scan_tripwire',
      scanned,
      threshold: UNREAD_WALK_WARN,
    },
    'unread feed: raw byUnread scan passed the walk tripwire - revisit index accrual',
  );
}

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

// ---------------------------------------------------------------------------
// LAYER 2 - row candidates
// ---------------------------------------------------------------------------

/**
 * One ROW the unread surfaces would show, before any hydration. The badge
 * COUNTS these; the Unread page hydrates them into InboxRows. Keeping the two
 * on one candidate stream is what stops the count and the list diverging.
 */
export type UnreadCandidate =
  | {
      kind: 'contact';
      contactId: string;
      contact: ContactItem;
      /**
       * Every unread thread of this contact met in the walk, in ENCOUNTER
       * (index) order - so `[0]` is the newest one encountered, the row's
       * representative. NOT the contact's full thread set: the page hydrates
       * fresh sums, and the badge needs none.
       */
      unreadConversations: ConversationItem[];
    }
  | { kind: 'unknown'; phone: string; conversation: ConversationItem }
  | { kind: 'relay_group' | 'group_text'; conversation: ConversationItem };

export interface CollectResult {
  candidates: UnreadCandidate[];
  /** Position after the last index item CONSUMED (undefined = nothing seen). */
  scanPosition?: UnreadScanPosition;
  /**
   * The item SUPPLY ran out: the scan exhausted AND every yielded item was
   * consumed. A CONSUMPTION fact, deliberately distinct from layer 1's
   * `scanExhausted` - conflating the two made every under-budget dataset
   * report page one with a null cursor.
   */
  consumedAll: boolean;
  /**
   * The candidate list is a FLOOR because the walk STOPPED EARLY: the request's
   * raw-scan budget ran out before the supply did. A drained stream is never
   * truncated, not even when the probe bound left `skippedDeletedThreads` behind
   * it (fix wave 3, adversarial r3 finding 2) - see the derivation below.
   */
  truncated: boolean;
  /** `maxRows` stopped emission (the candidate list is a FLOOR). */
  capped: boolean;
  /** Budget left for the caller's NEXT collect in this same request. */
  remainingBudget: number;
  /**
   * Resurfacing probes ATTEMPTED by THIS collect only (a real message read
   * each). The CALLER accumulates them per request and owns the WARN (see
   * warnDeletedProbes).
   */
  deletedProbes: number;
  /**
   * Of those, the ones that found the thread still HIDDEN - the probes that
   * bought no row. The CALLER accumulates these too and threads the running
   * total into its next collect as `wastedProbesBefore`, which is what makes
   * the bound a REQUEST budget instead of a per-collect one.
   */
  wastedProbes: number;
  /**
   * Deleted-contact threads this collect treated as hidden WITHOUT probing,
   * because the request's wasted-probe bound was already spent. Free to count,
   * and the only thing that says how DEEP the wall is.
   */
  skippedDeletedThreads: number;
}

type ContactCandidate = Extract<UnreadCandidate, { kind: 'contact' }>;

/**
 * Group the visible unread stream into ROW CANDIDATES, newest-first, stopping
 * the moment `maxRows` are emitted (spec 4.3 layer 2).
 *
 * Because it drives the LAZY layer-1 iterator and stops pulling at the cap,
 * the badge (maxRows = BADGE_COUNT_CAP) scans only as many raw index items as
 * it takes to find 100 rows, and a page scans proportionally to one page.
 *
 * NO unread sums and NO hydration happen here: the page reads fresh sums when
 * it builds rows, and the badge needs neither. The ONE message read this layer
 * performs is the deleted-contact resurfacing probe, which is a VISIBILITY
 * rule rather than hydration.
 */
export async function collectUnreadRows(
  deps: {
    conversations: Pick<ConversationsRepo, 'queryUnreadPage'>;
    contacts: Pick<ContactsRepo, 'findByPhone' | 'findByEmail'>;
    messages: Pick<MessagesRepo, 'listByConversation'>;
    logger?: Logger;
  },
  opts: {
    maxRows: number;
    budget: number;
    startAfter?: UnreadScanPosition;
    excludeContactIds?: ReadonlySet<string>;
    /**
     * WASTED resurfacing probes already spent EARLIER IN THIS REQUEST. The
     * bound is per REQUEST (spec 4.4 amended), and the unread page's fill loop
     * makes many collects, so it threads its running total through here the
     * same way it threads `remainingBudget`.
     */
    wastedProbesBefore?: number;
  },
): Promise<CollectResult> {
  const log = deps.logger ?? defaultLogger;
  const state: UnreadWalkState = { scanExhausted: false, scanned: 0 };
  const candidates: UnreadCandidate[] = [];
  /**
   * Every contact met so far, with whether its row has been EMITTED yet. A
   * DELETED contact's candidate exists here in a HIDDEN state until one of its
   * threads passes the resurfacing probe.
   */
  const seenContacts = new Map<string, { candidate: ContactCandidate; emitted: boolean }>();
  /** Resurfacing probes ATTEMPTED here (one message read each). */
  let deletedProbes = 0;
  /** Of those, the ones that bought no row - what the bound actually counts. */
  let wastedProbes = 0;
  /** Deleted-contact threads called hidden WITHOUT a read (past the bound). */
  let skippedDeletedThreads = 0;
  let capped = false;
  const wastedProbesBefore = opts.wastedProbesBefore ?? 0;

  /**
   * Contact resolution in the inbox reader's order: participant_phone first,
   * then participant_email, so an email-only thread folds into its contact's
   * row instead of surfacing as a phantom unknown. A lookup failure degrades
   * to "no contact" (best-effort) rather than dropping the row.
   *
   * DELIBERATELY NOT MEMOIZED on the participant key (adversarial r2 finding
   * 3): two visible index items can never share one. `createOrGetByParticipantPhone`
   * arbitrates through the `phone#<E164>` claim item, so there is at most one
   * OPEN 1:1 conversation per phone, and `claimEmail` is the single arbiter of
   * which conversation owns an address - while `isUnreadVisible` requires
   * `status === 'open'` for the 1:1 bucket. Fix wave 1 added such a memo and it
   * hit zero times in production shapes. The real amplification is one contact
   * read per VISIBLE unread row, which is the design's stated cost model (spec
   * 4.4) and belongs to the BatchGet follow-up
   * (docs/issues/contacts-batchget-amplified-reads.md).
   */
  const resolveContact = async (item: ConversationItem): Promise<ContactItem | undefined> => {
    const phone = item.participant_phone;
    const email = item.participant_email;
    try {
      let contact: ContactItem | undefined;
      if (phone !== undefined) contact = await deps.contacts.findByPhone(phone);
      if (!contact && email !== undefined) contact = await deps.contacts.findByEmail(email);
      return contact;
    } catch (err) {
      log.warn({ err }, 'unread feed: contact lookup failed (best-effort)');
      return undefined;
    }
  };

  /**
   * Does THIS unread thread resurface a soft-deleted contact? The rule (spec
   * 4.3 step 2): its newest message is an INBOUND created AFTER the deletion.
   * Pre-deletion unread stays hidden (deleting draws a line) and a
   * post-deletion OUTBOUND (a straggler scheduled send) resurfaces nobody. No
   * readable message row never counts as new.
   *
   * The probe has NO `last_activity_at <= deleted_at` short-circuit. CLOCK
   * CAVEAT: created_at is OUR ingest timestamp while message ordering (tsMsgId)
   * and last_activity_at use the PROVIDER timestamp, and the append/touch gap
   * can leave last_activity_at stale while a fresh post-deletion message
   * exists. A saved Query is not worth silently suppressing a genuine
   * resurfacing.
   *
   * It IS bounded, on WASTED probes only (spec 4.4 amended, fix wave 2). Past
   * UNREAD_DELETED_PROBE_LIMIT wasted probes in one REQUEST the answer is
   * assumed to be "hidden" without paying for it, the skip is counted, and the
   * result reports `truncated` so the caller knows its list is a floor. The
   * WALK is untouched: everything else in the stream keeps being consumed.
   */
  const threadResurfaces = async (item: ConversationItem, deletedAt: string): Promise<boolean> => {
    if (wastedProbesBefore + wastedProbes >= UNREAD_DELETED_PROBE_LIMIT) {
      skippedDeletedThreads += 1;
      return false;
    }
    deletedProbes += 1;
    try {
      const page = await deps.messages.listByConversation(item.conversationId, { limit: 1 });
      const latest = page[0];
      const resurfaced =
        latest !== undefined && latest.direction === 'inbound' && latest.created_at > deletedAt;
      // Only a probe that bought NO row spends the bound. One that resurfaces a
      // contact paid for itself and is bounded by `maxRows` like any candidate.
      if (!resurfaced) wastedProbes += 1;
      return resurfaced;
    } catch (err) {
      log.warn(
        { err, conversationId: item.conversationId },
        'unread feed: resurfacing probe failed (best-effort)',
      );
      // A failed read bought no row either, and retrying a failing dependency
      // for every thread in a wall is exactly the cost the bound exists for.
      wastedProbes += 1;
      return false;
    }
  };

  /** Fold ONE visible index item into the candidate list. */
  const consume = async (item: ConversationItem): Promise<void> => {
    if (!isOneToOneBucket(item)) {
      // Both group kinds are their OWN row, keyed by conversationId - one
      // index item each, so they can never straddle a page boundary.
      candidates.push({
        kind: item.type === 'relay_group' ? 'relay_group' : 'group_text',
        conversation: item,
      });
      return;
    }

    const contact = await resolveContact(item);
    if (contact === undefined) {
      const phone = item.participant_phone;
      // A contactless EMAIL thread has no identity to render: email unknowns
      // live in the unmatched-email surface only, so skip rather than emit a
      // phantom unknown row.
      if (phone === undefined) return;
      candidates.push({ kind: 'unknown', phone, conversation: item });
      return;
    }

    // Already emitted on THIS or a PRIOR page (the cursor's seen-set): the
    // item still consumed scan range, it just produces no row.
    if (opts.excludeContactIds?.has(contact.contactId) === true) return;

    const existing = seenContacts.get(contact.contactId);
    if (existing !== undefined) {
      existing.candidate.unreadConversations.push(item);
      // Once EMITTED, later threads merge silently - no second probe.
      if (existing.emitted) return;
      // Still HIDDEN, so this contact is deleted and no thread has qualified
      // yet. PER-THREAD evaluation (plan-review A6): a qualifying OLDER thread
      // can arrive after a non-qualifying newer one, and a one-shot decision
      // at the first thread would silently drop the whole contact.
      const deletedAt = existing.candidate.contact.deleted_at;
      if (typeof deletedAt === 'string' && (await threadResurfaces(item, deletedAt))) {
        existing.emitted = true;
        candidates.push(existing.candidate);
      }
      return;
    }

    const candidate: ContactCandidate = {
      kind: 'contact',
      contactId: contact.contactId,
      contact,
      unreadConversations: [item],
    };
    const deletedAt = isDeleted(contact) ? contact.deleted_at : undefined;
    if (deletedAt === undefined) {
      seenContacts.set(contact.contactId, { candidate, emitted: true });
      candidates.push(candidate);
      return;
    }
    // A deleted contact whose FIRST thread does not qualify is remembered in
    // the hidden state; it emits later if a subsequent thread qualifies, and
    // if none ever does it never emits and never enters the seen-set.
    const emitted = await threadResurfaces(item, deletedAt);
    seenContacts.set(contact.contactId, { candidate, emitted });
    if (emitted) candidates.push(candidate);
  };

  for await (const item of iterateUnreadConversations(
    {
      conversations: deps.conversations,
      ...(deps.logger !== undefined && { logger: deps.logger }),
    },
    {
      budget: opts.budget,
      ...(opts.startAfter !== undefined && { startAfter: opts.startAfter }),
    },
    state,
  )) {
    await consume(item);
    // Checked AFTER consumption so `state.scanPosition` is exactly the item
    // that filled the cap. Breaking here calls the generator's return(), which
    // is what makes the cap STOP THE SCAN rather than merely slice its output.
    if (candidates.length >= opts.maxRows) {
      capped = true;
      break;
    }
    // NOTHING ELSE STOPS THIS LOOP. The deleted-probe bound deliberately does
    // NOT break here (fix wave 2): stopping the walk turned a wall of hidden
    // deleted threads into a page of zero rows with no cursor, in a world that
    // still had live unread behind it. The bound stops READING; the walk runs
    // to the cap, the supply, or the budget as it always did.
  }

  return {
    candidates,
    // Layer 1's position is ALWAYS the right answer for layer 2. On the cap
    // break the generator is suspended at the yield of the item just consumed,
    // so the position IS that item; on a natural end every yielded item was
    // consumed, so reporting the raw position additionally carries the walk
    // past a trailing invisible run instead of re-scanning it next time.
    ...(state.scanPosition !== undefined && { scanPosition: state.scanPosition }),
    // The cap stopping emission tells us NOTHING about the remaining supply or
    // budget, so it excludes both other outcomes.
    consumedAll: !capped && state.scanExhausted,
    // A DRAINED STREAM IS A NATURAL END, EVEN WITH SKIPPED THREADS BEHIND IT
    // (fix wave 3, adversarial r3 finding 2). Fix wave 2 ORed
    // `skippedDeletedThreads > 0` in here, which made a residue-only org that is
    // GENUINELY caught up report a floor forever: zero rows plus `truncated` is
    // the client's inbox-FAILURE state, over a deterministic prefix whose Retry
    // reproduces it. The assumption made past the probe bound is "hidden" - the
    // overwhelmingly likely truth inside a wall of confirmed-hidden threads -
    // and a hidden row is exactly what an empty page means. `truncated` keeps
    // its spec 4.5 step 3 meaning: rows this reader WOULD have shown were
    // withheld, i.e. the scan stopped early. `skippedDeletedThreads` is still
    // returned, and the deleted-probe WARN is what tells the operator the wall
    // is there.
    truncated: !capped && !state.scanExhausted,
    capped,
    remainingBudget: Math.max(0, opts.budget - state.scanned),
    deletedProbes,
    wastedProbes,
    skippedDeletedThreads,
  };
}
