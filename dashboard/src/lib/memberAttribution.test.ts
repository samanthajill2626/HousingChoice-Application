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

  it('is undefined for a matched member with no resolved name', () => {
    expect(senderLabel('c3', [member({ contactId: 'c3', name: undefined })])).toBeUndefined();
  });

  it('is undefined for an absent or empty sender key', () => {
    expect(senderLabel(undefined, roster)).toBeUndefined();
    expect(senderLabel('', roster)).toBeUndefined();
  });

  it('is undefined when there is no roster', () => {
    expect(senderLabel('c1', undefined)).toBeUndefined();
  });

  it('never matches an empty contactId against an empty key', () => {
    expect(senderLabel('', [member({ contactId: '' })])).toBeUndefined();
  });
});
