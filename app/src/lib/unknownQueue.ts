// app/src/lib/unknownQueue.ts
//
// The Unknown inbox tab's triage-partition READER (design 2026-08-25,
// docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md; reworked
// 2026-08-26 by human ruling into an unbounded, cursor-paged read).
//
// WHAT CHANGED, and why it is the whole point of the file. The first version
// read the (type='unknown') partition ONCE, up to a hard result cap, sorted the
// collection by activity in memory and served the first `limit` rows with NO
// cursor. Two consequences, both filed as HIGH findings:
//
//   * rows past that window were UNREACHABLE - no cursor was minted and any
//     cursor 400'd, so nothing an operator could click reached row 31; and
//   * the cap cut in STATUS order, not arbitrarily. byTypeStatus is
//     (hash: type, range: status), contactsRepo.listByType sets no
//     `ScanIndexForward`, and 'active' < 'needs_review' - so the cut KEPT the
//     already-reviewed rows and discarded the untriaged ones, the queue
//     starving at exactly its own job.
//
// THE ROOT CAUSE OF THE CAP WAS THE SORT. `ContactItem` carries no activity
// attribute at all (activity lives on conversations), so a global newest-first
// ordering forces the reader to resolve EVERY candidate's threads before it can
// order anything - i.e. to read the whole partition before rendering one row.
// That is what made a bound unavoidable.
//
// THE RULING (human, 2026-08-26): DROP the global activity sort and page in
// QUEUE ORDER instead - untriaged first, then reviewed - using the index's own
// cursor, which is unbounded and cheap. A triage queue's job is that nothing
// rots unseen; recency is what the All and Unread tabs are for. See
// docs/issues/unknown-queue-cap-starves-needs-review.md and
// docs/issues/denormalize-contact-last-activity-for-ordered-paging.md.
//
// WHAT SURVIVED FROM THE today.ts:843-940 PRECEDENT, with its reason:
//
//   KEPT - the fill loop: the repo's soft-delete scope is a FilterExpression,
//   applied AFTER `Limit`, and soft-deleted unknowns accumulate in this
//   partition FOREVER (softDelete touches neither type nor status; spam and
//   wrong numbers are exactly what an operator deletes from a triage queue).
//   So a page thick with residue returns short - even EMPTY - pages WITH a
//   lastEvaluatedKey, and a reader without the loop renders "nothing needs
//   triage" over a queue that has rows.
//
//   REPLACED - the result cap and the page budget: a per-request SCAN BUDGET
//   (see UNKNOWN_QUEUE_SCAN_BUDGET) now bounds the RAW ROWS a request may
//   examine, and running out returns the rows found so far PLUS the position to
//   resume at. Nothing is withheld, so there is nothing to WARN about.
//
//   NOW COPIED, and this is the reworked half - `status` NARROWING. The reader
//   issues one bounded Query PER STATUS BLOCK, in the order
//   UNKNOWN_QUEUE_BLOCKS declares. COVERAGE DOES NOT NARROW: every legal status
//   is a block and every block is read, so a live (unknown, active) contact -
//   coverage class f - is still on the tab exactly as before. Only the ORDER
//   changed. The old file said "NOT COPIED - status: 'needs_review'" because
//   narrowing to ONE status would have dropped class f; narrowing to a
//   PARTITION OF ALL of them drops nothing.
//
//   WHAT MANUFACTURES (unknown, active) AT ALL (round-2 finding N3): the
//   STATUS-ONLY triage PATCH. PATCH /api/contacts/:id handles
//   `'status' in patch && !('type' in patch)` and re-validates against
//   statusAllowlistFor(stored.type), which for `unknown` is
//   ['needs_review','active'] - and the dashboard's edit form reaches it. An
//   operator can therefore mark an unknown contact `active` while it stays
//   type='unknown': it leaves Today's triage block (which DOES narrow on
//   needs_review) but it NEVER leaves this queue. Only a RE-TYPE - to ANY other
//   ContactType, team_member included - or a SOFT-DELETE drains a row. It is
//   also the only UI-REACHABLE manufacturer: POST /api/contacts defaults an
//   `unknown` create to status 'active' but that is API-ONLY (KindPicker,
//   dashboard/src/routes/contact/KindPicker.tsx, offers no `unknown` segment),
//   which is why both deployed environments measure ZERO (unknown, active)
//   today. Under the OLD reader that population was a starvation hazard,
//   because `active` sorted first and crowded out the front door. Under this
//   one it is simply the SECOND block, read after the untriaged one is drained.
//
//   NOT COPIED - `excludeOrigin: GROUP_DETECTION_ORIGIN`: today.ts can afford
//   that exclusion ONLY because it is a two-source union ("a real unknown
//   caller who TEXTED still surfaces through the conversation-row source").
//   This reader has no second source; a detection-minted stub keeps its origin
//   forever, so a roster member who later texts in would be silently dropped -
//   class a. And the exclusion buys nothing here: a threadless stub yields no
//   open thread and therefore no row anyway.
import { NON_TENANT_STATUSES } from './statusModel.js';
import type { ContactItem, ContactsRepo, ContactType } from '../repos/contactsRepo.js';

