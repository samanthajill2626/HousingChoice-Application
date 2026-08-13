import { describe, expect, it } from 'vitest';
import type { ConversationParticipant } from '../api/index.js';
import { memberKey, phoneMemberKey, senderLabel } from './memberAttribution.js';

function member(over: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return { contactId: 'c1', phone: '+15555550111', name: 'Ann Tenant', ...over };
}

describe('memberKey (relay convention, byte-identical to the app helper)', () => {
  it('prefers the contactId when one is set', () => {
    expect(memberKey(member())).toBe('c1');
  });

  it('falls back to the phone-scoped key when the contactId is empty', () => {
    expect(memberKey(member({ contactId: '' }))).toBe('phone#+15555550111');
  });
});

describe('phoneMemberKey (group_text convention, spec 15.6)', () => {
  it('is always phone-scoped, even when a contactId is present', () => {
    expect(phoneMemberKey(member())).toBe('phone#+15555550111');
  });
});

describe('senderLabel', () => {
  const roster = [
    member(),
    member({ contactId: 'c2', phone: '+15555550222', name: 'Marcus Landlord' }),
  ];

  it('maps the team sentinel to Team', () => {
    expect(senderLabel('team', roster)).toBe('Team');
  });

  it('maps the system sentinel to Automated', () => {
    expect(senderLabel('system', roster)).toBe('Automated');
  });

  it('resolves a relay-convention contactId key to that member name', () => {
    expect(senderLabel('c2', roster)).toBe('Marcus Landlord');
  });

  it('resolves a PHONE-SCOPED key to the same member (group_text convention)', () => {
    expect(senderLabel('phone#+15555550222', roster)).toBe('Marcus Landlord');
  });

  it('resolves a phone-scoped key even when the member carries a contactId', () => {
    // Spec 15.6: group_text keys are phone-scoped while the roster still carries
    // contactId as display metadata. The superset match is what makes ONE
    // renderer serve both conventions with no mode flag.
    expect(senderLabel('phone#+15555550111', roster)).toBe('Ann Tenant');
  });

  it('keeps two numbers of ONE contact distinct under phone-scoped keys', () => {
    const twoNumbers = [
      member({ contactId: 'c9', phone: '+15555550333', name: 'Cell' }),
      member({ contactId: 'c9', phone: '+15555550444', name: 'Desk' }),
    ];
    expect(senderLabel('phone#+15555550444', twoNumbers)).toBe('Desk');
  });

  it('is undefined for an unknown key', () => {
    expect(senderLabel('phone#+15555559999', roster)).toBeUndefined();
  });

  it('is undefined for a matched RELAY member with no resolved name', () => {
    // Invariant 6: relay's rendering is frozen. A nameless relay member still
    // gets no attribution line, exactly as before the group_text fallback.
    expect(senderLabel('c3', [member({ contactId: 'c3', name: undefined })])).toBeUndefined();
    expect(senderLabel('c3', [member({ contactId: 'c3', name: undefined })], 'relay')).toBeUndefined();
  });

  it('is undefined for an absent or empty sender key', () => {
    expect(senderLabel(undefined, roster)).toBeUndefined();
    expect(senderLabel('', roster)).toBeUndefined();
  });

  it('is undefined when there is no roster', () => {
    expect(senderLabel('c1', undefined)).toBeUndefined();
  });

  it('an EMPTY-contactId stub resolves by phone and by nothing else', () => {
    // The untested population: every migrated / phone-only roster entry carries
    // `contactId: ''`. Three facts about it at once.
    //
    // HONEST NOTE ON WHAT GUARDS THIS. Two clauses defend the last assertion and
    // EITHER ONE alone is sufficient: the early `senderKey.length === 0` return,
    // and `m.contactId.length > 0 &&` in the match. Deleting one leaves this
    // green; deleting BOTH turns the last line red (an empty key would resolve
    // to this stub's name). They are a deliberate pair, and this is the only
    // test that holds the pair.
    const stub = member({ contactId: '', phone: '+15555550777', name: 'Stub Member' });
    expect(senderLabel('phone#+15555550777', [stub])).toBe('Stub Member');
    expect(senderLabel('c1', [stub])).toBeUndefined();
    expect(senderLabel('', [stub])).toBeUndefined();
  });

  // A25 / adversarial 20. senderLabel runs for EVERY bubble in BOTH the relay
  // and the group timeline, so an unguarded `m.contactId.length` does not blank
  // one chip - it throws and blanks the whole conversation page. The roster the
  // relay view seeds comes straight from `header.participants`, a raw
  // passthrough documented as arriving in more than one wire shape, so the type
  // saying `contactId: string` is not a runtime guarantee. The code this
  // function replaced guarded exactly this.
  it('survives a roster member whose contactId is ABSENT (not just empty)', () => {
    const shapeless = { phone: '+15555550888', name: 'Shapeless' } as unknown as ConversationParticipant;
    expect(() => senderLabel('c1', [shapeless])).not.toThrow();
    expect(senderLabel('c1', [shapeless])).toBeUndefined();
    // ...and the member is still resolvable by the key that DOES exist.
    expect(senderLabel('phone#+15555550888', [shapeless])).toBe('Shapeless');
  });

  it('survives a roster member whose PHONE is absent', () => {
    const phoneless = { contactId: 'c-nophone', name: 'No Number' } as unknown as ConversationParticipant;
    expect(() => senderLabel('c-nophone', [phoneless])).not.toThrow();
    expect(senderLabel('c-nophone', [phoneless])).toBe('No Number');
    expect(() => senderLabel('phone#+15555550999', [phoneless])).not.toThrow();
  });

  // Adversarial 28. The restored guard covered `contactId` and stopped there,
  // leaving `m.name?.trim()` - and `name` is the field MOST likely to arrive
  // off-shape from a raw passthrough. Same blast radius as the contactId case:
  // it throws for the matched member and blanks the whole conversation page.
  it('survives a roster member whose NAME is not a string', () => {
    const odd = { contactId: 'c-odd', phone: '+15555550444', name: 7 } as unknown as ConversationParticipant;
    expect(() => senderLabel('c-odd', [odd])).not.toThrow();
    // Nothing usable to say on relay, and the formatted number on group_text -
    // exactly what a nameless member yields, because that is what it is.
    expect(senderLabel('c-odd', [odd])).toBeUndefined();
    expect(senderLabel('c-odd', [odd], 'group_text')).toBe('(555) 555-0444');
  });
});

