// app/test/helpers/contactsPartitionFake.ts
//
// Models contactsRepo.listByType the way DynamoDB executes it:
//   1. The GSI is SPARSE: byTypeStatus is (hash: type, range: status), and an
//      item missing a key attribute is not indexed - a status-less contact is
//      invisible here no matter its type (lib/tables.ts:90-93).
//   2. The partition is (type, optional status) - both are KEY conditions,
//      applied before paging.
//   3. `Limit` slices the page NEXT, from exclusiveStartKey.
//   4. The FilterExpressions - the soft-delete scope and `excludeOrigin` -
//      apply to the PAGE, so a filtered-out row still spends its page slot and
//      a short (even EMPTY) page can carry a lastEvaluatedKey.
//   5. `lastEvaluatedKey` is returned whenever the page REACHED the Limit -
//      "Limit reached", NOT "rows remain". That is the service's rule (see
//      helpers/unreadIndexFake.ts:104-117, which documents and guards this
//      exact trap): a walk over exactly n * limit rows costs one MORE round
//      trip than items-remaining modelling suggests, and call-count pins built
//      on the weaker model are one Query short of production.
//   6. The partition is SORTED BY THE RANGE KEY, ascending: `status` first,
//      then the table key `contactId` as the tie-break. A Query returns the
//      partition in range-key order unless it sets `ScanIndexForward: false`,
//      and contactsRepo.listByType sets NO such key (contactsRepo.ts:1009-1020)
//      - so ASCENDING on `status` is what production does, and that half
//      carries rules 1-5's confidence.
//
//      THE TIE-BREAK IS THIS FAKE'S OWN CONVENTION AND CONTRADICTS THE REAL
//      SERVICE (corrected 2026-08-26, rework review A5; weakened once before,
//      on 2026-08-25, from an even flatter claim - twice wrong, so read this
//      before restating it a third time). AWS documents that results are
//      ordered by the sort-key VALUE and that a GSI's index key need not be
//      unique; it does not specify the order among items that SHARE one, and
//      DynamoDB Local demonstrably does NOT use `contactId`. MEASURED: four
//      items with identical (type='unknown', status='needs_review') and ids
//      c1..c4, queried through a real byTypeStatus-shaped GSI, came back
//      `c2, c4, c1, c3` - the index's internal (hashed table key) order.
//      Resuming from c2 returned `c4, c1, c3`, so the real order IS stable and
//      ESK resume IS consistent with it; only the SHAPE of the order is
//      invented here.
//
//      `contactId` ascending is chosen because a test needs ONE deterministic,
//      READABLE order to write exact page-composition pins against - not
//      because production produces it. today.ts:844-853 words the real fact
//      correctly one file over ("intra-partition order is stable and the same
//      100 rows come back every time", deliberately not "ascending by
//      contactId"). Several pins lean on this convention; NOTHING in production
//      may. Do not build an ordering guarantee, a cursor scheme, or a
//      "first N rows" argument on it - and note that the real-index walk in
//      test/inbox.integration.test.ts sorts before comparing precisely because
//      it cannot lean on this.
//
//      WHY THIS RULE EXISTS (added by the 2026-08-25 fix wave, adversarial
//      finding HIGH-1; rationale corrected 2026-08-26, rework review B4).
//      Returning items in SEED-ARRAY order made the partition's most
//      consequential property INEXPRESSIBLE. Within `type='unknown'` the only
//      legal statuses are 'needs_review' and 'active' (NON_TENANT_STATUSES,
//      lib/statusModel.ts:194) and 'active' < 'needs_review' lexicographically,
//      so an UN-NARROWED Query returns EVERY 'active' unknown before ANY
//      'needs_review' one. That is what made the deleted result cap and page
//      budget cut STATUS-FIRST and starve the status meaning "nobody has looked
//      at this yet" - and no test in the suite could state it until this fake
//      modelled the sort.
//
//      THOSE BOUNDS ARE GONE (2026-08-26: the reader now issues one Query per
//      status BLOCK and pages with the index's own cursor), and so is the pin
//      this paragraph used to cite - test/unknownQueue.test.ts's "the cap
//      starves needs_review". What the sort model buys NOW is that BLOCK ORDER
//      is expressible at all: the replacement pin, "the UNTRIAGED block is
//      exhausted BEFORE the reviewed block is read", is a statement about
//      range-key order and is vacuous against a seed-order fake.
//
// KEY SHAPE (rule 5's other half): the real repo hands back DynamoDB's raw
// `LastEvaluatedKey` from a GSI Query (contactsRepo.ts:1021-1025), which
// carries the INDEX keys plus the table key - `{ type, status, contactId }`,
// not `{ contactId }` alone. This fake mints that full shape so the one helper
// positioned as the authority on partition semantics does not pin a key
// production never emits. RESUMING reads `status` + `contactId` and seeks to
// that POSITION in the sort order (see the resume block below); a key that
// cannot express a position - one carrying `contactId` alone - THROWS.
//
// FAKE-ONLY CAVEAT on rule 5: `limit ?? 50` SYNTHESIZES a Limit for a caller
// that passes none, so an un-limited call over a partition of exactly 50+ rows
// reports "Limit reached" and mints a LEK where the real repo omits `Limit`
// entirely and pages at 1MB. Inert for every current caller (the collector
// always passes pageSize); pass an explicit `limit` in any new test that
// walks a partition of 50 or more.
// A fake that filters before slicing can never exercise the fill loop the
// unknown-queue read carries (docs/superpowers/specs/
// 2026-08-25-inbox-unknown-tab-walk-design.md, section 3 class d), and a fake
// that ignores `status`/`excludeOrigin` makes the "no narrowing" mutation
// probes vacuous. The webhook harness's own fake keeps its historical
// deleted-before-limit, items-remaining shape for the suites calibrated
// against it (the today.ts triage pins); new tests use this one.
import {
  isDeleted,
  type ContactItem,
  type ContactsPage,
  type ListContactsOpts,
} from '../../src/repos/contactsRepo.js';

