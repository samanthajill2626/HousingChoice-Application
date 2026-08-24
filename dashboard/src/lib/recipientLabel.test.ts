import { describe, expect, it } from 'vitest';
import type { ConversationParticipant } from '../api/index.js';
import { findMemberByKey } from './memberAttribution.js';
import {
  FORMER_MEMBER_NOTE,
  UNNAMED_RECIPIENT_LABEL,
  phoneFromRecipientKey,
  resolveRecipientLabel,
} from './recipientLabel.js';

function member(over: Partial<ConversationParticipant> = {}): ConversationParticipant {
  return { contactId: 'c1', phone: '+15555550111', name: 'Ann Tenant', ...over };
}

// S2.1. `findMemberByKey` is THE one key matcher, shared by `senderLabel`, the
// relay call summary and `resolveRecipientLabel`, so the proof it is faithful is
// `memberAttribution.test.ts` passing UNCHANGED (24 tests, 19 of which drive the
// matcher). These tests exist for what that suite CANNOT reach: senderLabel
// returns early on an empty key and on the two sentinels, so those inputs never
// arrive at the matcher through it.
describe('findMemberByKey (the shared key matcher)', () => {
  const roster = [
    member(),
    member({ contactId: 'c2', phone: '+15555550222', name: 'Marcus Landlord' }),
  ];

  it('resolves a contactId key (clause A)', () => {
    expect(findMemberByKey('c2', roster)).toBe(roster[1]);
  });

  it('resolves a phone-scoped key (clause B)', () => {
    expect(findMemberByKey('phone#+15555550222', roster)).toBe(roster[1]);
  });

  it('matches the SUPERSET: a phone-scoped key resolves a member carrying a contactId', () => {
    expect(findMemberByKey('phone#+15555550111', roster)).toBe(roster[0]);
  });

  it('keeps two numbers of ONE contact distinct, first match wins', () => {
    const twoNumbers = [
      member({ contactId: 'c9', phone: '+15555550333', name: 'Cell' }),
      member({ contactId: 'c9', phone: '+15555550444', name: 'Desk' }),
    ];
    expect(findMemberByKey('phone#+15555550444', twoNumbers)).toBe(twoNumbers[1]);
  });

  it('is undefined for an unknown key and for an absent roster', () => {
    expect(findMemberByKey('phone#+15555559999', roster)).toBeUndefined();
    expect(findMemberByKey('c1', undefined)).toBeUndefined();
    expect(findMemberByKey('c1', [])).toBeUndefined();
  });

  // THE HOLE THE EXISTING SUITE CANNOT CLOSE. `memberAttribution.test.ts:82`
  // records that two clauses defend this and either alone is sufficient: the
  // `senderKey.length === 0` early return, and `contactId.length > 0` inside the
  // match. The matcher OWNS BOTH now - it early-returns on an empty/undefined key
  // itself - and reaching it directly is the only place in the repo that proves
  // the pair holds without senderLabel's own guard in front of it.
  it('does NOT resolve an empty or undefined key against an empty-contactId stub', () => {
    const stub = member({ contactId: '', phone: '+15555550777', name: 'Stub Member' });
    expect(findMemberByKey('', [stub])).toBeUndefined();
    expect(findMemberByKey(undefined, [stub])).toBeUndefined();
    expect(findMemberByKey('phone#+15555550777', [stub])).toBe(stub);
  });

  it('survives a roster member whose contactId is off-shape', () => {
    const shapeless = { phone: '+15555550888', name: 'Shapeless' } as unknown as ConversationParticipant;
    expect(() => findMemberByKey('c1', [shapeless])).not.toThrow();
    expect(findMemberByKey('c1', [shapeless])).toBeUndefined();
    expect(findMemberByKey('phone#+15555550888', [shapeless])).toBe(shapeless);
  });

  // The EMPTY-PHONE GUARD, which is why this matcher supersedes the one this
  // branch first extracted. A phone-less member used to synthesise the literal
  // key `phone#undefined` and answer to it; now an absent or empty phone matches
  // NOTHING, so a malformed key can never resolve a member by accident. A row
  // keyed that way falls to the former-member/unidentified path instead, which
  // states less rather than stating something false.
  it('never matches a member carrying no phone at all', () => {
    const phoneless = { contactId: 'c-nophone', name: 'No Number' } as unknown as ConversationParticipant;
    expect(() => findMemberByKey('phone#+15555550999', [phoneless])).not.toThrow();
    expect(findMemberByKey('phone#undefined', [phoneless])).toBeUndefined();
    expect(findMemberByKey('phone#', [phoneless])).toBeUndefined();
    // Its contactId still resolves it - only the phone clause is guarded.
    expect(findMemberByKey('c-nophone', [phoneless])).toBe(phoneless);
  });
});

