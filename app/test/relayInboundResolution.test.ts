// Shared relay inbound resolution (relay-number-lifecycle): ONE ladder deciding
// which of a pool number's many participant-disjoint groups an inbound (SMS or
// voice) belongs to, extracted so the two webhooks cannot drift. The terminal
// ACTIONS stay per-channel; this suite pins the selection POLICY only.
import { describe, expect, it } from 'vitest';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import {
  byNewestCreated,
  resolveRelayInbound,
} from '../src/services/relayInboundResolution.js';

const ALICE = '+15550100001';
const BOB = '+15550100002';
const DAVE = '+15550100004';

function group(over: Partial<ConversationItem>): ConversationItem {
  return {
    conversationId: 'conv-x',
    participant_phone: '+15550109000',
    pool_number: '+15550109000',
    status: 'open',
    last_activity_at: '2026-08-21T12:00:00.000Z',
    type: 'relay_group',
    ai_mode: 'manual',
    participants: [{ contactId: 'c-a', phone: ALICE, name: 'Alice' }],
    created_at: '2026-08-21T12:00:00.000Z',
    ...over,
  };
}

describe('resolveRelayInbound - the shared (To, From) ladder', () => {
  it('returns undefined when the number fronts no groups', () => {
    expect(resolveRelayInbound([], ALICE)).toBeUndefined();
  });

  it('(a) picks the OPEN group whose roster contains the sender', () => {
    const mine = group({ conversationId: 'conv-mine' });
    const other = group({
      conversationId: 'conv-other',
      participants: [{ contactId: 'c-d', phone: DAVE, name: 'Dave' }],
      created_at: '2026-08-22T12:00:00.000Z', // newer, but not the sender's
    });
    const res = resolveRelayInbound([other, mine], ALICE);
    expect(res).toMatchObject({ kind: 'open_member', group: { conversationId: 'conv-mine' } });
    expect(res && res.kind === 'open_member' ? res.violatingOpenMatchIds : 'wrong-kind').toBeUndefined();
  });

  it('(a) burn-invariant violation: two open matches -> the newest, with the colliding ids surfaced', () => {
    const older = group({ conversationId: 'conv-older', created_at: '2026-08-20T12:00:00.000Z' });
    const newer = group({ conversationId: 'conv-newer', created_at: '2026-08-22T12:00:00.000Z' });
    const res = resolveRelayInbound([older, newer], ALICE);
    expect(res).toMatchObject({ kind: 'open_member', group: { conversationId: 'conv-newer' } });
    expect(res && res.kind === 'open_member' ? res.violatingOpenMatchIds : undefined).toEqual([
      'conv-newer',
      'conv-older',
    ]);
  });

  it("(b) sender only on CLOSED rosters -> their newest closed group", () => {
    const olderClosed = group({
      conversationId: 'conv-closed-old',
      status: 'closed',
      created_at: '2026-08-18T12:00:00.000Z',
    });
    const newerClosed = group({
      conversationId: 'conv-closed-new',
      status: 'closed',
      created_at: '2026-08-19T12:00:00.000Z',
    });
    const openOther = group({
      conversationId: 'conv-open-other',
      participants: [{ contactId: 'c-d', phone: DAVE, name: 'Dave' }],
    });
    const res = resolveRelayInbound([olderClosed, openOther, newerClosed], ALICE);
    expect(res).toMatchObject({
      kind: 'closed_member',
      group: { conversationId: 'conv-closed-new' },
    });
  });

  it('(c) sender on NO roster with an open group present -> newest open, for the record', () => {
    const open1 = group({ conversationId: 'conv-o1', created_at: '2026-08-18T12:00:00.000Z' });
    const open2 = group({ conversationId: 'conv-o2', created_at: '2026-08-19T12:00:00.000Z' });
    const res = resolveRelayInbound([open1, open2], BOB);
    expect(res).toMatchObject({ kind: 'non_member_open', group: { conversationId: 'conv-o2' } });
  });

  it('(d / AF-5) sender on NO roster and every group closed -> all_closed_non_member, NO group picked', () => {
    const closed = group({ conversationId: 'conv-dead', status: 'closed' });
    const res = resolveRelayInbound([closed], BOB);
    expect(res).toEqual({ kind: 'all_closed_non_member' });
  });

  it('byNewestCreated sorts a missing created_at LAST (deliberate: an undated legacy row never wins)', () => {
    const dated = group({ conversationId: 'conv-dated' });
    const undated = group({ conversationId: 'conv-undated' });
    delete (undated as Partial<ConversationItem>).created_at;
    expect([undated, dated].sort(byNewestCreated)[0]?.conversationId).toBe('conv-dated');
  });
});
