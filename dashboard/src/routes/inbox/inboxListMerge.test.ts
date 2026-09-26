import { describe, expect, it } from 'vitest';
import type { InboxPage, InboxRow } from '../../api/index.js';
import {
  appendPage,
  baseOf,
  dedupeConversations,
  emptyListState,
  mergeHeadRead,
  patchUnread,
  rowKey,
  type ListState,
} from './inboxListMerge.js';

function contact(id: string, at = '2026-06-17T10:00:00.000Z', over: Partial<InboxRow> = {}): InboxRow {
  return {
    kind: 'contact',
    contactId: id,
    name: id,
    unreadCount: 0,
    preview: '',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: at,
    needsTriage: false,
    ...over,
  };
}
function relay(conversationId: string, at = '2026-06-01T10:00:00.000Z'): InboxRow {
  return {
    kind: 'relay_group',
    conversationId,
    name: `With ${conversationId}`,
    unreadCount: 0,
    preview: '',
    lastActivityAt: at,
    needsTriage: false,
    status: 'open',
  };
}
function groupText(conversationId: string, at = '2026-06-01T09:00:00.000Z'): InboxRow {
  return {
    kind: 'group_text',
    conversationId,
    name: `Group ${conversationId}`,
    unreadCount: 0,
    preview: '',
    lastActivityAt: at,
    needsTriage: false,
  };
}
function page(rows: InboxRow[], nextCursor: string | null, extra: Partial<InboxPage> = {}): InboxPage {
  return { rows, nextCursor, ...extra };
}
function state(over: Partial<ListState> = {}): ListState {
  return { ...emptyListState(), ...over };
}
const ids = (rows: InboxRow[]): string[] => rows.map(rowKey);

describe('rowKey', () => {
  it('prefixes by kind and never collides across kinds', () => {
    expect(rowKey(contact('c1'))).toBe('c:c1');
    expect(rowKey(relay('x'))).toBe('g:x');
    expect(rowKey(groupText('x'))).toBe('gt:x');
    expect(rowKey({ ...contact('u'), kind: 'unknown', contactId: undefined, phone: '+15550001111' })).toBe('u:+15550001111');
  });
});

describe('mergeHeadRead - branch C (complete head)', () => {
  it('replaces head, tail and cursor and re-arms from the page', () => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD', autoLoadArmed: false, pageEpoch: 3 });
    const next = mergeHeadRead(s, page([contact('n1'), contact('n2')], 'NEW'), 'all', 2);
    expect(ids(next.head)).toEqual(['c:n1', 'c:n2']);
    expect(next.tail).toEqual([]);
    expect(next.cursor).toBe('NEW');
    expect(next.autoLoadArmed).toBe(true);
    expect(next.pageEpoch).toBe(4);
  });

  it('a complete head that ended the feed (null cursor) is complete even when short', () => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD' });
    const next = mergeHeadRead(s, page([contact('n1')], null), 'all', 100);
    expect(ids(baseOf(next))).toEqual(['c:n1']);
    expect(next.cursor).toBeNull();
  });

  it('on the All tab, additive rows do not count toward the limit', () => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD' });
    // limit 2, two contacts + one relay row = complete
    const next = mergeHeadRead(s, page([contact('n1'), relay('r1'), contact('n2')], 'NEW'), 'all', 2);
    expect(ids(next.head)).toEqual(['c:n1', 'g:r1', 'c:n2']);
    expect(next.tail).toEqual([]);
  });

  it('on the Groups tab, group rows ARE the paged rows: a full page with a cursor is complete', () => {
    // Only the All tab treats group rows as additive. Under filter=groups they
    // are what the server pages, so two of them fill a limit-2 page.
    const s = state({ head: [groupText('old')], tail: [groupText('t1')], cursor: 'OLD' });
    const next = mergeHeadRead(s, page([groupText('n1'), groupText('n2')], 'NEW'), 'groups', 2);
    expect(ids(next.head)).toEqual(['gt:n1', 'gt:n2']);
    expect(next.tail).toEqual([]);
    expect(next.cursor).toBe('NEW');
  });

  // SC-5: only the All tab treats relay and group rows as additive. On Unread
  // and Unknown they count toward the limit like any paged row, so a contact
  // plus a group row FILL a limit-2 page: branch C, the tail and the old
  // cursor go. Counting them as additive there would call every full page
  // incomplete and never drop a stale row.
  it.each([
    ['unread', groupText('g1')],
    ['unknown', relay('r1')],
  ] as const)('on %s, a relay or group row is a PAGED row: a full page with a cursor is complete', (filter, multi) => {
    const s = state({ head: [contact('old')], tail: [contact('t1')], cursor: 'OLD' });
    const next = mergeHeadRead(s, page([contact('n1'), multi], 'NEW'), filter, 2);
    expect(ids(next.head)).toEqual(['c:n1', rowKey(multi)]);
    expect(next.tail).toEqual([]);
    expect(next.cursor).toBe('NEW');
  });

  it('drops additive rows absent from the page, as today', () => {
    const s = state({ head: [contact('n1'), relay('r1')], cursor: null });
    const next = mergeHeadRead(s, page([contact('n1')], null), 'all', 100);
    expect(ids(baseOf(next))).toEqual(['c:n1']);
  });

  it('a zero-row page with no cursor and no truncation empties the list and disarms', () => {
    const s = state({ head: [contact('old')], cursor: null, autoLoadArmed: true });
    const next = mergeHeadRead(s, page([], null), 'unknown', 100);
    expect(baseOf(next)).toEqual([]);
    expect(next.autoLoadArmed).toBe(false);
  });

  it('Unknown queue order: a complete page is exactly the fresh page one', () => {
    const s = state({ head: [contact('a'), contact('b')], tail: [contact('c')], cursor: 'OLD' });
    const next = mergeHeadRead(s, page([contact('z'), contact('a')], 'NEW'), 'unknown', 2);
    expect(ids(baseOf(next))).toEqual(['c:z', 'c:a']);
    expect(next.cursor).toBe('NEW');
  });

  it('flags come from the page', () => {
    const s = state({ groupsTruncated: true, truncated: false });
    const next = mergeHeadRead(s, page([contact('n1')], null, { groupsTruncated: false }), 'all', 100);
    expect(next.groupsTruncated).toBe(false);
  });
});