describe('phoneFromRecipientKey (the phone# discriminator)', () => {
  it('returns the E164 remainder of a phone-scoped key', () => {
    expect(phoneFromRecipientKey('phone#+14045550123')).toBe('+14045550123');
  });

  it('is undefined for a contactId key', () => {
    expect(phoneFromRecipientKey('c-abc')).toBeUndefined();
  });

  // The near-miss key space: RosterMemberView.memberKey (tour/placement
  // PeopleCard, app/src/lib/rosterResolution.ts:560) is `phone:` with a COLON
  // and never appears in delivery_recipients. A discriminator written as
  // startsWith('phone') would silently span both spaces.
  it('is undefined for the COLON-form roster key and for a bare phone prefix', () => {
    expect(phoneFromRecipientKey('phone:+14045550123')).toBeUndefined();
    expect(phoneFromRecipientKey('phone')).toBeUndefined();
    expect(phoneFromRecipientKey('phoneish')).toBeUndefined();
  });

  // Phone-keyed with NOTHING after the hash: still phone-keyed (so the caller
  // takes the phone branch) but there is no number to format. The row resolver
  // is what must not go blank on it.
  it('returns an EMPTY remainder rather than undefined for a bare phone# key', () => {
    expect(phoneFromRecipientKey('phone#')).toBe('');
  });

  it('survives an off-shape key', () => {
    expect(phoneFromRecipientKey(7 as unknown as string)).toBeUndefined();
  });
});

// Spec S2's THREE cases. The load-bearing distinction is case 2 vs case 3: an
// absent roster is not the same fact as an absent member.
describe('resolveRecipientLabel - case 1: roster present, key matches a member', () => {
  const roster = [
    member(),
    member({ contactId: 'c2', phone: '+15555550222', name: 'Marcus Landlord' }),
  ];

  it('labels a contactId-keyed row with the member name', () => {
    expect(resolveRecipientLabel('c2', roster)).toEqual({
      label: 'Marcus Landlord',
      phoneKeyed: false,
      match: 'member',
    });
  });

  it('labels a phone-keyed row with the same member name', () => {
    expect(resolveRecipientLabel('phone#+15555550111', roster)).toEqual({
      label: 'Ann Tenant',
      phoneKeyed: true,
      match: 'member',
    });
  });

  // THE PHONE BRANCH IS DECIDED BY THE KEY, NEVER BY THE PRODUCT. relayMemberKey
  // (app/src/repos/messagesRepo.ts:156-160) falls back to `phone#<E164>` for a
  // member with no contactId, so a contactless RELAY member is phone-keyed. A
  // rosterKind === 'group_text' gate would render exactly those rows nameless -
  // which is why this resolver takes no rosterKind at all.
  it('names a contactless (phone-keyed) member by their formatted number', () => {
    const contactless = [{ contactId: '', phone: '+16174707727' } as ConversationParticipant];
    expect(resolveRecipientLabel('phone#+16174707727', contactless)).toEqual({
      label: '(617) 470-7727',
      phoneKeyed: true,
      match: 'member',
    });
  });

  // Spec S2's explicit invariant-6 ruling. senderLabel returns undefined for a
  // nameless RELAY member on purpose; the ROW does not, because a blank row
  // defeats the whole feature. The split is accepted and intended: nameless as
  // an AUTHOR, shown by number as a RECIPIENT. Do not "fix" senderLabel to match.
  it('takes the number fallback for a nameless contactId-keyed relay member', () => {
    const nameless = [{ contactId: 'c9', phone: '+14045550123' } as ConversationParticipant];
    expect(resolveRecipientLabel('c9', nameless)).toEqual({
      label: '(404) 555-0123',
      phoneKeyed: false,
      match: 'member',
    });
  });

  it('survives a matched member whose name is off-shape', () => {
    const odd = [
      { contactId: 'c-odd', phone: '+14045550123', name: 7 } as unknown as ConversationParticipant,
    ];
    expect(() => resolveRecipientLabel('c-odd', odd)).not.toThrow();
    expect(resolveRecipientLabel('c-odd', odd).label).toBe('(404) 555-0123');
  });

  // groupMemberLabel returns '' for a member with neither a name nor a number.
  // A BLANK LABEL IS THE FAILURE MODE THIS FEATURE EXISTS TO PREVENT, so the row
  // still carries something - and it still says the member is on the roster.
  it('never renders a blank label for a matched member with nothing to show', () => {
    const blank = [{ contactId: 'c3', phone: '' } as ConversationParticipant];
    expect(resolveRecipientLabel('c3', blank)).toEqual({
      label: UNNAMED_RECIPIENT_LABEL,
      phoneKeyed: false,
      match: 'member',
    });
  });
});