/** Rows fetched per block Query while filling a page. */
export const UNKNOWN_QUEUE_PAGE_SIZE = 100;

/**
 * Roughly how many raw index rows ONE request may examine before it stops and
 * hands back the position it stopped at.
 *
 * ROUGHLY, AND IN BOTH DIRECTIONS - the accounting is deliberately loose and
 * this number is not a hard ceiling (round-1 review A6, adjudicated as accepted
 * 2026-08-26; the docblock used to state it as an exact bound):
 *
 *   * OVER-SPEND, up to `budget + pageSize - 1`. The budget check runs BEFORE
 *     the Query, so a read sitting at `budget - 1` still issues one more page
 *     and charges up to `pageSize` for it - 1099 against a stated 1000 at
 *     today's constants.
 *   * UNDER-CHARGE, up to `blocks.length * (pageSize - 1)` = 198. A page with
 *     no LastEvaluatedKey ended its block, so it is charged `items.length` -
 *     the count AFTER the soft-delete FilterExpression - and the rows the
 *     filter ate are examined for free. One such page exists per block.
 *
 * Neither affects TERMINATION, which is what the budget exists for: the charge
 * per page that has more behind it is exactly `pageSize` against a strictly
 * decreasing budget. They are accepted rather than fixed because tightening
 * them buys nothing at two orders of magnitude below the number.
 *
 * THIS IS A SCAN BUDGET, NOT A RESULT CAP, and the distinction is the whole
 * rework. Deciding whether a queue contact is KEPT costs a thread resolution
 * (see inbox.ts's `resolveOpenThreads`), so a partition full of threadless
 * group-detection stubs, or of soft-deleted residue the FilterExpression eats
 * after `Limit`, could scan without end trying to fill one page. This bounds
 * that. Running out is NOT truncation: the caller returns the rows it found
 * plus the cursor it stopped at, and the next request continues from there.
 *
 * Generous on purpose - the measured partitions are 16 dev / 7 prod
 * (2026-08-25), two orders of magnitude below this. It exists so a pathological
 * partition costs a short page rather than a slow one.
 */
export const UNKNOWN_QUEUE_SCAN_BUDGET = 1000;

/**
 * Class g (spec section 3): `roleFromContact` is a FALL-THROUGH (anything not
 * tenant/landlord/partner renders as 'unknown') while `listByType('unknown')`
 * is an EXACT MATCH - the two predicates agree only on the types that exist
 * today. This map forces the decision: adding a ContactType member without an
 * entry here is a TYPECHECK failure, so a new type can never silently be
 * "on the tab but absent from the query".
 *
 * AND IT IS LOAD-BEARING, not a decoration: `UNKNOWN_QUEUE_BLOCKS` below is
 * DERIVED from it and is what the reader queries - so a type mapped 'queried'
 * here IS queried, and a decorative drift between the map and the behaviour
 * cannot exist.
 *
 * team_member is 'excluded' BY RULING (2026-08-25, spec section 7): it is the
 * internal-staff bucket and does not belong in an outside-contact triage
 * queue. The old tab showed them (the fall-through); that was the bug.
 */
export const UNKNOWN_TAB_TYPE_DECISIONS = {
  tenant: 'excluded',
  landlord: 'excluded',
  partner: 'excluded',
  team_member: 'excluded',
  unknown: 'queried',
} as const satisfies Record<ContactType, 'queried' | 'excluded'>;

/** The types the triage queue reads - derived, never hand-listed. */
export const UNKNOWN_QUEUE_TYPES: readonly ContactType[] = (
  Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, 'queried' | 'excluded'][]
)
  .filter(([, decision]) => decision === 'queried')
  .map(([type]) => type);

/**
 * The statuses a `type='unknown'` contact may legally carry. Taken from
 * NON_TENANT_STATUSES, which is what `statusAllowlistFor('unknown')` returns -
 * ONE source of truth, so a new legal status cannot appear in the allowlist and
 * be missing here. test/unknownQueue.test.ts pins the two against each other at
 * runtime as well, because the type alias alone would not catch a change made
 * only inside statusAllowlistFor.
 */
type UnknownQueueStatus = (typeof NON_TENANT_STATUSES)[number];