describe('mergeHeadRead - branch I (incomplete head)', () => {
  it('a short page WITH a cursor merges its rows in and removes nothing; the old cursor is kept', () => {
    const s = state({ head: [contact('a'), contact('b')], tail: [contact('t1')], cursor: 'TAIL', autoLoadArmed: true, pageEpoch: 1 });
    const next = mergeHeadRead(s, page([contact('z'), contact('a')], 'SHORT'), 'unread', 100);
    expect(ids(next.head)).toEqual(['c:z', 'c:a', 'c:b']);
    expect(ids(next.tail)).toEqual(['c:t1']);
    expect(next.cursor).toBe('TAIL');
    expect(next.autoLoadArmed).toBe(true);
    expect(next.pageEpoch).toBe(2);
  });

  it('a truncated page is incomplete even when it ends with a null cursor (the Unread depth cap)', () => {
    const s = state({ head: [contact('a')], tail: [contact('t1')], cursor: null });
    const next = mergeHeadRead(s, page([contact('z')], null, { truncated: true }), 'unread', 100);
    expect(ids(baseOf(next))).toEqual(['c:z', 'c:a', 'c:t1']);
    // A null old cursor takes the read's cursor (AD-4), and the read's is null.
    expect(next.cursor).toBeNull();
    expect(next.truncated).toBe(true);
  });

  // AD-4 (build review): only a NON-NULL old cursor is kept. A fully loaded
  // list (null cursor) takes the read's cursor, so a feed that grew past it
  // stays reachable instead of showing "older threads not shown" with no Load
  // more; the next page re-delivers rows the list holds, and appendPage's
  // rowKey dedupe absorbs them.
  it('a list with rows and a NULL cursor takes the read cursor; a non-null cursor is kept', () => {
    const loaded = state({ head: [contact('a')], tail: [contact('t1')], cursor: null });
    const truncatedRead = mergeHeadRead(loaded, page([contact('z')], 'MORE', { truncated: true }), 'unread', 100);
    expect(truncatedRead.cursor).toBe('MORE');
    expect(ids(baseOf(truncatedRead))).toEqual(['c:z', 'c:a', 'c:t1']);
    const shortRead = mergeHeadRead(loaded, page([contact('z')], 'MORE'), 'unknown', 100);
    expect(shortRead.cursor).toBe('MORE');
    const partial = state({ head: [contact('a')], tail: [contact('t1')], cursor: 'TAIL' });
    const kept = mergeHeadRead(partial, page([contact('z')], 'MORE', { truncated: true }), 'unread', 100);
    expect(kept.cursor).toBe('TAIL');
  });

  it('a zero-row budget exit with rows present changes nothing but the flags', () => {
    const s = state({ head: [contact('a')], tail: [contact('t1')], cursor: 'TAIL', autoLoadArmed: false });
    const next = mergeHeadRead(s, page([], 'BUDGET'), 'unknown', 100);
    expect(ids(baseOf(next))).toEqual(['c:a', 'c:t1']);
    expect(next.cursor).toBe('TAIL');
    expect(next.autoLoadArmed).toBe(false);
  });

  it('a zero-row budget exit on an EMPTY list takes the page as-is and its cursor', () => {
    const next = mergeHeadRead(emptyListState(), page([], 'BUDGET'), 'unknown', 100);
    expect(baseOf(next)).toEqual([]);
    expect(next.cursor).toBe('BUDGET');
    expect(next.autoLoadArmed).toBe(false);
  });

  it('a short page with a cursor on an EMPTY list arms from the page', () => {
    const next = mergeHeadRead(emptyListState(), page([contact('z')], 'BUDGET'), 'unread', 100);
    expect(next.autoLoadArmed).toBe(true);
  });

  it('on All, a short page still classifies by paged rows only', () => {
    const s = state({ head: [contact('a')], cursor: 'OLD' });
    // one contact + one relay at limit 2 is SHORT (pagedP.length 1 < 2) with a cursor
    const next = mergeHeadRead(s, page([contact('z'), relay('r1')], 'CUR'), 'all', 2);
    expect(ids(next.head)).toEqual(['c:z', 'g:r1', 'c:a']);
    expect(next.cursor).toBe('OLD');
  });
});