export function listByTypeFromContacts(
  contacts: readonly ContactItem[],
  type: string,
  opts: ListContactsOpts = {},
): ContactsPage {
  const partition = contacts
    // Pointer items carry no real type/status -> invisible to this GSI.
    .filter((c) => c.phone_ref !== true && c.email_ref !== true)
    // SPARSE index: no range-key attribute, no index entry (rule 1).
    .filter((c) => c.status !== undefined)
    .filter((c) => c.type === type)
    .filter((c) => (opts.status === undefined ? true : c.status === opts.status))
    // RANGE-KEY SORT (rule 6): ascending `status`, then `contactId`. Seed-array
    // order is NOT what a Query returns, and the difference is load-bearing -
    // see the rule's note. `status` is non-undefined here (the sparse filter
    // above), so the String() coercions are for the type checker only.
    .slice()
    .sort((a, b) => {
      const sa = String(a.status);
      const sb = String(b.status);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0;
    });
  // RESUME IS POSITIONAL, not identity-based (2026-08-26). DynamoDB does not
  // require an ExclusiveStartKey to name an item that still exists - it seeks
  // to the key's POSITION in the sort order and returns everything after it -
  // and the unknown-queue reader now mints its cursor from a CONSUMED
  // contact's own (type, status, contactId), so a contact re-typed or deleted
  // between two requests is exactly the ordinary case. An identity findIndex
  // returns -1 there and, +1, silently RESTARTS the partition, which would
  // model the paging bug (duplicate rows on page 2) as correct behaviour.
  //
  // Compares the (status, contactId) tuple, matching the sort in rule 6.
  //
  // A KEY CARRYING NO `status` THROWS (2026-08-26, rework review B5). It used
  // to fall back to `findIndex(identity) + 1` "because a hand-built key is
  // allowed to carry contactId alone" - which is the EXACT silent-restart bug
  // the positional path above was written to remove (`-1 + 1` is 0, i.e. page
  // one again, which models duplicate rows on page 2 as correct behaviour).
  // The fallback was also DEAD: every consumer of this helper passes either no
  // key or a `lastEvaluatedKey` this fake minted, and the fake has minted the
  // full three-attribute key since it was written. Returning `start = 0`
  // instead of throwing would be the same silent restart by another route, so a
  // key that cannot express a position is a LOUD test failure.
  const startKey = opts.exclusiveStartKey;
  const startContactId =
    typeof startKey?.['contactId'] === 'string' ? startKey['contactId'] : undefined;
  const startStatus = typeof startKey?.['status'] === 'string' ? startKey['status'] : undefined;
  let start = 0;
  if (startContactId !== undefined && startStatus !== undefined) {
    start = partition.findIndex((c) => {
      const s = String(c.status);
      if (s !== startStatus) return s > startStatus;
      return c.contactId > startContactId;
    });
    if (start === -1) start = partition.length;
  } else if (startKey !== undefined) {
    throw new Error(
      'contactsPartitionFake: exclusiveStartKey must carry BOTH status and contactId ' +
        '(the real GSI key shape - see KEY SHAPE); a positionless key would silently restart the partition',
    );
  }
  const limit = opts.limit ?? 50;
  const page = partition.slice(start, start + limit);
  const filtered = page
    .filter((c) => (opts.deleted === true ? isDeleted(c) : !isDeleted(c)))
    .filter((c) => opts.excludeOrigin === undefined || c.origin !== opts.excludeOrigin);
  const last = page[page.length - 1];
  // LIMIT REACHED, not "rows remain" (rule 5): the service stops at the Limit
  // and hands back the position; the caller must ask again to learn the
  // stream ended.
  const limitReached = page.length === limit;
  return {
    items: filtered,
    ...(limitReached &&
      last !== undefined && {
        lastEvaluatedKey: {
          type: last.type,
          status: last.status,
          contactId: last.contactId,
        },
      }),
  };
}
