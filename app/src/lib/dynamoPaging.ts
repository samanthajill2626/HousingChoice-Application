// dynamoPaging - THE cursor walk for repo reads that must return a WHOLE result
// set rather than one DynamoDB page.
//
// WHY THIS EXISTS: a Query answers with at most 1 MB of items and a
// LastEvaluatedKey when more remain. Several repo methods dropped that key and
// returned the first page as if it were everything - the same silent-truncation
// class that made the tenant typeahead offer 50 of 641 tenants. A per-entity
// query (one tenant's tours, one unit's sends) only bites at 1 MB, so the defect
// hides for a long time and then appears as quietly missing rows.
//
// Use this for a query whose caller wants the complete set. A caller that pages
// for the CLIENT (a route serving `nextCursor`) must keep doing that instead -
// this helper is for internal reads that are logically "all of them".
import { QueryCommand, type DynamoDBDocumentClient, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';

/** Safety cap so a pathological or never-nulling cursor cannot loop forever.
 *  At 1 MB per page this is far past any per-entity result set. */
const DEFAULT_MAX_PAGES = 100;

/**
 * Run a Query to exhaustion, concatenating every page's items.
 *
 * The caller's `ExclusiveStartKey` (if any) seeds the walk; each subsequent page
 * is fetched with the previous page's `LastEvaluatedKey`. Note that passing a
 * `Limit` bounds each PAGE, not the total - the walk still runs to exhaustion.
 */
export async function queryAll<T>(
  doc: DynamoDBDocumentClient,
  input: QueryCommandInput,
  opts: { maxPages?: number } = {},
): Promise<T[]> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const out: T[] = [];
  let startKey = input.ExclusiveStartKey;
  let pages = 0;

  do {
    const { Items, LastEvaluatedKey } = await doc.send(
      new QueryCommand({ ...input, ...(startKey !== undefined && { ExclusiveStartKey: startKey }) }),
    );
    out.push(...((Items ?? []) as T[]));
    // An EMPTY page can still carry a key (Limit is applied before any
    // FilterExpression), so the KEY - never the item count - ends the walk.
    startKey = LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
  } while (startKey !== undefined && pages < maxPages);

  return out;
}
