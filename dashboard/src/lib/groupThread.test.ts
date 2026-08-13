import { describe, expect, it } from 'vitest';
import { groupThreadLabel } from './groupThread.js';

describe('groupThreadLabel (the dashboard mirror of app/src/lib/groupTitle.ts)', () => {
  it('spells member FIRST names', () => {
    expect(
      groupThreadLabel([
        { name: 'Ann Tenant', phone: '+14045550111' },
        { name: 'Marcus Landlord', phone: '+14045550112' },
      ]),
    ).toBe('With Ann & Marcus');
  });

  it('falls back to the formatted number for a nameless member', () => {
    expect(groupThreadLabel([{ phone: '+16174707727' }])).toBe('With (617) 470-7727');
  });

  it('summarizes past three members', () => {
    expect(
      groupThreadLabel([
        { name: 'A B', phone: '+14045550111' },
        { name: 'C D', phone: '+14045550112' },
        { name: 'E F', phone: '+14045550113' },
        { name: 'G H', phone: '+14045550114' },
      ]),
    ).toBe('With A & C & E +1 more');
  });

  it('degrades to a bare label with no members', () => {
    expect(groupThreadLabel([])).toBe('Group text');
    expect(groupThreadLabel(undefined)).toBe('Group text');
  });

  // A25 / adversarial 20, same class as the senderLabel guard. This runs on the
  // thread HEADER and (via the app mirror) on the inbox row, so a member with no
  // phone must not throw `label.length` and blank the page. Cast through unknown
  // because the type says `phone: string` - the wire shape is the thing that is
  // not guaranteed.
  it('survives a member with NO phone rather than throwing on the label', () => {
    const phoneless = { name: undefined } as unknown as { name?: string; phone: string };
    expect(() => groupThreadLabel([phoneless])).not.toThrow();
    // Nothing to say about them, so they contribute no part - and a roster of
    // only such members degrades to the bare label rather than "With ".
    expect(groupThreadLabel([phoneless])).toBe('Group text');
    expect(groupThreadLabel([{ name: 'Ann Tenant', phone: '+14045550111' }, phoneless])).toBe(
      'With Ann',
    );
  });

  // Adversarial 21, the INVERSE asymmetry: this copy guarded `phone` and left
  // `name` as `m.name?.trim() ?? ''`, which throws on a non-string non-null
  // name, while the app mirror (groupTitle.ts) guarded `name` properly and left
  // `phone` open. Both copies now guard both fields, so they stay output-equal.
  it('survives a NON-STRING name rather than throwing on trim', () => {
    const odd = { name: 42, phone: '+16174707727' } as unknown as { name?: string; phone: string };
    expect(() => groupThreadLabel([odd])).not.toThrow();
    expect(groupThreadLabel([odd])).toBe('With (617) 470-7727');
  });
});
