// The relay 30003 retry ladder's four send gates as ONE evaluator
// (retry-send-window spec D3, Task 3). The retry job runs it before every
// rung's send; the status webhook's claim previews the same gates with it.
// Pure: its only read is the injected `isSuppressed`.
import { describe, expect, it, vi } from 'vitest';
import { relayRetryDigest } from '../src/lib/relayRetryClaim.js';
import { evaluateRelayRetryGates, type RelayRetryGateCode } from '../src/lib/relayRetryGates.js';
import type { ConversationItem, ConversationParticipant } from '../src/repos/conversationsRepo.js';

const ROOT = '2026-09-25T12:00:00.000Z#SMrelay-root-1';
const POOL = '+15550109000';
const ALICE = '+15550100001';
const BOB = '+15550100002';
const BOB_NEW = '+15558675399';
const BOB_KEY = 'c-bob';
/** The digest the claim stored for Bob's ladder: root + the handset it failed on. */
const DEST = relayRetryDigest(ROOT, BOB);

function relayConversation(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: 'conv-relay-1',
    participant_phone: POOL,
    pool_number: POOL,
    status: 'open',
    last_activity_at: '2026-09-25T12:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [
      { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
      { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
    ],
    created_at: '2026-09-25T12:00:00.000Z',
    ...overrides,
  };
}

/** The roster with Bob absent (undefined) or overridden. */
function withBob(member: Partial<ConversationParticipant> | undefined): ConversationParticipant[] {
  const alice: ConversationParticipant = { contactId: 'c-alice', phone: ALICE, name: 'Alice' };
  return member === undefined
    ? [alice]
    : [alice, { contactId: BOB_KEY, phone: BOB, name: 'Bob', ...member }];
}

const notSuppressed = async (_member: ConversationParticipant): Promise<boolean> => false;
const suppressed = async (_member: ConversationParticipant): Promise<boolean> => true;

describe('evaluateRelayRetryGates (retry-send-window D3)', () => {
  it('passes when all four gates pass, handing back the conversation and the matched member', async () => {
    const conversation = relayConversation();
    const isSuppressed = vi.fn(notSuppressed);

    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed,
    });

    expect(result).toEqual({
      refused: false,
      conversation,
      member: { contactId: BOB_KEY, phone: BOB, name: 'Bob' },
    });
    // The suppression read is the ONLY read, asked once, for the matched member.
    expect(isSuppressed).toHaveBeenCalledTimes(1);
    expect(isSuppressed).toHaveBeenCalledWith({ contactId: BOB_KEY, phone: BOB, name: 'Bob' });
  });

  it.each<[string, ConversationItem | undefined, RelayRetryGateCode]>([
    ['an absent conversation', undefined, 'retry_group_closed'],
    ['a closed group', relayConversation({ status: 'closed' }), 'retry_group_closed'],
    ['a group still connecting', relayConversation({ status: 'connecting' }), 'retry_group_closed'],
    ['a member no longer on the roster', relayConversation({ participants: withBob(undefined) }), 'retry_member_removed'],
    ['a member whose number changed', relayConversation({ participants: withBob({ phone: BOB_NEW }) }), 'retry_number_changed'],
    [
      'a member whose number cannot be normalized',
      relayConversation({ participants: withBob({ phone: 'not-a-number' }) }),
      'retry_number_changed',
    ],
  ])('refuses %s with its code, before any suppression read', async (_label, conversation, code) => {
    const isSuppressed = vi.fn(notSuppressed);

    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed,
    });

    expect(result).toEqual({ refused: true, code });
    expect(isSuppressed).not.toHaveBeenCalled();
  });

  it('refuses an opted-out member with retry_opted_out', async () => {
    const result = await evaluateRelayRetryGates({
      conversation: relayConversation(),
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed: suppressed,
    });
    expect(result).toEqual({ refused: true, code: 'retry_opted_out' });
  });

  it('matches a contact-less member by its phone# stored key', async () => {
    const conversation = relayConversation({ participants: [{ contactId: '', phone: BOB }] });
    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: `phone#${BOB}`,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed: notSuppressed,
    });
    expect(result).toMatchObject({ refused: false, member: { phone: BOB } });
  });

  // Two gates refusing at once: the FIRST in the job's order names the code,
  // so the claim's preview and the job's own refusal always agree (spec D3).
  it.each<[string, ConversationItem | undefined, (member: ConversationParticipant) => Promise<boolean>, RelayRetryGateCode]>([
    ['closed AND member removed', relayConversation({ status: 'closed', participants: withBob(undefined) }), notSuppressed, 'retry_group_closed'],
    ['closed AND number changed', relayConversation({ status: 'closed', participants: withBob({ phone: BOB_NEW }) }), notSuppressed, 'retry_group_closed'],
    ['closed AND opted out', relayConversation({ status: 'closed' }), suppressed, 'retry_group_closed'],
    ['member removed AND opted out', relayConversation({ participants: withBob(undefined) }), suppressed, 'retry_member_removed'],
    ['number changed AND opted out', relayConversation({ participants: withBob({ phone: BOB_NEW }) }), suppressed, 'retry_number_changed'],
  ])('with two gates refusing (%s), the first in the job order wins', async (_label, conversation, isSuppressed, code) => {
    const result = await evaluateRelayRetryGates({
      conversation,
      memberKey: BOB_KEY,
      rootTsMsgId: ROOT,
      destDigest: DEST,
      isSuppressed,
    });
    expect(result).toEqual({ refused: true, code });
  });

  it('lets a failing suppression read propagate - the caller fails closed', async () => {
    const isSuppressed = async (_member: ConversationParticipant): Promise<boolean> => {
      throw new Error('dynamodb throttled');
    };
    await expect(
      evaluateRelayRetryGates({
        conversation: relayConversation(),
        memberKey: BOB_KEY,
        rootTsMsgId: ROOT,
        destDigest: DEST,
        isSuppressed,
      }),
    ).rejects.toThrow('dynamodb throttled');
  });
});
