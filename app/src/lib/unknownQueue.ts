// app/src/lib/unknownQueue.ts
//
// The Unknown inbox tab's triage-partition read (design 2026-08-25,
// docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md).
//
// One bounded walk of the (type='unknown') byTypeStatus partition. The
// protections are copied from the today.ts:843-940 precedent WITH THEIR
// REASONS, keeping only the reasons that still hold (spec section 2):
//
//   KEPT - the fill loop: the repo's soft-delete scope is a FilterExpression,
//   applied AFTER `Limit`, and soft-deleted unknowns accumulate in this
//   partition FOREVER (softDelete touches neither type nor status; spam and
//   wrong numbers are exactly what an operator deletes from a triage queue).
//   So a page thick with residue returns short - even EMPTY - pages WITH a
//   lastEvaluatedKey, and a reader without the loop renders "nothing needs
//   triage" over a queue that has rows. The loop breaks on rows KEPT, never
//   rows read.
//
//   KEPT - the hard cap on the RESULT: the loop breaks on >=, so the last
//   page can overshoot; the slice is what actually bounds the response.
//
//   KEPT - the truncation WARN: a walk that ends with rows still behind it
//   must never end silently (the precedent's "loud problem turned silent").
//
//   NOT COPIED - `status: 'needs_review'`: a contact CREATED as unknown
//   defaults to status 'active' (routes/contacts.ts:881-884), so
//   (unknown, active) is the DEFAULT, not an edge case - class f. The type
//   alone is the queue: triage retypes the contact out of the partition.
//
//   NOT COPIED - `excludeOrigin: GROUP_DETECTION_ORIGIN`: today.ts can afford
//   that exclusion ONLY because it is a two-source union ("a real unknown
//   caller who TEXTED still surfaces through the conversation-row source").
//   This reader has no second source; a detection-minted stub keeps its origin
//   forever, so a roster member who later texts in would be silently dropped -
//   class a. And the exclusion buys nothing here: a threadless stub yields no
//   open thread and therefore no row anyway.
import { logger as defaultLogger, type Logger } from './logger.js';
import type { ContactItem, ContactsRepo, ContactType } from '../repos/contactsRepo.js';

/** Rows fetched per partition Query while filling the queue. */
export const UNKNOWN_QUEUE_PAGE_SIZE = 100;

/**
 * Sequential Queries ONE request may spend walking past soft-deleted residue.
 * The same bound shape as today.ts's TRIAGE_MAX_PAGES (10): up to
 * maxPages * pageSize rows read to keep a partition of residue from spinning.
 */
export const UNKNOWN_QUEUE_MAX_PAGES = 10;

/**
 * Hard cap on the queue RESULT. 200 = 2x the route's MAX_INBOX_LIMIT, and far
 * above the measured partitions (16 dev / 7 prod, 2026-08-25) - it exists so
 * the in-memory sort and per-row hydration stay bounded when the partition
 * grows, not because anyone expects to hit it soon.
 */
export const UNKNOWN_QUEUE_MAX_ROWS = 200;

/**
 * Class g (spec section 3): `roleFromContact` is a FALL-THROUGH (anything not
 * tenant/landlord/partner renders as 'unknown') while `listByType('unknown')`
 * is an EXACT MATCH - the two predicates agree only on the types that exist
 * today. This map forces the decision: adding a ContactType member without an
 * entry here is a TYPECHECK failure, so a new type can never silently be
 * "on the tab but absent from the query".
 *
 * AND IT IS LOAD-BEARING, not a decoration: `UNKNOWN_QUEUE_TYPES` below is
 * DERIVED from it and is what the collector queries and what the resurfacing
 * sweep admits - so a type mapped 'queried' here IS queried, and a decorative
 * drift between the map and the behaviour cannot exist.
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

/** The partitions the triage queue reads - derived, never hand-listed. */
export const UNKNOWN_QUEUE_TYPES: readonly ContactType[] = (
  Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, 'queried' | 'excluded'][]
)
  .filter(([, decision]) => decision === 'queried')
  .map(([type]) => type);

