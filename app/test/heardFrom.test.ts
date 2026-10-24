// Last heard from (spec docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md,
// sections 5.1 and 14.2): the instant normalizer every last_heard_from_at
// writer shares, and the ONE attribution rule for "which contact is this
// inbound row FROM".
import { describe, expect, it, vi } from 'vitest';
import {
  attributeInbound,
  normalizeInstant,
  oneToOneThreadContactId,
  repoLookup,
  type HeardFromLookup,
  type HeardFromRow,
  type HeardFromThread,
} from '../src/lib/heardFrom.js';
import type { ConversationParticipant } from '../src/repos/conversationsRepo.js';

describe('normalizeInstant', () => {
  it('canonicalizes a Z instant without milliseconds', () => {
    expect(normalizeInstant('2026-09-01T10:00:00Z')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('canonicalizes an offset instant to UTC', () => {
    expect(normalizeInstant('2026-09-01T06:00:00-04:00')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('leaves a canonical instant as it is', () => {
    expect(normalizeInstant('2026-09-01T10:00:00.000Z')).toBe('2026-09-01T10:00:00.000Z');
  });

  it('answers undefined for an unparseable, empty or absent input', () => {
    expect(normalizeInstant('yesterday')).toBeUndefined();
    expect(normalizeInstant('')).toBeUndefined();
    expect(normalizeInstant(undefined)).toBeUndefined();
  });
});

describe('attributeInbound', () => {
  const PHONE_BOOK = new Map([
    ['+15550100007', 'c-nonmember'],
    ['+15550100008', 'c-phone-only'],
    ['+15550100006', 'c-deleted'],
    ['+15550100005', 'c-phone'],
  ]);
  const EMAIL_BOOK = new Map([['e@x.test', 'c-email']]);
  const POOL_NUMBER = '+15550109000';

  // A SYNCHRONOUS lookup over the two books, built fresh per case.
  const makeLookup = () => ({
    byPhone: vi.fn((p: string) => (PHONE_BOOK.has(p) ? { contactId: PHONE_BOOK.get(p)! } : undefined)),
    byEmail: vi.fn((e: string) => (EMAIL_BOOK.has(e) ? { contactId: EMAIL_BOOK.get(e)! } : undefined)),
  });
  // participant_phone on a relay group is the POOL number - never looked up.
  const relay = (participants: ConversationParticipant[]): HeardFromThread => ({
    type: 'relay_group',
    participants,
    participant_phone: POOL_NUMBER,
  });
  const ROSTER_A: ConversationParticipant[] = [{ contactId: 'c-a', phone: '+15550100003' }];
  const PARTICIPANTS_T: ConversationParticipant[] = [{ contactId: 'c-t', phone: '+15550100001' }];
  const inboundSms = (extra: Partial<HeardFromRow> = {}): HeardFromRow => ({
    direction: 'inbound',
    type: 'sms',
    ...extra,
  });

  it('1: an outbound row is never attributed', async () => {
    const thread: HeardFromThread = { type: 'tenant_1to1', participants: PARTICIPANTS_T };
    expect(await attributeInbound({ direction: 'outbound', type: 'sms' }, thread, makeLookup())).toBeUndefined();
  });

  it('2: a relay retry row is never attributed', async () => {
    const row = inboundSms({ relay_sender_key: 'c-a', relay_retry_of: '2026-09-01T10:00:00.000Z#SMx' });
    expect(await attributeInbound(row, relay(ROSTER_A), makeLookup())).toBeUndefined();
  });

  it('3: a group row keyed by a bare contactId is that contact', async () => {
    expect(await attributeInbound(inboundSms({ relay_sender_key: 'c-a' }), relay(ROSTER_A), makeLookup())).toBe(
      'c-a',
    );
  });

  it('4: the staff team key is never attributed', async () => {
    expect(
      await attributeInbound(inboundSms({ relay_sender_key: 'team' }), relay(ROSTER_A), makeLookup()),
    ).toBeUndefined();
  });

  it('5: a phone key resolves through the roster first', async () => {
    const lookup = makeLookup();
    const thread = relay([{ contactId: 'c-z', phone: '+15550100007' }]);
    expect(await attributeInbound(inboundSms({ relay_sender_key: 'phone#+15550100007' }), thread, lookup)).toBe('c-z');
    expect(lookup.byPhone).not.toHaveBeenCalled();
  });

  it('6: a roster entry with an EMPTY contactId counts as absent', async () => {
    const thread = relay([{ contactId: '', phone: '+15550100008' }]);
    expect(await attributeInbound(inboundSms({ relay_sender_key: 'phone#+15550100008' }), thread, makeLookup())).toBe(
      'c-phone-only',
    );
  });

  it('7: a phone key not on the roster resolves through byPhone (or nobody)', async () => {
    expect(
      await attributeInbound(inboundSms({ relay_sender_key: 'phone#+15550100007' }), relay(ROSTER_A), makeLookup()),
    ).toBe('c-nonmember');
    expect(
      await attributeInbound(inboundSms({ relay_sender_key: 'phone#+15550100999' }), relay(ROSTER_A), makeLookup()),
    ).toBeUndefined();
  });

  it('8: a keyless refused call - the stored external caller id beats the phone', async () => {
    const row: HeardFromRow = {
      direction: 'inbound',
      type: 'call',
      relay_external_caller_contact_id: 'c-ext',
      relay_external_caller_phone: '+15550100007',
    };
    expect(await attributeInbound(row, relay(ROSTER_A), makeLookup())).toBe('c-ext');
  });

  it('9: a keyless refused call with only the external phone resolves it (a soft-deleted match)', async () => {
    const row: HeardFromRow = { direction: 'inbound', type: 'call', relay_external_caller_phone: '+15550100006' };
    expect(await attributeInbound(row, relay(ROSTER_A), makeLookup())).toBe('c-deleted');
  });

  it('10: a keyless group row is never the roster and never the pool number', async () => {
    const lookup = makeLookup();
    expect(await attributeInbound({ direction: 'inbound', type: 'call' }, relay(ROSTER_A), lookup)).toBeUndefined();
    expect(lookup.byPhone).not.toHaveBeenCalledWith(POOL_NUMBER);
  });

  it('11: a native group_text thread reads the sender key', async () => {
    const thread: HeardFromThread = {
      type: 'group_text',
      participants: [{ contactId: 'c-g', phone: '+15550100002' }],
    };
    expect(await attributeInbound(inboundSms({ relay_sender_key: 'phone#+15550100002' }), thread, makeLookup())).toBe(
      'c-g',
    );
  });

  it('12: on a 1:1, participants win over a phone that resolves elsewhere', async () => {
    const thread: HeardFromThread = {
      type: 'tenant_1to1',
      participants: PARTICIPANTS_T,
      participant_phone: '+15550100005',
    };
    expect(await attributeInbound(inboundSms(), thread, makeLookup())).toBe('c-t');
  });

  it('13: a 1:1 with an empty participant falls to the participant email', async () => {
    const thread: HeardFromThread = {
      type: 'tenant_1to1',
      participants: [{ contactId: '', phone: '' }],
      participant_email: 'e@x.test',
    };
    expect(await attributeInbound({ direction: 'inbound', type: 'email' }, thread, makeLookup())).toBe('c-email');
  });

  it('14: an unknown 1:1 with no participants resolves its phone', async () => {
    const thread: HeardFromThread = { type: 'unknown_1to1', participant_phone: '+15550100005' };
    expect(await attributeInbound(inboundSms(), thread, makeLookup())).toBe('c-phone');
  });

  it('15: a phone miss falls through to the email lookup', async () => {
    const thread: HeardFromThread = {
      type: 'tenant_1to1',
      participant_phone: '+15550100999',
      participant_email: 'e@x.test',
    };
    expect(await attributeInbound(inboundSms(), thread, makeLookup())).toBe('c-email');
  });

  it('16: an email from a new address is never attributed', async () => {
    const thread: HeardFromThread = { type: 'tenant_1to1', participants: PARTICIPANTS_T };
    const row: HeardFromRow = { direction: 'inbound', type: 'email', email_new_address: true };
    expect(await attributeInbound(row, thread, makeLookup())).toBeUndefined();
  });

  it('17: an email without the new-address flag is attributed (author is not read)', async () => {
    const thread: HeardFromThread = { type: 'landlord_1to1', participants: PARTICIPANTS_T };
    expect(await attributeInbound({ direction: 'inbound', type: 'email' }, thread, makeLookup())).toBe('c-t');
  });

  it('18: a legacy thread with no type takes the 1:1 branch', async () => {
    const thread = { participants: PARTICIPANTS_T } as never;
    expect(await attributeInbound(inboundSms(), thread, makeLookup())).toBe('c-t');
  });

  it('19: an imported 1:1 call with no sender fields is the participant', async () => {
    const thread: HeardFromThread = { type: 'landlord_1to1', participants: PARTICIPANTS_T };
    expect(await attributeInbound({ direction: 'inbound', type: 'call' }, thread, makeLookup())).toBe('c-t');
  });

  it('20: an ASYNC lookup is awaited (MaybePromise)', async () => {
    const lookup: HeardFromLookup = {
      byPhone: async (p) => (PHONE_BOOK.has(p) ? { contactId: PHONE_BOOK.get(p)! } : undefined),
      byEmail: async (e) => (EMAIL_BOOK.has(e) ? { contactId: EMAIL_BOOK.get(e)! } : undefined),
    };
    expect(
      await attributeInbound(inboundSms({ relay_sender_key: 'phone#+15550100007' }), relay(ROSTER_A), lookup),
    ).toBe('c-nonmember');
  });
});

describe('repoLookup', () => {
  const makeContacts = () => ({
    findByPhone: vi.fn(async (_phone: string) => ({ contactId: 'c-repo' })),
    findByEmail: vi.fn(async (_address: string) => ({ contactId: 'c-repo-e' })),
  });
  const cache = new Map([['+15550100001', { contactId: 'c-cached' }]]);

  it('answers a cached phone without reading the repo', async () => {
    const contacts = makeContacts();
    expect(await repoLookup(contacts as never, cache).byPhone('+15550100001')).toEqual({ contactId: 'c-cached' });
    expect(contacts.findByPhone).not.toHaveBeenCalled();
  });

  it('delegates an uncached phone and an email to the repo', async () => {
    const contacts = makeContacts();
    const lookup = repoLookup(contacts as never, cache);
    expect(await lookup.byPhone('+15550100002')).toEqual({ contactId: 'c-repo' });
    expect(contacts.findByPhone).toHaveBeenCalledTimes(1);
    expect(contacts.findByPhone).toHaveBeenCalledWith('+15550100002');
    expect(await lookup.byEmail('a@b.test')).toEqual({ contactId: 'c-repo-e' });
    expect(contacts.findByEmail).toHaveBeenCalledWith('a@b.test');
  });

  it('delegates both lookups without a cache', async () => {
    const contacts = makeContacts();
    const lookup = repoLookup(contacts as never);
    expect(await lookup.byPhone('+15550100001')).toEqual({ contactId: 'c-repo' });
    expect(await lookup.byEmail('a@b.test')).toEqual({ contactId: 'c-repo-e' });
    expect(contacts.findByPhone).toHaveBeenCalledTimes(1);
    expect(contacts.findByEmail).toHaveBeenCalledTimes(1);
  });
});

// today-checklist W8 (PR14, C2): the ONE-TO-ONE half of the attribution rule,
// shared with the dev fixtures' outbound twin. A multi-party thread names no
// single contact.
describe('oneToOneThreadContactId', () => {
  const makeLookup = () => ({
    byPhone: vi.fn((p: string) => (p === '+15550100005' ? { contactId: 'c-phone' } : undefined)),
    byEmail: vi.fn((e: string) => (e === 'e@x.test' ? { contactId: 'c-email' } : undefined)),
  });

  it('names the first roster contact, else the phone holder, else the email holder', async () => {
    expect(
      await oneToOneThreadContactId(
        {
          type: 'tenant_1to1',
          participants: [
            { contactId: '', phone: '+15550100009' },
            { contactId: 'c-t', phone: '+15550100001' },
          ],
        },
        makeLookup(),
      ),
    ).toBe('c-t');
    expect(await oneToOneThreadContactId({ type: 'tenant_1to1', participant_phone: '+15550100005' }, makeLookup())).toBe(
      'c-phone',
    );
    expect(await oneToOneThreadContactId({ type: 'unknown_1to1', participant_email: 'e@x.test' }, makeLookup())).toBe(
      'c-email',
    );
    expect(
      await oneToOneThreadContactId({ type: 'tenant_1to1', participant_phone: '+15550100099' }, makeLookup()),
    ).toBeUndefined();
  });

  it('a relay group or a group text names nobody and reads no repo', async () => {
    const lookup = makeLookup();
    expect(
      await oneToOneThreadContactId(
        { type: 'relay_group', participants: [{ contactId: 'c-r', phone: '+15550100002' }], participant_phone: '+15550109000' },
        lookup,
      ),
    ).toBeUndefined();
    expect(
      await oneToOneThreadContactId({ type: 'group_text', participants: [{ contactId: 'c-g', phone: '+15550100003' }] }, lookup),
    ).toBeUndefined();
    expect(lookup.byPhone).not.toHaveBeenCalled();
  });
});
