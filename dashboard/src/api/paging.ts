// paging - THE cursor walk for every paged list endpoint.
//
// WHY THIS EXISTS: the server pages every list endpoint (`nextCursor`), and for
// a long time each caller decided for itself whether to follow it. Three
// hand-rolled walkers drifted apart (caps of 40/40/50, only one asking for the
// 100-row page), and every OTHER caller silently read page one and treated it
// as the whole list. That shipped: the Schedule-a-tour tenant picker offered 50
// of the 641 tenants prod held on 2026-08-20, because DynamoDB returns the
// `byTypeStatus` partition ordered
// by `status` and `searching` sorts last - so 92% of the roster, including
// nearly every active tenant, was unpickable.
//
// The failure is silent by construction: a short list looks like a complete
// list. So the rule is ONE walker, and any caller that needs a whole list uses
// it - never a bare first-page read.
//
// A cap hit logs a warning with COUNTS ONLY (never a record id, name, phone, or
// any other PII - these lists are tenants and landlords).
//
// It does NOT return a "truncated" flag. One existed briefly and no caller ever
// read it - which made it worse than nothing, because an unread flag makes a
// problem look handled. It was deleted deliberately: at 50 pages x 100 rows the
// cap needs 5,000 records, and a client-side typeahead filtering 5,000 rows is
// already the wrong design well before it is a correctness problem. The remedy
// at that scale is server-side search, not a "list may be incomplete" banner -
// see docs/issues/typeahead-scale-needs-server-side-search.md.

/** Page-walk bound. A hard stop so a pathological or never-nulling cursor can
 *  never spin forever. At the 100-row page size below that is 5,000 records per
 *  list - far past Phase-1 scale, and a hit WARNS rather than truncating quietly. */
export const MAX_PAGES = 50;

/** The server's MAX_PAGE_LIMIT. Asking for it halves the round trips a full walk
 *  costs (the server's default page is 50). It is a CEILING, not a hint: routes
 *  accept 1..100 and 400 anything outside that (`parseLimit`) rather than
 *  clamping, so raising this breaks every list view on first load. Two routes
 *  are the documented exception and are NOT walked by this helper: /api/inbox
 *  and /api/ai-runs clamp an oversized limit and fall back to their default on
 *  an empty, zero or negative one (docs/issues/inbox-parselimit-empty-one-row.md). */
export const PAGE_LIMIT = '100';

/**
 * Follow `nextCursor` until the endpoint stops handing one back, concatenating
 * every page's items.
 *
 * `select` adapts one endpoint's page shape ({ contacts, nextCursor },
 * { units, nextCursor }, ...) to the { items, nextCursor } this walk needs, so a
 * single implementation serves every list endpoint.
 *
 * Rejections PROPAGATE unchanged - an AbortError from a cancelled effect must
 * reach the caller's catch so it can bail without committing state.
 *
 * Returns the concatenated items. A cap hit warns and returns the PREFIX; see
 * the header for why there is no flag.
 */
export async function fetchAllPages<TPage, TItem>(
  fetchPage: (cursor?: string) => Promise<TPage>,
  select: (page: TPage) => { items: TItem[]; nextCursor: string | null },
  opts: { label: string; maxPages?: number },
): Promise<TItem[]> {
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const items: TItem[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const { items: pageItems, nextCursor } = select(await fetchPage(cursor));
    items.push(...pageItems);
    pages += 1;
    // An EMPTY page can still carry a cursor: DynamoDB applies `Limit` at the
    // index BEFORE any FilterExpression (soft-delete scope, origin exclusion),
    // so a page of all-filtered rows returns nothing with more still to come.
    // Stopping on emptiness rather than on the cursor would truncate the list.
    cursor = nextCursor ?? undefined;
    if (cursor !== undefined && pages >= maxPages) {
      // Counts only - these lists are people.
      console.warn(
        `fetchAllPages(${opts.label}): hit the ${maxPages}-page cap after ${items.length} records; list truncated`,
      );
      return items;
    }
  } while (cursor !== undefined);

  return items;
}
