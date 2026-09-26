import { beforeEach, describe, expect, it } from 'vitest';
import type { InboxRow } from '../../api/index.js';
import {
  clearInboxLists,
  inboxListKey,
  loadInboxList,
  saveInboxList,
  type InboxListSnapshot,
} from './inboxListStore.js';

function row(id: string): InboxRow {
  return {
    kind: 'contact',
    contactId: id,
    name: id,
    unreadCount: 0,
    preview: '',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-17T10:00:00.000Z',
    needsTriage: false,
  };
}
function snap(over: Partial<InboxListSnapshot> = {}): InboxListSnapshot {
  return {
    head: [row('c1')],
    tail: [],
    cursor: null,
    groupsTruncated: false,
    truncated: false,
    scrollTop: 0,
    ...over,
  };
}

beforeEach(() => clearInboxLists());

describe('inboxListStore', () => {
  it('keys by operator, filter and limit', () => {
    expect(inboxListKey('u1', 'all', 100)).toBe('u1:all:100');
    expect(inboxListKey('u1', 'unread', 30)).not.toBe(inboxListKey('u2', 'unread', 30));
    expect(inboxListKey('u1', 'all', 100)).not.toBe(inboxListKey('u1', 'all', 50));
  });

  it('loads what was saved under the same key and nothing under another', () => {
    saveInboxList('u1:all:100', snap({ scrollTop: 420 }));
    expect(loadInboxList('u1:all:100')?.scrollTop).toBe(420);
    expect(loadInboxList('u2:all:100')).toBeUndefined();
    expect(loadInboxList('u1:unread:100')).toBeUndefined();
  });

  it('a later save replaces the earlier one', () => {
    saveInboxList('u1:all:100', snap({ head: [row('c1')] }));
    saveInboxList('u1:all:100', snap({ head: [row('c2')] }));
    expect(loadInboxList('u1:all:100')?.head.map((r) => r.contactId)).toEqual(['c2']);
  });

  it('clear empties every key', () => {
    saveInboxList('u1:all:100', snap());
    saveInboxList('u2:all:100', snap());
    clearInboxLists();
    expect(loadInboxList('u1:all:100')).toBeUndefined();
    expect(loadInboxList('u2:all:100')).toBeUndefined();
  });
});
