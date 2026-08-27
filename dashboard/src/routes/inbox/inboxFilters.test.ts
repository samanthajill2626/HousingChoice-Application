import { describe, expect, it } from 'vitest';
import { INBOX_FILTERS, emptyClearedCopy, emptyCopy, emptyMoreCopy } from './inboxFilters.js';

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

  // FIX 5 (phase-6 review, 2026-08-26). The body used to read "Untriaged
  // inbound numbers show up here", and the tab cannot deliver that sentence on
  // three counts: a number with NO contact record has nothing to return
  // (coverage class (e), accepted as lost - those threads stay on All), a
  // `team_member` is excluded by ruling (class (c)), and an unknown contact
  // already moved to `status: 'active'` IS here (class (f)), so "untriaged" is
  // not the criterion either. What puts a row on this tab is being
  // UNIDENTIFIED. See docs/superpowers/specs/
  // 2026-08-25-inbox-unknown-tab-walk-design.md section 3.
  //
  // THE SENTENCE IS ASSERTED FROM ITS SOURCE, not re-typed: the whole reason a
  // false line survived this long is that correcting it meant finding every
  // verbatim copy. `Inbox.test.tsx` now imports this module for the same reason.
  it('the unknown filter promises only what the tab can show', () => {
    const body = emptyCopy('unknown').body;
    expect(body).not.toMatch(/untriaged/i);
    expect(body).toMatch(/identified/i);
  });

  // The two NON-filter empty states. Both are statements about the request that
  // just returned, not about the filter, which is why they live outside
  // `emptyCopy` - and all three titles must stay distinct, because Inbox.tsx
  // picks between them and the pins there assert the others are ABSENT.
  it('keeps the three empty-state titles distinct and non-empty', () => {
    const extras = [emptyMoreCopy(), emptyClearedCopy()];
    for (const copy of extras) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
    const all = [...INBOX_FILTERS.map((t) => emptyCopy(t.filter)), ...extras].map((c) => c.title);
    expect(new Set(all).size).toBe(all.length);
  });

  // The cleared-page copy must not invent a server statement. A cursor is minted
  // whenever a page FILLS - including on a feed that ends at an exact multiple
  // of the limit - so "there are more unread behind this" is not something this
  // state knows. It says the page is done and points at the affordance.
  it('the cleared-page copy claims nothing about what is behind the cursor', () => {
    const { title, body } = emptyClearedCopy();
    expect(`${title} ${body}`).not.toMatch(/caught up|stopped early/i);
    expect(body).toMatch(/Load more/);
  });
});
