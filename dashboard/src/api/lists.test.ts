// Whole-list read wrappers (getAllContacts / getAllUnits / getAllPlacements /
// getAllConversations). These own the guarantee the app got wrong for months:
// a caller asking for "the tenants" gets EVERY tenant, not the server's first
// page. paging.test.ts proves the walk; this proves each wrapper is wired to it
// with the right query, page size, and page->items mapping.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js');
  return { ...actual, request: (...a: unknown[]) => request(...a) };
});

import { getAllContacts, getAllUnits, getAllPlacements, getAllConversations } from './endpoints.js';

/** The query object `request` was called with on call N. */
function queryOf(call: number): Record<string, unknown> {
  return (request.mock.calls[call]?.[1] as { query?: Record<string, unknown> })?.query ?? {};
}

beforeEach(() => request.mockReset());

describe('whole-list read wrappers', () => {
  it('getAllContacts walks every page and concatenates the contacts', async () => {
    request
      .mockResolvedValueOnce({ contacts: [{ contactId: 'c1' }], nextCursor: 'n1' })
      .mockResolvedValueOnce({ contacts: [{ contactId: 'c2' }], nextCursor: null });

    const res = await getAllContacts({ type: 'tenant' });

    expect(res.items.map((c) => c.contactId)).toEqual(['c1', 'c2']);
    expect(res.truncated).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
    // The cursor from page one must be threaded into page two.
    expect(queryOf(0)['cursor']).toBeUndefined();
    expect(queryOf(1)['cursor']).toBe('n1');
  });

  it('getAllContacts asks for the server-max page size, halving the round trips', async () => {
    request.mockResolvedValue({ contacts: [], nextCursor: null });
    await getAllContacts({ type: 'tenant' });
    // 100 is MAX_PAGE_LIMIT; the server 400s anything above it rather than clamping.
    expect(queryOf(0)['limit']).toBe('100');
    expect(queryOf(0)['type']).toBe('tenant');
  });

  it('getAllContacts asks for soft-deleted records only when told to', async () => {
    request.mockResolvedValue({ contacts: [], nextCursor: null });
    await getAllContacts({ type: 'tenant' });
    expect(queryOf(0)['deleted']).toBeUndefined();

    request.mockReset();
    request.mockResolvedValue({ contacts: [], nextCursor: null });
    await getAllContacts({ type: 'tenant', deleted: true });
    expect(queryOf(0)['deleted']).toBe('true');
  });

  it('getAllUnits walks every page and maps `units` onto items', async () => {
    request
      .mockResolvedValueOnce({ units: [{ unitId: 'u1' }], nextCursor: 'n1' })
      .mockResolvedValueOnce({ units: [{ unitId: 'u2' }], nextCursor: null });

    const res = await getAllUnits();

    expect(res.items.map((u) => u.unitId)).toEqual(['u1', 'u2']);
    expect(queryOf(0)['limit']).toBe('100');
    expect(queryOf(1)['cursor']).toBe('n1');
  });

  it('getAllPlacements walks every page and maps `placements` onto items', async () => {
    request
      .mockResolvedValueOnce({ placements: [{ placementId: 'p1' }], nextCursor: 'n1' })
      .mockResolvedValueOnce({ placements: [{ placementId: 'p2' }], nextCursor: null });

    const res = await getAllPlacements();

    expect(res.items.map((p) => p.placementId)).toEqual(['p1', 'p2']);
    expect(queryOf(1)['cursor']).toBe('n1');
  });

  it('getAllConversations walks every page and maps `conversations` onto items', async () => {
    // /api/conversations could not page AT ALL before this change - the client
    // function took no cursor, so every caller silently saw the newest 50 open
    // threads and treated that as the whole inbox.
    request
      .mockResolvedValueOnce({ conversations: [{ conversationId: 'v1' }], nextCursor: 'n1' })
      .mockResolvedValueOnce({ conversations: [{ conversationId: 'v2' }], nextCursor: null });

    const res = await getAllConversations();

    expect(res.items.map((c) => c.conversationId)).toEqual(['v1', 'v2']);
    expect(queryOf(0)['limit']).toBe('100');
    expect(queryOf(1)['cursor']).toBe('n1');
  });

  it('keeps walking past an EMPTY page that still carries a cursor', async () => {
    // DynamoDB applies Limit before the soft-delete FilterExpression, so a page
    // of entirely-filtered rows comes back empty with more still to come.
    request
      .mockResolvedValueOnce({ contacts: [], nextCursor: 'n1' })
      .mockResolvedValueOnce({ contacts: [{ contactId: 'c9' }], nextCursor: null });

    const res = await getAllContacts({ type: 'tenant' });

    expect(res.items.map((c) => c.contactId)).toEqual(['c9']);
  });
});
