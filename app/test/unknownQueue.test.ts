// app/test/unknownQueue.test.ts
// The triage-partition collector: fill loop, result cap, truncation WARN, and
// the two protections the design REMOVES (status narrowing, excludeOrigin) as
// mutation probes that can actually go red - the fake honors both options.
import { describe, expect, it, vi } from 'vitest';
import {
  collectUnknownTriageQueue,
  UNKNOWN_QUEUE_MAX_PAGES,
  UNKNOWN_QUEUE_MAX_ROWS,
  UNKNOWN_QUEUE_PAGE_SIZE,
  UNKNOWN_QUEUE_TYPES,
  UNKNOWN_TAB_TYPE_DECISIONS,
} from '../src/lib/unknownQueue.js';
import type { ContactItem, ContactType, ListContactsOpts } from '../src/repos/contactsRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';

function unk(n: number, over: Partial<ContactItem> = {}): ContactItem {
  return {
    contactId: `c-unk-${String(n).padStart(3, '0')}`,
    type: 'unknown',
    status: 'needs_review',
    phone: `+1555${String(1_000_000 + n).padStart(7, '0')}`,
    ...over,
  };
}

function makeDeps(seed: ContactItem[]) {
  const calls: Array<{ type: ContactType } & ListContactsOpts> = [];
  const warn = vi.fn();
  const deps = {
    contacts: {
      async listByType(type: ContactType, opts: ListContactsOpts = {}) {
        calls.push({ type, ...opts });
        return listByTypeFromContacts(seed, type, opts);
      },
    },
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
  };
  return { deps, calls, warn };
}

const WIDE = { pageSize: 100, maxPages: 10, maxRows: 200 };

