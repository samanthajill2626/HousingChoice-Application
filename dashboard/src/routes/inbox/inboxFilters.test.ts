import { describe, expect, it } from 'vitest';
import { INBOX_FILTERS, emptyCopy } from './inboxFilters.js';

describe('inboxFilters', () => {
  it('lists the filters with All first (the default) and Groups last', () => {
    expect(INBOX_FILTERS.map((t) => t.filter)).toEqual(['all', 'unread', 'unknown', 'groups']);
    expect(INBOX_FILTERS[0]?.label).toBe('All');
    expect(INBOX_FILTERS[3]?.label).toBe('Groups');
  });

  it('gives the groups filter its own empty copy', () => {
    expect(emptyCopy('groups')).toEqual({
      title: 'No group texts yet',
      body: 'Group texts you are part of show up here.',
    });
  });

  it('gives each filter distinct, non-empty empty-state copy', () => {
    const titles = INBOX_FILTERS.map((t) => emptyCopy(t.filter).title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const t of INBOX_FILTERS) {
      const c = emptyCopy(t.filter);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });

  it("the unread filter's copy points back to All", () => {
    expect(emptyCopy('unread').body).toMatch(/All/);
  });
});