/**
 * QUEUE ORDER, and the one place it is decided (human ruling 2026-08-26).
 *
 * Lower reads FIRST. `needs_review` means nobody has looked at this contact
 * yet, so it is the front door and it is drained before a single already-
 * reviewed row is read. That is what makes starvation structurally impossible
 * rather than merely unlikely: the untriaged block is EXHAUSTED before the
 * `active` block's first Query is issued.
 *
 * `satisfies Record<UnknownQueueStatus, number>` is the guard, in the same
 * load-bearing style as UNKNOWN_TAB_TYPE_DECISIONS above: a newly-legal status
 * for `unknown` is a TYPECHECK failure here, never a silent omission from the
 * tab.
 */
export const UNKNOWN_QUEUE_STATUS_ORDER = {
  needs_review: 0,
  active: 1,
} as const satisfies Record<UnknownQueueStatus, number>;

/** One (type, status) partition of the queue, read as a unit. */
export interface UnknownQueueBlock {
  readonly type: ContactType;
  readonly status: UnknownQueueStatus;
}

/**
 * WHICH PARTITIONS, IN WHAT ORDER - THE single named decision this reader
 * takes, deliberately isolated so it can be swapped whole.
 *
 * A follow-up will denormalise `last_activity_at` onto the contact record and
 * add an activity-ordered GSI
 * (docs/issues/denormalize-contact-last-activity-for-ordered-paging.md). When
 * it lands, THIS constant and the Query inside `readUnknownQueue` are what
 * change - the inbox branch that consumes rows, mints cursors, resolves threads
 * and hydrates a page does not have to be rewritten around it. Keep it that
 * way: anything that hard-codes "needs_review then active" outside this file
 * un-does the isolation.
 *
 * Derived from BOTH maps above (types x status order), never hand-listed.
 */
export const UNKNOWN_QUEUE_BLOCKS: readonly UnknownQueueBlock[] = UNKNOWN_QUEUE_TYPES.flatMap(
  (type) =>
    (Object.entries(UNKNOWN_QUEUE_STATUS_ORDER) as [UnknownQueueStatus, number][])
      .slice()
      .sort((a, b) => a[1] - b[1])
      .map(([status]) => ({ type, status }) as const),
);

/**
 * A resume point: which block, and where inside it.
 *
 * `key` is a byTypeStatus ExclusiveStartKey - `{ type, status, contactId }`,
 * the index keys plus the table key. Absent means "the block's first page",
 * which is also how a roll-over to the next block is expressed.
 */
export interface UnknownQueuePosition {
  /** Index into UNKNOWN_QUEUE_BLOCKS. */
  block: number;
  /** The block Query's ExclusiveStartKey; absent = start of the block. */
  key?: Record<string, unknown>;
}

/**
 * One live queue contact, paired with the position that resumes AFTER it.
 *
 * The `after` key is synthesized from the BLOCK's (type, status) plus the
 * contact's own id rather than from DynamoDB's LastEvaluatedKey, and that is
 * what makes paging exact: the caller consumes rows one at a time and stops the
 * instant its page is full, then mints a cursor from the LAST CONSUMED row. A
 * page LastEvaluatedKey could only ever name a PAGE boundary, so a caller that
 * filled mid-page would have to either overshoot its `limit` or drop rows it
 * had already read. The two are identical by construction - the Query narrowed
 * on (type, status), so every item it returns carries exactly those - and using
 * the block's values means a malformed stored image cannot produce a key that
 * points into a different partition.
 */
export interface UnknownQueueRow {
  contact: ContactItem;
  after: UnknownQueuePosition;
}

export interface UnknownQueueRead {
  /** Live (non-deleted) queue contacts, in queue order, oldest block first. */
  rows: UnknownQueueRow[];
  /**
   * Where to resume once EVERY returned row is consumed. Absent means the queue
   * is exhausted - every block was read to its end - which is the only thing
   * that ends paging.
   */
  next?: UnknownQueuePosition;
  /** Raw index rows this read charged against the budget. */
  scanned: number;
  /** Queries issued (one per block page). */
  queries: number;
  /** The read stopped because the scan budget ran out, not because it filled. */
  budgetSpent: boolean;
}