describe('dedupeConversations', () => {
  it('a group_text row in the fresh set drops the relay row of the same conversation', () => {
    const rows = [groupText('x', '2026-06-02T00:00:00.000Z'), relay('x'), contact('c1')];
    const out = dedupeConversations(rows, new Set(['gt:x']));
    expect(ids(out)).toEqual(['gt:x', 'c:c1']);
  });
  it('when neither row is fresh, the first occurrence wins', () => {
    const rows = [relay('x'), groupText('x')];
    expect(ids(dedupeConversations(rows, new Set()))).toEqual(['g:x']);
  });
  it('runs inside mergeHeadRead on both branches', () => {
    const s = state({ head: [relay('x')], cursor: null });
    const complete = mergeHeadRead(s, page([groupText('x')], null), 'all', 100);
    expect(ids(baseOf(complete))).toEqual(['gt:x']);
    const incomplete = mergeHeadRead(s, page([groupText('x')], 'CUR', { truncated: true }), 'all', 100);
    expect(ids(baseOf(incomplete))).toEqual(['gt:x']);
  });
});

describe('appendPage', () => {
  it('appends new rows to the tail, installs the cursor, bumps the epoch and arms', () => {
    const s = state({ head: [contact('a')], cursor: 'C1', pageEpoch: 5, autoLoadArmed: true });
    const next = appendPage(s, page([contact('b')], 'C2'));
    expect(ids(baseOf(next))).toEqual(['c:a', 'c:b']);
    expect(next.cursor).toBe('C2');
    expect(next.pageEpoch).toBe(6);
    expect(next.autoLoadArmed).toBe(true);
  });
  it('skips rows already present by rowKey and disarms when nothing new arrived', () => {
    const s = state({ head: [contact('a')], tail: [contact('b')], cursor: 'C1', autoLoadArmed: true });
    const next = appendPage(s, page([contact('b'), contact('a')], 'C2'));
    expect(ids(baseOf(next))).toEqual(['c:a', 'c:b']);
    expect(next.autoLoadArmed).toBe(false);
    expect(next.cursor).toBe('C2');
  });
  it('an empty page with a cursor disarms and keeps the new cursor', () => {
    const s = state({ head: [contact('a')], cursor: 'C1', autoLoadArmed: true });
    const next = appendPage(s, page([], 'C2'));
    expect(next.autoLoadArmed).toBe(false);
    expect(next.cursor).toBe('C2');
  });
  it('dedupes conversations across kinds, the appended row winning', () => {
    const s = state({ head: [relay('x')], cursor: 'C1' });
    const next = appendPage(s, page([groupText('x')], null));
    expect(ids(baseOf(next))).toEqual(['gt:x']);
  });
});

describe('patchUnread', () => {
  it('rewrites the unread count of one row in head or tail', () => {
    const s = state({ head: [contact('a', undefined, { unreadCount: 2 })], tail: [contact('b', undefined, { unreadCount: 1 })] });
    const next = patchUnread(s, 'c:b', 0);
    expect(next.tail[0]?.unreadCount).toBe(0);
    expect(next.head[0]?.unreadCount).toBe(2);
  });
});
