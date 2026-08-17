// groupTitle - THE server-side roster-derived title for a native group text
// (spec 4.2). This is the copy that titles the inbox row and the contact page's
// "Group threads" card, so a throw here does not blank one header: it 500s
// GET /api/inbox for the WHOLE org.
//
// The dashboard mirror is dashboard/src/lib/groupThread.ts `groupThreadLabel`.
// The two are output-equal by contract, and these cases are deliberately the
// same cases the mirror's suite pins.
import { describe, expect, it } from 'vitest';
import { groupThreadLabel, relayThreadLabel } from '../src/lib/groupTitle.js';
import type {
  ConversationItem,
  ConversationParticipant,
} from '../src/repos/conversationsRepo.js';

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

// relayThreadLabel is the OTHER derivation: a relay group carries a pool number
// and an operator tag that a native group text does not, so its chain has four
// rungs where groupThreadLabel has one rule. These cases are the same four rungs
// app/test/inboxFeed.test.ts pins through the inbox row - that test staying
// green UNCHANGED is the parity gate for the routes/inbox.ts re-point.
function relayConv(fields: Record<string, unknown>): ConversationItem {
  return { conversationId: 'r1', status: 'open', type: 'relay_group', ...fields } as ConversationItem;
}

describe('relayThreadLabel', () => {
  it('prefers member names: "With A & B"', () => {
    const conv = relayConv({
      participants: [
        member({ contactId: 'c1', phone: '+15550100001', name: 'Ana Diaz' }),
        member({ contactId: 'c2', phone: '+15550100002', name: ' Jose ' }),
        member({ contactId: 'c3', phone: '+15550100003', name: '' }),
      ],
    });
    expect(relayThreadLabel(conv)).toBe('With Ana Diaz & Jose');
  });
  it('falls back to the operator placement_tag', () => {
    expect(relayThreadLabel(relayConv({ placement_tag: ' 12 Oak St ' }))).toBe('12 Oak St');
  });
  it('falls back to the formatted pool number', () => {
    const label = relayThreadLabel(relayConv({ pool_number: '+15550100009' }));
    expect(label).toContain('555');
    expect(label).not.toBe('Relay group');
  });
  it('falls back to "Relay group" when nothing else exists', () => {
    expect(relayThreadLabel(relayConv({}))).toBe('Relay group');
  });
});
