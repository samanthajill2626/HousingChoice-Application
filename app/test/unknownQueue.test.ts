// app/test/unknownQueue.test.ts
// The triage-block reader: block ORDER, the fill loop past soft-deleted
// residue, block roll-over, the per-request scan budget, and the two
// protections the design REMOVES (a single-status narrow, excludeOrigin) as
// mutation probes that can actually go red - the fake honors both options.
import { describe, expect, it } from 'vitest';
import {
  readUnknownQueue,
  UNKNOWN_QUEUE_BLOCKS,
  UNKNOWN_QUEUE_PAGE_SIZE,
  UNKNOWN_QUEUE_SCAN_BUDGET,
  UNKNOWN_QUEUE_STATUS_ORDER,
  UNKNOWN_QUEUE_TYPES,
  UNKNOWN_TAB_TYPE_DECISIONS,
} from '../src/lib/unknownQueue.js';
import { statusAllowlistFor } from '../src/lib/statusModel.js';
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
  const deps = {
    contacts: {
      async listByType(type: ContactType, opts: ListContactsOpts = {}) {
        calls.push({ type, ...opts });
        return listByTypeFromContacts(seed, type, opts);
      },
    },
  };
  return { deps, calls };
}

const WIDE = { want: 100, budget: 1000, pageSize: 100 };

