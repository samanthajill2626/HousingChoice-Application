import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllPages } from './paging.js';

/** A fake paged endpoint: hands back `pages` in order, recording each cursor it
 *  was called with so the tests can assert the cursor is threaded through. */
function fakeEndpoint(pages: { items: number[]; nextCursor: string | null }[]) {
  const cursors: (string | undefined)[] = [];
  let call = 0;
  return {
    cursors,
    fetch: (cursor?: string) => {
      cursors.push(cursor);
      const page = pages[Math.min(call, pages.length - 1)];
      call += 1;
      return Promise.resolve(page!);
    },
  };
}

const select = (p: { items: number[]; nextCursor: string | null }) => p;

afterEach(() => vi.restoreAllMocks());

describe('fetchAllPages', () => {
  it('returns a single page without asking for a cursor', async () => {
    const ep = fakeEndpoint([{ items: [1, 2], nextCursor: null }]);
    const res = await fetchAllPages(ep.fetch, select, { label: 'test' });
    expect(res.items).toEqual([1, 2]);
    expect(res.truncated).toBe(false);
    expect(ep.cursors).toEqual([undefined]);
  });

  it('walks every page, threading each nextCursor into the next request', async () => {
    const ep = fakeEndpoint([
      { items: [1], nextCursor: 'c1' },
      { items: [2], nextCursor: 'c2' },
      { items: [3], nextCursor: null },
    ]);
    const res = await fetchAllPages(ep.fetch, select, { label: 'test' });
    expect(res.items).toEqual([1, 2, 3]);
    expect(res.truncated).toBe(false);
    expect(ep.cursors).toEqual([undefined, 'c1', 'c2']);
  });

  it('treats an empty page carrying a cursor as more-to-come, not the end', async () => {
    // DynamoDB applies Limit BEFORE a FilterExpression, so a page can come back
    // empty while more rows remain. Stopping on an empty page would truncate.
    const ep = fakeEndpoint([
      { items: [], nextCursor: 'c1' },
      { items: [7], nextCursor: null },
    ]);
    const res = await fetchAllPages(ep.fetch, select, { label: 'test' });
    expect(res.items).toEqual([7]);
    expect(res.truncated).toBe(false);
  });

  it('stops at the page cap and reports truncated rather than looping forever', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A cursor that never nulls out.
    const ep = fakeEndpoint([{ items: [1], nextCursor: 'forever' }]);
    const res = await fetchAllPages(ep.fetch, select, { label: 'test', maxPages: 3 });
    expect(res.items).toEqual([1, 1, 1]);
    expect(res.truncated).toBe(true);
    expect(ep.cursors).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('logs counts only on a cap hit - never a record id or any PII', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ep = fakeEndpoint([{ items: [4242], nextCursor: 'forever' }]);
    await fetchAllPages(ep.fetch, select, { label: 'tenants', maxPages: 2 });
    const message = String(warn.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('tenants');
    expect(message).toContain('2');
    expect(message).not.toContain('4242');
  });

  it('does not warn when the walk completes inside the cap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ep = fakeEndpoint([{ items: [1], nextCursor: null }]);
    const res = await fetchAllPages(ep.fetch, select, { label: 'test', maxPages: 2 });
    expect(res.truncated).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('propagates a rejection (an AbortError must reach the caller unchanged)', async () => {
    const abort = new DOMException('aborted', 'AbortError');
    await expect(
      fetchAllPages(() => Promise.reject(abort), select, { label: 'test' }),
    ).rejects.toBe(abort);
  });
});