export interface UnknownQueueResult {
  /**
   * At most `maxRows` live (non-deleted) queue contacts, in PARTITION order -
   * this index has NO activity dimension (its range key is `status`), so when
   * the cap or the page budget cuts this list, the cut is ARBITRARY with
   * respect to recency: the newest untriaged contact can be among the hidden
   * rows. The caller's newest-first sort orders only what survived the cut.
   */
  contacts: ContactItem[];
  pagesWalked: number;
  /**
   * Rows may remain behind this result: the page budget ran out with a
   * lastEvaluatedKey still in hand, or the result cap cut the collection.
   * CONSERVATIVE at exact page multiples: the service returns a LEK whenever
   * the Limit was reached, so a partition of exactly n * pageSize rows ends
   * with a key in hand and "nothing behind it" is unknowable without paying
   * another Query - a spurious floor claim is accepted over that cost.
   * Already WARNed here; the caller decides nothing else.
   */
  truncated: boolean;
}

/**
 * LOUD BY CONTRACT: this collector does not catch. inbox.ts's norm is
 * best-effort hydration, but a failed triage-partition Query must NOT degrade
 * to an empty queue - "no unknown contacts" and "the query broke" would be
 * indistinguishable, and the failure mode is the entire triage queue silently
 * vanishing behind a healthy-looking empty state. Same posture, same reason as
 * the inbox group source (inbox.ts readGroupSource); the route's 500 is the
 * honest answer.
 */
export async function collectUnknownTriageQueue(
  deps: { contacts: Pick<ContactsRepo, 'listByType'>; logger?: Logger },
  opts: { pageSize: number; maxPages: number; maxRows: number },
): Promise<UnknownQueueResult> {
  const log = deps.logger ?? defaultLogger;
  const collected: ContactItem[] = [];
  // NOTE on the multi-partition generality (round-3 review): with exactly one
  // 'queried' type in the map today, the second-partition path below is
  // UNEXERCISED - no test drives it, and the cap-with-types-remaining guard is
  // dead code until a second type is mapped. Whoever maps one must also know:
  // `maxPages` bounds EACH partition's walk, so the total read ceiling becomes
  // types.length * maxPages * pageSize, while `pagesWalked` (and the WARN's
  // `pages` field) is the REQUEST total across partitions - a request total
  // reported against a per-partition bound. Add a two-type test then.
  let pagesWalked = 0;
  let exhaustedAll = true;
  const types = [...UNKNOWN_QUEUE_TYPES];
  for (let t = 0; t < types.length; t += 1) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let exhausted = false;
    // `maxPages` bounds each PARTITION's walk (one partition exists today).
    for (let page = 0; page < opts.maxPages; page += 1) {
      pagesWalked += 1;
      const read = await deps.contacts.listByType(types[t]!, {
        limit: opts.pageSize,
        ...(exclusiveStartKey !== undefined && { exclusiveStartKey }),
      });
      collected.push(...read.items);
      exclusiveStartKey = read.lastEvaluatedKey;
      if (exclusiveStartKey === undefined) {
        exhausted = true;
        break;
      }
      // Break on rows KEPT, never rows read: a filtered (deleted) row spends a
      // page slot but must not spend the queue's budget-to-show.
      if (collected.length >= opts.maxRows) break;
    }
    if (!exhausted) exhaustedAll = false;
    if (collected.length >= opts.maxRows) {
      // Cap hit with partitions still unvisited -> rows remain by definition.
      if (t < types.length - 1) exhaustedAll = false;
      break;
    }
  }
  const contacts = collected.slice(0, opts.maxRows);
  const truncated = !exhaustedAll || contacts.length < collected.length;
  if (truncated) {
    // The precedent's WARN (today.ts:884-889): counts only, no PII. The copy
    // names the ordering caveat because the operator-facing list LOOKS
    // newest-first while the hidden rows were chosen by index order.
    log.warn(
      { pages: pagesWalked, kept: contacts.length, collected: collected.length },
      'inbox: the unknown-queue walk ended with untriaged contacts still behind it - the cut is in index order, so the newest untriaged contact may be among the hidden rows',
    );
  }
  return { contacts, pagesWalked, truncated };
}