describe('resolveRecipientLabel - case 2: roster present, NO match (a former member)', () => {
  // Non-empty: the roster is CURRENT membership while the delivery map is
  // HISTORICAL, so a key with no member is somebody removed since the send.
  const roster = [member()];

  it('shows the formatted number and marks a phone-keyed row a former member', () => {
    expect(resolveRecipientLabel('phone#+14045550123', roster)).toEqual({
      label: '(404) 555-0123',
      note: FORMER_MEMBER_NOTE,
      phoneKeyed: true,
      match: 'former_member',
    });
  });

  it('marks a contactId-keyed row a former member with no name', () => {
    expect(resolveRecipientLabel('c-gone', roster)).toEqual({
      label: UNNAMED_RECIPIENT_LABEL,
      note: FORMER_MEMBER_NOTE,
      phoneKeyed: false,
      match: 'former_member',
    });
  });

  it('returns a non-NANP number unchanged rather than mangling it', () => {
    expect(resolveRecipientLabel('phone#+442079460958', roster).label).toBe('+442079460958');
  });

  // formatPhoneDisplay('') is '', so this key would otherwise render a blank row.
  it('never renders a blank label for a phone-keyed row with no number', () => {
    expect(resolveRecipientLabel('phone#', roster)).toEqual({
      label: UNNAMED_RECIPIENT_LABEL,
      note: FORMER_MEMBER_NOTE,
      phoneKeyed: true,
      match: 'former_member',
    });
  });
});

// CASE 3 IS NOT HYPOTHETICAL. TourConversation.tsx:425 and
// PlacementConversation.tsx:281 both initialise `members` to [] and swallow a
// roster fetch failure, so two of the four list-rendering surfaces can render
// with an empty roster indefinitely - and [] is the first frame of every visit
// on both. Treating absent-roster as no-match would assert that EVERY recipient
// of EVERY message is a former member: a confident false statement produced by
// the feature built to stop confident false readings, and worse than the chip it
// replaces because it looks like an answer.
describe('resolveRecipientLabel - case 3: roster ABSENT or EMPTY (no membership claim)', () => {
  it('shows the formatted number for a phone-keyed row, claiming nothing', () => {
    expect(resolveRecipientLabel('phone#+14045550123', undefined)).toEqual({
      label: '(404) 555-0123',
      phoneKeyed: true,
      match: 'unidentified',
    });
    expect(resolveRecipientLabel('phone#+14045550123', [])).toEqual({
      label: '(404) 555-0123',
      phoneKeyed: true,
      match: 'unidentified',
    });
  });

  it('shows a neutral unnamed-recipient label for a contactId-keyed row', () => {
    expect(resolveRecipientLabel('c-unknown', [])).toEqual({
      label: UNNAMED_RECIPIENT_LABEL,
      phoneKeyed: false,
      match: 'unidentified',
    });
    expect(resolveRecipientLabel('c-unknown', undefined)).toEqual({
      label: UNNAMED_RECIPIENT_LABEL,
      phoneKeyed: false,
      match: 'unidentified',
    });
  });

  // THE ASSERTION THIS CASE EXISTS FOR.
  it('NEVER carries the former-member wording, under either key convention', () => {
    const rosters: (ConversationParticipant[] | undefined)[] = [undefined, []];
    for (const roster of rosters) {
      for (const key of ['phone#+14045550123', 'c-unknown', 'phone#']) {
        const resolved = resolveRecipientLabel(key, roster);
        expect(resolved.note).toBeUndefined();
        expect(resolved.match).not.toBe('former_member');
        expect(resolved.label.toLowerCase()).not.toContain(FORMER_MEMBER_NOTE);
      }
    }
  });

  it('treats an off-shape roster as absent rather than as a roster with no match', () => {
    const shapeless = { length: 2 } as unknown as ConversationParticipant[];
    expect(() => resolveRecipientLabel('c-unknown', shapeless)).not.toThrow();
    expect(resolveRecipientLabel('c-unknown', shapeless)).toEqual({
      label: UNNAMED_RECIPIENT_LABEL,
      phoneKeyed: false,
      match: 'unidentified',
    });
  });
});

// A blank row defeats the whole feature, and TWO of this resolver's dependencies
// can hand back '' (groupMemberLabel on a member with neither field,
// formatPhoneDisplay on anything falsy). Every path, one assertion.
describe('resolveRecipientLabel always carries a label', () => {
  const rosters: (ConversationParticipant[] | undefined)[] = [
    undefined,
    [],
    [member()],
    [{ contactId: '', phone: '' } as ConversationParticipant],
    [{} as ConversationParticipant],
  ];
  const keys = ['c1', 'c-unknown', '', 'phone#', 'phone#+14045550123', 'phone#undefined'];

  it('returns a non-empty label for every key and roster shape', () => {
    for (const roster of rosters) {
      for (const key of keys) {
        expect(resolveRecipientLabel(key, roster).label.length).toBeGreaterThan(0);
      }
    }
  });
});
