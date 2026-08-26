// app/test/contactsPartitionFake.test.ts
// Pins the DynamoDB execution-order semantics of the shared listByType fake.
// If these drift, every mutation probe built on the fake goes vacuous - which
// is why the fake has its own suite.
//
// The lastEvaluatedKey assertions use toMatchObject on `contactId` alone: the
// fake mints the real GSI key shape ({ type, status, contactId }), and what
// these pins are FOR is the resume POSITION, not the envelope around it.
import { describe, expect, it } from 'vitest';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';

function c(over: Partial<ContactItem> & { contactId: string }): ContactItem {
  return { type: 'unknown', status: 'needs_review', ...over };
}

describe('listByTypeFromContacts', () => {
  it('applies Limit BEFORE the deleted filter: a page of deleted rows is empty WITH a lastEvaluatedKey', () => {
    const seed = [
      c({ contactId: 'd1', deleted_at: '2026-08-01T00:00:00.000Z' }),
      c({ contactId: 'd2', deleted_at: '2026-08-01T00:00:00.000Z' }),
      c({ contactId: 'live' }),
    ];
    const page1 = listByTypeFromContacts(seed, 'unknown', { limit: 2 });
    expect(page1.items).toEqual([]);
    expect(page1.lastEvaluatedKey).toMatchObject({ contactId: 'd2' });
    const page2 = listByTypeFromContacts(seed, 'unknown', {
      limit: 2,
      exclusiveStartKey: page1.lastEvaluatedKey!,
    });
    expect(page2.items.map((x) => x.contactId)).toEqual(['live']);
    expect(page2.lastEvaluatedKey).toBeUndefined();
  });

  it('status narrows the PARTITION (key condition), before paging', () => {
    const seed = [
      c({ contactId: 'nr' }),
      c({ contactId: 'act', status: 'active' }),
    ];
    const page = listByTypeFromContacts(seed, 'unknown', { status: 'needs_review', limit: 10 });
    expect(page.items.map((x) => x.contactId)).toEqual(['nr']);
  });

  it('excludeOrigin filters the PAGE (spends slots), like the real FilterExpression', () => {
    // The ids encode the SORT position, not the seed position (rule 6): every
    // row here shares a status, so the tie-break is `contactId` ascending and
    // the two excluded stubs must sort AHEAD of the surviving row for the
    // page-slot claim to be the thing under test. Naming the third row 'real'
    // put it first and quietly turned this into a different assertion.
    const seed = [
      c({ contactId: 's1', origin: 'group_detection' }),
      c({ contactId: 's2', origin: 'group_detection' }),
      c({ contactId: 's3-real' }),
    ];
    const page1 = listByTypeFromContacts(seed, 'unknown', {
      limit: 2,
      excludeOrigin: 'group_detection',
    });
    expect(page1.items).toEqual([]);
    expect(page1.lastEvaluatedKey).toMatchObject({ contactId: 's2' });
  });

  it('deleted: true returns ONLY soft-deleted rows; the default returns only live ones', () => {
    const seed = [c({ contactId: 'live' }), c({ contactId: 'gone', deleted_at: '2026-08-01T00:00:00.000Z' })];
    expect(listByTypeFromContacts(seed, 'unknown', { deleted: true }).items.map((x) => x.contactId)).toEqual(['gone']);
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['live']);
  });

  it('pointer items and other types are invisible to the partition', () => {
    const seed = [
      c({ contactId: 'ptr', phone_ref: true }),
      c({ contactId: 'ten', type: 'tenant' }),
      c({ contactId: 'unk' }),
    ];
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['unk']);
  });

  it('LEK means "Limit reached", not "rows remain": an exact-multiple partition costs one extra empty page', () => {
    // The service's rule (unreadIndexFake.ts:104-117): a page that reached the
    // Limit hands back a key even when it was also the end - the caller pays
    // one more Query to learn the stream ended. An items-remaining fake makes
    // every call-count pin one Query short of production.
    const seed = [c({ contactId: 'a' }), c({ contactId: 'b' })];
    const page1 = listByTypeFromContacts(seed, 'unknown', { limit: 2 });
    expect(page1.items.map((x) => x.contactId)).toEqual(['a', 'b']);
    expect(page1.lastEvaluatedKey).toMatchObject({ contactId: 'b' });
    const page2 = listByTypeFromContacts(seed, 'unknown', {
      limit: 2,
      exclusiveStartKey: page1.lastEvaluatedKey!,
    });
    expect(page2.items).toEqual([]);
    expect(page2.lastEvaluatedKey).toBeUndefined();
  });

  it('rule 6 - status ascending is REAL service behaviour; the contactId tie-break is this FAKE\'S OWN convention', () => {
    // THE STATUS HALF IS PRODUCTION. The Query sets no ScanIndexForward
    // (contactsRepo.ts:1009-1020), so it is ascending on `status`. Within
    // type='unknown' the legal statuses are 'needs_review' and 'active', and
    // 'active' < 'needs_review' - so every active row precedes every
    // needs_review one. The seed below is in the OPPOSITE order on purpose: a
    // fake returning seed order passes nothing here.
    //
    // THE contactId HALF IS NOT. Positions 2 and 4 below assert a tie-break the
    // real service does not produce: four same-status items c1..c4 through a
    // real byTypeStatus-shaped GSI on DynamoDB Local came back `c2, c4, c1, c3`
    // (measured 2026-08-26, rework review A5). This test pins the fake's
    // DETERMINISM - chosen so page-composition pins are stable and readable -
    // and says so, rather than asserting a fiction as service behaviour. The
    // real order is stable too, which is the property production may rely on;
    // its SHAPE is not.
    const seed = [
      c({ contactId: 'z-review', status: 'needs_review' }),
      c({ contactId: 'a-review', status: 'needs_review' }),
      c({ contactId: 'z-active', status: 'active' }),
      c({ contactId: 'a-active', status: 'active' }),
    ];
    expect(listByTypeFromContacts(seed, 'unknown', { limit: 10 }).items.map((x) => x.contactId)).toEqual([
      'a-active',
      'z-active',
      'a-review',
      'z-review',
    ]);
    // And the sort is what the PAGE cuts: a Limit smaller than the partition
    // keeps the active block and leaves needs_review behind - the starvation
    // HIGH-1 named, which is why an UN-NARROWED bounded read was the defect.
    // The reader no longer takes one (it Queries per status block), so this is
    // the property of the INDEX, not a live failure.
    expect(listByTypeFromContacts(seed, 'unknown', { limit: 2 }).items.map((x) => x.contactId)).toEqual([
      'a-active',
      'z-active',
    ]);
  });

  it('a POSITIONLESS exclusiveStartKey THROWS - it must never silently restart the partition', () => {
    // B5. The `contactId`-only fallback that used to live here was
    // `findIndex(identity) + 1`, which is 0 on a miss - page one again, i.e.
    // the duplicate-rows-on-page-2 bug modelled as correct behaviour. It was
    // unreachable by any consumer (they all pass a key this fake minted), and a
    // silent `start = 0` would be the same bug by another route.
    const seed = [c({ contactId: 'a' }), c({ contactId: 'b' })];
    expect(() =>
      listByTypeFromContacts(seed, 'unknown', { exclusiveStartKey: { contactId: 'a' } }),
    ).toThrow(/status and contactId/);
  });

  it('the GSI is sparse: a status-less contact is not indexed at all', () => {
    const statusless: ContactItem = { contactId: 'no-status', type: 'unknown' };
    const seed = [statusless, c({ contactId: 'indexed' })];
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['indexed']);
  });
});