/**
 * Read forward through the queue's blocks, in order, until `want` live contacts
 * are in hand, the scan budget runs out, or every block is exhausted.
 *
 * LOUD BY CONTRACT: this reader does not catch. inbox.ts's norm is best-effort
 * hydration, but a failed triage-partition Query must NOT degrade to an empty
 * queue - "no unknown contacts" and "the query broke" would be
 * indistinguishable, and the failure mode is the entire triage queue silently
 * vanishing behind a healthy-looking empty state. Same posture, same reason as
 * the inbox group source (inbox.ts readGroupSource); the route's 500 is the
 * honest answer.
 *
 * THE FILL LOOP IS WHY THIS IS A LOOP AND NOT A QUERY. The soft-delete scope is
 * a FilterExpression applied AFTER `Limit`, so a page thick with soft-deleted
 * residue comes back short - even EMPTY - WITH a lastEvaluatedKey. Breaking on
 * "the page was empty" renders "nothing needs triage" over a queue that has
 * rows; the loop therefore breaks on rows KEPT and on the budget, never on a
 * short page.
 *
 * THE BUDGET IS CHARGED IN INDEX ROWS EXAMINED, not rows returned. DynamoDB
 * applies `Limit` to the rows it EVALUATES, before the FilterExpression, and
 * hands back a LastEvaluatedKey exactly when that Limit was reached - so a page
 * with a key examined precisely `pageSize` rows however few it returned, and
 * that is the number the residue-walking cost has to be measured in. A page
 * WITHOUT a key ended the block, so its exact examined count no longer matters
 * for termination and the returned count is charged instead.
 *
 * THE TWO SEAM GUARDS BELOW ARE WHAT MAKE THAT TERMINATION ARGUMENT TRUE, and
 * the caller's own (inbox.ts's fill-or-exhaust loop) states itself as if
 * `want >= 1` and `budget >= 1` were already guaranteed. They were not
 * (rework review A4, measured):
 *
 *   * `want < 1` is a TIGHT INFINITE SPIN WITH ZERO QUERIES. The loop breaks
 *     immediately on `rows.length >= want`, returns the UNCHANGED start
 *     position with `budgetSpent: false`, and the caller re-enters with the
 *     same position forever. It is a pure microtask spin - no Query, no timer,
 *     nothing downstream that could trip a runaway guard. `parseLimit` clamps
 *     to 1..100 so the HTTP route cannot reach it, but `aggregateInbox` is
 *     exported and app/scripts/profile-inbox.ts passes a case-supplied `limit`.
 *   * `budget < 1` marks `budgetSpent` before issuing any Query, so every
 *     request answers with an empty page and the SAME cursor the client sent -
 *     a Load more that never advances and never ends. Only reachable through
 *     the `unknownQueueScanBudget` dep seam (`0 ?? DEFAULT` is 0: nullish, not
 *     falsy).
 *
 * THEY THROW RATHER THAN CLAMPING OR RETURNING AN EMPTY PAGE, which is the same
 * LOUD-BY-CONTRACT posture as the un-caught Query above and for the same
 * reason: a no-op page is indistinguishable from "the triage queue is empty",
 * and this reader's whole contract is that those two must never look alike. A
 * caller asking for zero rows is a programming error, and it should read like
 * one.
 */
export async function readUnknownQueue(
  deps: { contacts: Pick<ContactsRepo, 'listByType'> },
  opts: {
    start?: UnknownQueuePosition;
    /** Live contacts to gather before returning. */
    want: number;
    /** Raw index rows this read may examine. */
    budget: number;
    pageSize: number;
  },
): Promise<UnknownQueueRead> {
  if (!Number.isInteger(opts.want) || opts.want < 1) {
    throw new Error(`readUnknownQueue: want must be a positive integer, got ${String(opts.want)}`);
  }
  if (!Number.isInteger(opts.budget) || opts.budget < 1) {
    throw new Error(
      `readUnknownQueue: budget must be a positive integer, got ${String(opts.budget)}`,
    );
  }
  const blocks = UNKNOWN_QUEUE_BLOCKS;
  let block = opts.start?.block ?? 0;
  let key = opts.start?.key;
  const rows: UnknownQueueRow[] = [];
  let scanned = 0;
  let queries = 0;
  let budgetSpent = false;

  while (block < blocks.length) {
    if (rows.length >= opts.want) break;
    if (scanned >= opts.budget) {
      budgetSpent = true;
      break;
    }
    const current = blocks[block]!;
    queries += 1;
    const page = await deps.contacts.listByType(current.type, {
      status: current.status,
      limit: opts.pageSize,
      ...(key !== undefined && { exclusiveStartKey: key }),
    });
    scanned += page.lastEvaluatedKey !== undefined ? opts.pageSize : page.items.length;
    for (const contact of page.items) {
      rows.push({
        contact,
        after: {
          block,
          key: { type: current.type, status: current.status, contactId: contact.contactId },
        },
      });
    }
    if (page.lastEvaluatedKey === undefined) {
      // BLOCK EXHAUSTED -> roll over. The next block starts at its first page,
      // which is what an absent `key` means. When this was the LAST block the
      // while condition ends the walk and `next` below is undefined - the one
      // and only signal that paging is over.
      block += 1;
      key = undefined;
    } else {
      key = page.lastEvaluatedKey;
    }
  }

  const next: UnknownQueuePosition | undefined =
    block >= blocks.length ? undefined : { block, ...(key !== undefined && { key }) };
  return { rows, ...(next !== undefined && { next }), scanned, queries, budgetSpent };
}
