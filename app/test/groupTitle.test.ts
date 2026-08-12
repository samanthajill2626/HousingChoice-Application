// groupTitle - THE server-side roster-derived title for a native group text
// (spec 4.2). This is the copy that titles the inbox row and the contact page's
// "Group threads" card, so a throw here does not blank one header: it 500s
// GET /api/inbox for the WHOLE org.
//
// The dashboard mirror is dashboard/src/lib/groupThread.ts `groupThreadLabel`.
// The two are output-equal by contract, and these cases are deliberately the
// same cases the mirror's suite pins.
import { describe, expect, it } from 'vitest';
import { groupThreadLabel } from '../src/lib/groupTitle.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';

function member(over: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return { contactId: 'c1', phone: '+14045550111', ...over } as ConversationParticipant;
}

describe('groupThreadLabel (app - the canonical derivation)', () => {
  it('spells member FIRST names', () => {
    expect(
      groupThreadLabel([
        member({ name: 'Ann Tenant', phone: '+14045550111' }),
        member({ contactId: 'c2', name: 'Marcus Landlord', phone: '+14045550112' }),
      ]),
    ).toBe('With Ann & Marcus');
  });

  it('falls back to the formatted number for a nameless member', () => {
    expect(groupThreadLabel([member({ phone: '+16174707727' })])).toBe('With (617) 470-7727');
  });

  it('summarizes past three members', () => {
    expect(
      groupThreadLabel([
        member({ name: 'A B', phone: '+14045550111' }),
        member({ name: 'C D', phone: '+14045550112' }),
        member({ name: 'E F', phone: '+14045550113' }),
        member({ name: 'G H', phone: '+14045550114' }),
      ]),
    ).toBe('With A & C & E +1 more');
  });

  it('degrades to a bare label with no members', () => {
    expect(groupThreadLabel([])).toBe('Group text');
    expect(groupThreadLabel(undefined)).toBe('Group text');
  });

  // A25 / adversarial 21. The guard went to the dashboard mirror and NOT here -
  // the copy with the larger blast radius. `formatPhoneForDisplay(undefined)`
  // returns undefined, `undefined ?? undefined` is undefined, and `label.length`
  // then throws inside `groupRowFor`, inside the inbox handler. The type says
  // `phone: string`; the wire shape is what is not guaranteed.
  it('survives a member with NO phone rather than throwing on the label', () => {
    const phoneless = { contactId: 'c9' } as unknown as ConversationParticipant;
    expect(() => groupThreadLabel([phoneless])).not.toThrow();
    // Nothing to say about them, so they contribute no part - and a roster of
    // only such members degrades to the bare label rather than "With ".
    expect(groupThreadLabel([phoneless])).toBe('Group text');
    expect(groupThreadLabel([member({ name: 'Ann Tenant' }), phoneless])).toBe('With Ann');
  });

  it('survives a NON-STRING name rather than throwing on trim', () => {
    const odd = { contactId: 'c9', phone: '+16174707727', name: 42 } as unknown as ConversationParticipant;
    expect(() => groupThreadLabel([odd])).not.toThrow();
    expect(groupThreadLabel([odd])).toBe('With (617) 470-7727');
  });
});