// LIVE QA ROUND 2, L6. Every member a native carrier group detects is a bare
// stub with only a phone number, so the no-name case is not an edge - it is the
// ENTIRE population of a fresh group thread. Before this, no message in a group
// thread was ever attributed to anyone.
describe('senderLabel on a group_text roster (spec 4.2: names, ELSE formatted numbers)', () => {
  const stub = (phone: string): ConversationParticipant => ({ contactId: '', phone });

  it('attributes a NAMELESS member by their formatted phone number', () => {
    expect(senderLabel('phone#+16174707727', [stub('+16174707727')], 'group_text')).toBe(
      '(617) 470-7727',
    );
  });

  it('attributes a nameless member carrying a contactId by number too', () => {
    // The stub minted by detection HAS a contactId (a derived one) and still no
    // name - which is exactly the shape live QA hit.
    const detected: ConversationParticipant = { contactId: 'c-detected', phone: '+16783837896' };
    expect(senderLabel('phone#+16783837896', [detected], 'group_text')).toBe('(678) 383-7896');
    expect(senderLabel('c-detected', [detected], 'group_text')).toBe('(678) 383-7896');
  });

  it('still prefers a resolved name over the number', () => {
    const named: ConversationParticipant = {
      contactId: 'c5',
      phone: '+15555550222',
      name: 'Marcus Landlord',
    };
    expect(senderLabel('phone#+15555550222', [named], 'group_text')).toBe('Marcus Landlord');
  });

  it('treats a whitespace-only name as no name', () => {
    const blank: ConversationParticipant = { contactId: 'c6', phone: '+15555550333', name: '   ' };
    expect(senderLabel('c6', [blank], 'group_text')).toBe('(555) 555-0333');
  });

  it('returns a non-NANP number unchanged rather than mangling it', () => {
    expect(senderLabel('phone#+442079460958', [stub('+442079460958')], 'group_text')).toBe(
      '+442079460958',
    );
  });

  it('is still undefined when the member has no number at all to fall back to', () => {
    expect(senderLabel('c7', [{ contactId: 'c7', phone: '' }], 'group_text')).toBeUndefined();
  });

  it('leaves the sentinels and the unknown-key case alone', () => {
    expect(senderLabel('team', [stub('+15555550111')], 'group_text')).toBe('Team');
    expect(senderLabel('system', [stub('+15555550111')], 'group_text')).toBe('Automated');
    expect(senderLabel('phone#+15555559999', [stub('+15555550111')], 'group_text')).toBeUndefined();
  });
});
