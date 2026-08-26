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
    const seed = [
      c({ contactId: 's1', origin: 'group_detection' }),
      c({ contactId: 's2', origin: 'group_detection' }),
      c({ contactId: 'real' }),
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

  it('the GSI is sparse: a status-less contact is not indexed at all', () => {
    const statusless: ContactItem = { contactId: 'no-status', type: 'unknown' };
    const seed = [statusless, c({ contactId: 'indexed' })];
    expect(listByTypeFromContacts(seed, 'unknown', {}).items.map((x) => x.contactId)).toEqual(['indexed']);
  });
});
