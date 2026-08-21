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
// any other PII - these lists are tenants and landlords) and sets `truncated` on
// the result.
//
// HONESTLY: as of 2026-08-20 NO caller reads `truncated` - every one destructures
// `{ items }`. So at the UI a cap hit is still only a console warning, exactly as
// it was before this module existed. The flag is the hook for surfacing it, not
// the surfacing itself; treat "callers should surface this" as work outstanding,
// not a guarantee delivered. At 50 pages x 100 rows the cap needs 5,000 records,
// so it is latent rather than live.

/** Page-walk bound. A hard stop so a pathological or never-nulling cursor can
 *  never spin forever. At the 100-row page size below that is 5,000 records per
 *  list - far past Phase-1 scale, and a hit warns rather than truncating quietly. */
export const MAX_PAGES = 50;

/** The server's MAX_PAGE_LIMIT. Asking for it halves the round trips a full walk
 *  costs (the server's default page is 50). It is a CEILING, not a hint: routes
 *  accept 1..100 and 400 anything outside that (`parseLimit`) rather than
 *  clamping, so raising this breaks every list view on first load. */
export const PAGE_LIMIT = '100';

export interface FetchAllPagesResult<TItem> {
  items: TItem[];
  /** True when the walk stopped on the page cap with a cursor still outstanding
   * - the list is a PREFIX. Callers that must not present a partial list as a
   *  complete one should surface this. */
  truncated: boolean;
}

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
 */
export async function fetchAllPages<TPage, TItem>(
  fetchPage: (cursor?: string) => Promise<TPage>,
  select: (page: TPage) => { items: TItem[]; nextCursor: string | null },
  opts: { label: string; maxPages?: number },
): Promise<FetchAllPagesResult<TItem>> {
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
      return { items, truncated: true };
    }
  } while (cursor !== undefined);

  return { items, truncated: false };
}
