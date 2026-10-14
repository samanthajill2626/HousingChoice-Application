import { describe, expect, it } from 'vitest';
import { formatInboxTimeFull } from '../routes/inbox/inboxTime.js';
import { compareByName, daysSince, formatHeardFrom, sortByHeardFrom, type NameLike } from './heardFrom.js';

// LOCAL-time constructors so the tiers run in whatever zone the runner has
// (the inboxTime.test.ts convention).
const now = new Date(2026, 8, 25, 15, 30); // Sep 25 2026 15:30 local
const iso = (d: Date): string => d.toISOString();
const DAY = 86_400_000;

describe('formatHeardFrom', () => {
  it('today reads "Today <clock>" with the full stamp as the title', () => {
    const at = iso(new Date(2026, 8, 25, 14, 14));
    expect(formatHeardFrom(at, now)).toEqual({ label: 'Today 2:14 PM', title: formatInboxTimeFull(at) });
    expect(formatHeardFrom(iso(new Date(2026, 8, 25, 0, 5)), now).label).toBe('Today 12:05 AM');
  });
  it('a later instant today is still Today (a clock label, never a date)', () => {
    expect(formatHeardFrom(iso(new Date(2026, 8, 25, 23, 0)), now).label).toBe('Today 11:00 PM');
  });
  it('earlier days follow the inbox tiers: Yesterday, Mon D, Mon D, YYYY', () => {
    expect(formatHeardFrom(iso(new Date(2026, 8, 24, 9, 0)), now).label).toBe('Yesterday');
    expect(formatHeardFrom(iso(new Date(2026, 8, 12, 9, 0)), now).label).toBe('Sep 12');
    expect(formatHeardFrom(iso(new Date(2025, 8, 12, 9, 0)), now).label).toBe('Sep 12, 2025');
  });
  it('absent, empty and unparseable all read Never with no title', () => {
    expect(formatHeardFrom(undefined, now)).toEqual({ label: 'Never', title: '' });
    expect(formatHeardFrom('', now)).toEqual({ label: 'Never', title: '' });
    expect(formatHeardFrom('not-a-date', now)).toEqual({ label: 'Never', title: '' });
  });
  it('a <ISO>#<suffix> sort key reads like its ISO prefix', () => {
    const at = iso(new Date(2026, 8, 12, 9, 0));
    expect(formatHeardFrom(`${at}#msg-1`, now).label).toBe('Sep 12');
  });
});

describe('compareByName', () => {
  const n = (over: Partial<NameLike> & { contactId: string }): NameLike => over;
  it('orders by last name first', () => {
    expect(compareByName(n({ contactId: 'a', firstName: 'Zed', lastName: 'Adams' }), n({ contactId: 'b', firstName: 'Amy', lastName: 'Brown' }))).toBeLessThan(0);
  });
  it('is case-insensitive and trims, then breaks the tie on first name', () => {
    expect(compareByName(n({ contactId: 'a', firstName: 'Bea', lastName: ' adams' }), n({ contactId: 'b', firstName: 'Amy', lastName: 'Adams' }))).toBeGreaterThan(0);
  });
  it('an absent last name sorts first', () => {
    expect(compareByName(n({ contactId: 'a', firstName: 'Cher' }), n({ contactId: 'b', firstName: 'Amy', lastName: 'Adams' }))).toBeLessThan(0);
  });
  it('then the formatted phone, then contactId as the stable key', () => {
    const base = { firstName: 'Amy', lastName: 'Adams' };
    expect(compareByName(n({ ...base, contactId: 'z', phone: '+14045550001' }), n({ ...base, contactId: 'a', phone: '+14045550002' }))).toBeLessThan(0);
    expect(compareByName(n({ ...base, contactId: 'a' }), n({ ...base, contactId: 'b' }))).toBeLessThan(0);
    expect(compareByName(n({ ...base, contactId: 'a' }), n({ ...base, contactId: 'a' }))).toBe(0);
  });
});

describe('sortByHeardFrom', () => {
  interface SnakeRow { contactId: string; firstName?: string; lastName?: string; last_heard_from_at?: string }
  const snake = (rows: SnakeRow[]): SnakeRow[] =>
    sortByHeardFrom(rows, { heardAt: (r) => r.last_heard_from_at, name: (r) => r });
  it('most recent first, absent and unparseable last, ties by the name comparator', () => {
    const rows: SnakeRow[] = [
      { contactId: 'never-b', lastName: 'Brown' },
      { contactId: 'old', lastName: 'Old', last_heard_from_at: '2026-09-01T12:00:00.000Z' },
      { contactId: 'bad', lastName: 'Aaron', last_heard_from_at: 'garbage' },
      { contactId: 'new', lastName: 'New', last_heard_from_at: '2026-09-20T12:00:00.000Z' },
      { contactId: 'tie-z', lastName: 'Zed', last_heard_from_at: '2026-09-10T12:00:00.000Z' },
      { contactId: 'tie-a', lastName: 'Abe', last_heard_from_at: '2026-09-10T12:00:00.000Z' },
    ];
    expect(snake(rows).map((r) => r.contactId)).toEqual(['new', 'tie-a', 'tie-z', 'old', 'bad', 'never-b']);
  });
  it('returns a NEW array and leaves the input order alone', () => {
    const rows: SnakeRow[] = [{ contactId: 'a' }, { contactId: 'b', last_heard_from_at: '2026-09-20T12:00:00.000Z' }];
    const out = snake(rows);
    expect(out).not.toBe(rows);
    expect(rows.map((r) => r.contactId)).toEqual(['a', 'b']);
  });
  it('serves the camelCase wire rows through the same accessor contract', () => {
    const rows = [
      { contactId: 'x', name: 'X', lastHeardFromAt: undefined as string | undefined },
      { contactId: 'y', name: 'Y', lastHeardFromAt: '2026-09-20T12:00:00.000Z' },
    ];
    const out = sortByHeardFrom(rows, { heardAt: (r) => r.lastHeardFromAt, name: (r) => ({ contactId: r.contactId, firstName: r.name }) });
    expect(out.map((r) => r.contactId)).toEqual(['y', 'x']);
  });
});

describe('daysSince', () => {
  it('floors whole days on the given clock', () => {
    expect(daysSince(new Date(now.getTime() - 2 * DAY - 3_600_000).toISOString(), now)).toBe(2);
    expect(daysSince(new Date(now.getTime() - 3 * DAY).toISOString(), now)).toBe(3);
    expect(daysSince(new Date(now.getTime() - 23 * 3_600_000).toISOString(), now)).toBe(0);
  });
  it('a future instant and an unparseable value read 0', () => {
    expect(daysSince(new Date(now.getTime() + DAY).toISOString(), now)).toBe(0);
    expect(daysSince('garbage', now)).toBe(0);
  });
});