describe('collectUnknownTriageQueue', () => {
  it('one Query when the partition fits a page - and it narrows on NOTHING (no status, no excludeOrigin, no deleted:true)', async () => {
    const { deps, calls, warn } = makeDeps([
      unk(1),
      unk(2, { status: 'active' }), // class f: the DEFAULT for a created unknown
      unk(3, { origin: 'group_detection' }), // class a: a stub who may have texted
      { contactId: 'c-ten', type: 'tenant', phone: '+15550009000' },
    ]);
    const result = await collectUnknownTriageQueue(deps, WIDE);
    // RANGE-KEY ORDER, not seed order: the partition sorts on `status`
    // ascending, and 'active' < 'needs_review' - so c-unk-002 (the class-f
    // active row) comes back FIRST. See the starvation test below.
    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-unk-002', 'c-unk-001', 'c-unk-003']);
    expect(result).toMatchObject({ pagesWalked: 1, truncated: false });
    expect(calls).toHaveLength(1);
    // THE MAP DRIVES THE READ: the queried partitions are exactly
    // UNKNOWN_QUEUE_TYPES, which is derived from UNKNOWN_TAB_TYPE_DECISIONS -
    // flipping a type to 'queried' in the map changes this pin, which is what
    // makes the exhaustiveness guard load-bearing rather than decorative.
    expect(calls.map((c) => c.type)).toEqual([...UNKNOWN_QUEUE_TYPES]);
    // THE PROBES. The fake honors these options, so re-adding either narrow
    // (spec section 3, classes a and f) empties the row set above AND flips
    // these pins.
    expect(calls[0]!.status).toBeUndefined();
    expect(calls[0]!.excludeOrigin).toBeUndefined();
    expect(calls[0]!.deleted).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills PAST pages of soft-deleted residue: the loop breaks on rows KEPT, never rows read', async () => {
    // The deleted filter is a FilterExpression, applied after Limit - so pages
    // 1 and 2 come back EMPTY with a lastEvaluatedKey. Breaking on rows read
    // (or on an empty page) returns [] here, which is the today.ts:855-899
    // failure this loop exists to prevent: a short block that reads as
    // "nothing needs triage".
    const { deps } = makeDeps([
      unk(1, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(2, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(3, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(4, { deleted_at: '2026-08-01T00:00:00.000Z' }),
      unk(5),
      unk(6),
    ]);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 2, maxPages: 5, maxRows: 10 });
    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-unk-005', 'c-unk-006']);
    expect(result.truncated).toBe(false);
    // FOUR pages, not three: page 3 returns the last two live rows AT the
    // Limit, so the service hands back a key and page 4 is the empty read that
    // proves the stream ended (the LEK rule, unreadIndexFake.ts:104-116). An
    // items-remaining fake would report 3 here and calibrate the suite one
    // round trip short of production.
    expect(result.pagesWalked).toBe(4);
  });

  it('the page budget bounds a partition made entirely of residue - truncated + the WARN', async () => {
    const seed = Array.from({ length: 10 }, (_, i) => unk(i + 1, { deleted_at: '2026-08-01T00:00:00.000Z' }));
    seed.push(unk(99)); // one live contact, unreachable behind the wall
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 2, maxPages: 3, maxRows: 10 });
    expect(result.contacts).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.pagesWalked).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ pages: 3, kept: 0 });
  });

  it('hard-caps the RESULT, not just the read: the loop breaks on >=, so the last page can overshoot', async () => {
    const seed = Array.from({ length: 7 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 3, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4); // not 6 - the slice is the cap
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a partition that drains BELOW the page size is not truncated (no false WARN)', async () => {
    const seed = Array.from({ length: 4 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 5, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4);
    expect(result.truncated).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('an EXACT page-multiple partition that fills the cap is CONSERVATIVELY truncated - the LEK in hand makes "nothing behind it" unknowable', async () => {
    // Page 1 returns all 4 rows AT the Limit, so the service hands back a key;
    // the cap is also full, so the collector stops without paying the extra
    // Query that would prove emptiness. It reports a floor that happens to be
    // exact - the accepted trade (UnknownQueueResult.truncated doc). A fake
    // returning no LEK here would pin the OPPOSITE of production behaviour.
    const seed = Array.from({ length: 4 }, (_, i) => unk(i + 1));
    const { deps, warn } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 4, maxPages: 10, maxRows: 4 });
    expect(result.contacts).toHaveLength(4);
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('THE CAP STARVES needs_review: the partition is status-ordered, so a cut keeps the ALREADY-REVIEWED rows and discards the front door', async () => {
    // The defect adversarial review HIGH-1 named, pinned as a FACT so the next
    // reader meets it instead of rediscovering it.
    //
    // byTypeStatus is (hash: type, range: status) and contactsRepo.listByType
    // sets NO ScanIndexForward (contactsRepo.ts:1009-1020), so the Query is
    // ASCENDING on status. Within type='unknown' the only legal statuses are
    // 'needs_review' and 'active' (NON_TENANT_STATUSES), and
    // 'active' < 'needs_review' - so every active row precedes every
    // needs_review one. The cap therefore does NOT cut a recency-arbitrary
    // slice: it cuts STATUS-FIRST, keeping rows somebody already looked at and
    // discarding the ones nobody has.
    //
    // NOT A REGRESSION TEST - it pins CURRENT behaviour. The mitigation (a
    // ScanIndexForward: false option on the repo read) is deliberately NOT
    // taken on this branch: listByType is a SHARED read that today.ts's triage
    // block also uses, so flipping its direction is the human's call. Reopen
    // point: docs/issues/inbox-filter-tabs-full-walk.md.
    const seed = [
      unk(1), // needs_review - the untriaged front door
      unk(2), // needs_review
      unk(3, { status: 'active' }), // reviewed but never re-typed (MED-3)
      unk(4, { status: 'active' }),
    ];
    const { deps } = makeDeps(seed);
    const result = await collectUnknownTriageQueue(deps, { pageSize: 10, maxPages: 10, maxRows: 2 });
    // The cap is 2 and the partition holds 2 of each status. Both survivors are
    // `active`; NEITHER needs_review row is reachable, however recent its
    // inbound. A cut that were truly "arbitrary with respect to recency" could
    // not produce this every single time - and it does, because intra-partition
    // order is stable.
    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-unk-003', 'c-unk-004']);
    expect(result.contacts.map((c) => c.status)).toEqual(['active', 'active']);
    expect(result.contacts.some((c) => c.status === 'needs_review')).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it('production constants are named and sane', () => {
    expect(UNKNOWN_QUEUE_PAGE_SIZE).toBe(100);
    expect(UNKNOWN_QUEUE_MAX_PAGES).toBe(10);
    expect(UNKNOWN_QUEUE_MAX_ROWS).toBe(200);
  });

  it('class g: every ContactType has a recorded tab decision, only unknown is queried, and the derived type list agrees', () => {
    // The compile-time `satisfies Record<ContactType, ...>` on the map is the
    // decision guard: adding a ContactType member without deciding its tab
    // fate is a typecheck failure. UNKNOWN_QUEUE_TYPES is the ENFORCEMENT: it
    // is derived from the map and is what the collector queries (pinned by the
    // calls assertion in the first test) and what the resurfacing sweep
    // admits, so the decision and the behaviour cannot drift apart.
    const queried = (Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, string][])
      .filter(([, decision]) => decision === 'queried')
      .map(([type]) => type);
    expect(queried).toEqual(['unknown']);
    expect([...UNKNOWN_QUEUE_TYPES]).toEqual(queried);
  });
});
