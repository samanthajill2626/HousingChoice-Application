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
//
// KEY SHAPE (rule 5's other half): the real repo hands back DynamoDB's raw
// `LastEvaluatedKey` from a GSI Query (contactsRepo.ts:1021-1025), which
// carries the INDEX keys plus the table key - `{ type, status, contactId }`,
// not `{ contactId }` alone. This fake mints that full shape so the one helper
// positioned as the authority on partition semantics does not pin a key
// production never emits. RESUMING, however, reads only `contactId`: that is
// the field this fake needs to find its position, and a test may hand back any
// key that carries it.
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
    .filter((c) => (opts.status === undefined ? true : c.status === opts.status));
  const start =
    typeof opts.exclusiveStartKey?.['contactId'] === 'string'
      ? partition.findIndex((c) => c.contactId === opts.exclusiveStartKey?.['contactId']) + 1
      : 0;
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