describe('readUnknownQueue', () => {
  it('reads the blocks in QUEUE ORDER - needs_review first, active second - and narrows on nothing else', async () => {
    const { deps, calls } = makeDeps([
      unk(1),
      unk(2, { status: 'active' }), // class f: still on the tab, just read later
      unk(3, { origin: 'group_detection' }), // class a: a stub who may have texted
      { contactId: 'c-ten', type: 'tenant', phone: '+15550009000', status: 'active' },
    ]);
    const read = await readUnknownQueue(deps, WIDE);
    // UNTRIAGED FIRST. Under the pre-rework un-narrowed Query this order was
    // the exact REVERSE ('active' < 'needs_review' ascending), which is what
    // made the old cap starve the queue.
    expect(read.rows.map((r) => r.contact.contactId)).toEqual([
      'c-unk-001',
      'c-unk-003',
      'c-unk-002',
    ]);
    expect(read.next).toBeUndefined(); // every block drained
    // One Query per block. THE MAP DRIVES THE READ: the queried partitions are
    // exactly UNKNOWN_QUEUE_BLOCKS, so flipping a type to 'queried' or adding a
    // status changes this pin - which is what makes the exhaustiveness guards
    // load-bearing rather than decorative.
    expect(calls.map((c) => `${c.type}/${String(c.status)}`)).toEqual(
      UNKNOWN_QUEUE_BLOCKS.map((b) => `${b.type}/${b.status}`),
    );
    // THE PROBES. The fake honors these options, so re-adding either narrow
    // (spec section 3, classes a and f) drops rows AND flips these pins.
    expect(calls.every((c) => c.excludeOrigin === undefined)).toBe(true);
    expect(calls.every((c) => c.deleted === undefined)).toBe(true);
  });

  it('the UNTRIAGED block is exhausted BEFORE the reviewed block is read - which is what makes starvation impossible', async () => {
    // REPLACES the deleted "THE CAP STARVES needs_review" pin. That test
    // asserted the old defect as a fact: the un-narrowed Query ascended
    // `status`, 'active' < 'needs_review', and the result cap therefore kept
    // already-reviewed rows and discarded untriaged ones. There is no cap now,
    // and no shared ordering to be at the mercy of - the untriaged block is a
    // Query of its own and it is issued FIRST. This pins the ordering
    // structurally: with a `want` that only ONE block can satisfy, the reviewed
    // block is never even queried.
    const seed = [
      unk(1),
      unk(2),
      unk(3, { status: 'active' }),
      unk(4, { status: 'active' }),
    ];
    const { deps, calls } = makeDeps(seed);
    const read = await readUnknownQueue(deps, { want: 2, budget: 1000, pageSize: 10 });
    expect(read.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-001', 'c-unk-002']);
    expect(read.rows.every((r) => r.contact.status === 'needs_review')).toBe(true);
    // ONE Query, against the untriaged block alone.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('needs_review');
    // And the reviewed rows are not lost - the resume point is still inside
    // block 0, so the walk continues into them.
    expect(read.next).toBeDefined();
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
    const read = await readUnknownQueue(deps, { want: 10, budget: 1000, pageSize: 2 });
    expect(read.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-005', 'c-unk-006']);
    expect(read.next).toBeUndefined();
    // FOUR Queries on the needs_review block, not three: page 3 returns the
    // last two live rows AT the Limit, so the service hands back a key and page
    // 4 is the empty read that proves the block ended (the LEK rule,
    // unreadIndexFake.ts:104-116). Plus ONE on the empty `active` block.
    expect(read.queries).toBe(5);
  });

  it('ROLLS OVER between blocks: an exhausted block advances the position, and only the LAST block ending stops paging', async () => {
    const { deps } = makeDeps([unk(1), unk(2), unk(3, { status: 'active' })]);
    // pageSize 1 + want 1 stops INSIDE block 0 with the block un-exhausted.
    const first = await readUnknownQueue(deps, { want: 1, budget: 1000, pageSize: 1 });
    expect(first.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-001']);
    expect(first.next).toMatchObject({ block: 0 });
    expect(first.next?.key).toBeDefined();
    // Resuming from the row's own `after` walks block 0 to its end, rolls into
    // block 1, and returns the reviewed row.
    const second = await readUnknownQueue(deps, {
      start: first.rows[0]!.after,
      want: 10,
      budget: 1000,
      pageSize: 1,
    });
    expect(second.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-002', 'c-unk-003']);
    // The LAST block ended, so paging is over.
    expect(second.next).toBeUndefined();
  });

  it('an exhausted block that fills `want` exactly hands back the NEXT block, not undefined', async () => {
    // The boundary case that decides whether the reviewed block is reachable at
    // all: block 0 drains at the same moment `want` is met. Reporting
    // exhaustion here would strand every `active` row behind a null cursor.
    const { deps } = makeDeps([unk(1), unk(2, { status: 'active' })]);
    const read = await readUnknownQueue(deps, { want: 1, budget: 1000, pageSize: 1 });
    expect(read.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-001']);
    expect(read.next).toBeDefined();
    const resumed = await readUnknownQueue(deps, {
      start: read.next!,
      want: 10,
      budget: 1000,
      pageSize: 10,
    });
    expect(resumed.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-002']);
  });

  it('the SCAN BUDGET stops a wall of residue and hands back the position - rows behind it stay reachable', async () => {
    const seed = Array.from({ length: 10 }, (_, i) =>
      unk(i + 1, { deleted_at: '2026-08-01T00:00:00.000Z' }),
    );
    seed.push(unk(99)); // one live contact, behind the wall
    const { deps } = makeDeps(seed);
    const read = await readUnknownQueue(deps, { want: 10, budget: 4, pageSize: 2 });
    // Nothing kept, budget spent - and, crucially, a position to continue from.
    expect(read.rows).toEqual([]);
    expect(read.budgetSpent).toBe(true);
    expect(read.next).toBeDefined();
    expect(read.scanned).toBeGreaterThanOrEqual(4);
    // Continuing from it with a real budget reaches the row the wall hid. This
    // is the whole difference from the deleted page-budget behaviour, which
    // reported `truncated` and stranded the row.
    const rest = await readUnknownQueue(deps, {
      start: read.next!,
      want: 10,
      budget: 1000,
      pageSize: 2,
    });
    expect(rest.rows.map((r) => r.contact.contactId)).toEqual(['c-unk-099']);
  });

  it('charges the budget in index rows EXAMINED, not rows returned - a filtered page still costs its Limit', async () => {
    // DynamoDB applies Limit before the FilterExpression and returns a
    // LastEvaluatedKey exactly when the Limit was reached, so a page that came
    // back EMPTY still examined `pageSize` rows. Charging rows RETURNED would
    // make a residue-only partition free and the budget unable to stop it.
    const seed = Array.from({ length: 4 }, (_, i) =>
      unk(i + 1, { deleted_at: '2026-08-01T00:00:00.000Z' }),
    );
    const { deps } = makeDeps(seed);
    const read = await readUnknownQueue(deps, { want: 10, budget: 1000, pageSize: 2 });
    expect(read.rows).toEqual([]);
    // Two full pages (2 + 2) plus the empty proving read on needs_review, plus
    // the empty `active` block: 4 examined rows charged, none returned.
    expect(read.scanned).toBe(4);
  });

  it('every returned row carries a resume point that is EXACT: replaying it yields the next row, never a repeat', async () => {
    const seed = Array.from({ length: 5 }, (_, i) => unk(i + 1));
    const { deps } = makeDeps(seed);
    const read = await readUnknownQueue(deps, { want: 5, budget: 1000, pageSize: 10 });
    expect(read.rows).toHaveLength(5);
    // Resume after row 2 -> rows 3, 4, 5 and nothing else.
    const after = await readUnknownQueue(deps, {
      start: read.rows[1]!.after,
      want: 10,
      budget: 1000,
      pageSize: 10,
    });
    expect(after.rows.map((r) => r.contact.contactId)).toEqual([
      'c-unk-003',
      'c-unk-004',
      'c-unk-005',
    ]);
  });

  it('refuses a degenerate `want` or `budget` LOUDLY, because both spin forever instead of failing', async () => {
    // A4, both measured. `want < 1` is a TIGHT INFINITE SPIN WITH ZERO QUERIES:
    // the loop breaks immediately, hands back the UNCHANGED start position with
    // budgetSpent false, and inbox.ts's fill-or-exhaust loop re-enters with the
    // same position forever - a pure microtask spin no downstream runaway guard
    // can trip. `budget < 1` marks budgetSpent before any Query, so every
    // request answers with an empty page and the SAME cursor the client sent: a
    // Load more that never advances and never ends.
    //
    // Neither is reachable over the wire (`parseLimit` clamps to 1..100), but
    // `aggregateInbox` is exported and app/scripts/profile-inbox.ts passes a
    // case-supplied limit, and the budget is a `deps` seam.
    //
    // THROWING, not clamping or returning an empty page: an empty page here is
    // indistinguishable from "the triage queue is empty", which is the one
    // confusion this reader's LOUD-BY-CONTRACT posture exists to prevent.
    const { deps, calls } = makeDeps([unk(1)]);
    await expect(readUnknownQueue(deps, { want: 0, budget: 1000, pageSize: 10 })).rejects.toThrow(
      /want must be a positive integer/,
    );
    await expect(readUnknownQueue(deps, { want: -1, budget: 1000, pageSize: 10 })).rejects.toThrow(
      /want must be a positive integer/,
    );
    await expect(readUnknownQueue(deps, { want: 10, budget: 0, pageSize: 10 })).rejects.toThrow(
      /budget must be a positive integer/,
    );
    // It refuses BEFORE issuing a Query, so a bad caller costs nothing.
    expect(calls).toHaveLength(0);
  });

  it('production constants are named and sane', () => {
    expect(UNKNOWN_QUEUE_PAGE_SIZE).toBe(100);
    expect(UNKNOWN_QUEUE_SCAN_BUDGET).toBe(1000);
  });

  it('class g: every ContactType has a recorded tab decision, only unknown is queried, and the derived block list agrees', () => {
    // The compile-time `satisfies Record<ContactType, ...>` on the map is the
    // decision guard: adding a ContactType member without deciding its tab
    // fate is a typecheck failure. UNKNOWN_QUEUE_BLOCKS is the ENFORCEMENT: it
    // is derived from the map and is what the reader queries (pinned by the
    // calls assertion in the first test), so the decision and the behaviour
    // cannot drift apart.
    const queried = (Object.entries(UNKNOWN_TAB_TYPE_DECISIONS) as [ContactType, string][])
      .filter(([, decision]) => decision === 'queried')
      .map(([type]) => type);
    expect(queried).toEqual(['unknown']);
    expect([...UNKNOWN_QUEUE_TYPES]).toEqual(queried);
    expect([...new Set(UNKNOWN_QUEUE_BLOCKS.map((b) => b.type))]).toEqual(queried);
  });

  it('the block statuses ARE statusAllowlistFor("unknown") - the two cannot drift', () => {
    // The type alias on UNKNOWN_QUEUE_STATUS_ORDER pins it to
    // NON_TENANT_STATUSES at COMPILE time, which is the same array
    // statusAllowlistFor returns for `unknown`. This is the RUNTIME half: a
    // change made inside statusAllowlistFor (a special case for `unknown`, say)
    // would not move the alias, and a status legal for a contact but absent
    // from the blocks is a contact that silently never appears on the tab.
    const blockStatuses = [...new Set(UNKNOWN_QUEUE_BLOCKS.map((b) => String(b.status)))].sort();
    expect(blockStatuses).toEqual([...statusAllowlistFor('unknown')].sort());
    // And the ORDER decision covers exactly those, untriaged first.
    expect(Object.keys(UNKNOWN_QUEUE_STATUS_ORDER).sort()).toEqual(blockStatuses);
    expect(UNKNOWN_QUEUE_BLOCKS.map((b) => b.status)).toEqual(['needs_review', 'active']);
  });
});
