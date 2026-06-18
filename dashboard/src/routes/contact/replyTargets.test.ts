import { describe, expect, it } from 'vitest';
import { buildReplyTargets } from './replyTargets.js';
import type { ContactPhone, TimelineItem } from '../../api/index.js';

function msg(conversationId: string, dir: 'inbound' | 'outbound', phone: string, at: string): TimelineItem {
  return {
    kind: 'message',
    id: `${conversationId}:${at}`,
    at,
    conversationId,
    tsMsgId: `${at}#x`,
    direction: dir,
    author: dir === 'inbound' ? 'tenant' : 'teammate',
    type: 'sms',
    delivery_status: 'delivered',
    ...(dir === 'inbound' ? { fromPhone: phone } : { toPhone: phone }),
  } as TimelineItem;
}

const A = '+14040100001';
const B = '+14040100002';

describe('buildReplyTargets', () => {
  it('maps a single number to its conversation and defaults to it', () => {
    const items = [msg('conv-a', 'inbound', A, '2026-06-08T09:00:00')];
    const phones: ContactPhone[] = [{ phone: A, primary: true }];
    const { targets, defaultConversationId } = buildReplyTargets(items, phones);
    expect(targets).toEqual([{ phone: A, conversationId: 'conv-a' }]);
    expect(defaultConversationId).toBe('conv-a');
  });

  it('offers each number with a thread and defaults to the PRIMARY number’s thread', () => {
    const items = [
      msg('conv-a', 'inbound', A, '2026-06-08T09:00:00'),
      msg('conv-b', 'outbound', B, '2026-06-08T10:00:00'),
    ];
    // B is primary → its thread is the default, even though A's message is older.
    const phones: ContactPhone[] = [
      { phone: A, primary: false, label: 'old' },
      { phone: B, primary: true, label: 'cell' },
    ];
    const { targets, defaultConversationId } = buildReplyTargets(items, phones);
    expect(targets).toEqual([
      { phone: A, label: 'old', conversationId: 'conv-a' },
      { phone: B, label: 'cell', conversationId: 'conv-b' },
    ]);
    expect(defaultConversationId).toBe('conv-b');
  });

  it('uses the contact-side number (fromPhone inbound / toPhone outbound), not our number', () => {
    // An outbound message's toPhone is the contact; fromPhone would be our number.
    const items = [msg('conv-a', 'outbound', A, '2026-06-08T09:00:00')];
    const phones: ContactPhone[] = [{ phone: A, primary: true }];
    expect(buildReplyTargets(items, phones).targets).toEqual([{ phone: A, conversationId: 'conv-a' }]);
  });

  it('falls back to the only distinct conversation when no number matches the record', () => {
    // The timeline has a thread but its phone isn’t on the contact's phones[].
    const items = [msg('conv-z', 'inbound', '+19998887777', '2026-06-08T09:00:00')];
    const phones: ContactPhone[] = [{ phone: A, primary: true }];
    const { targets, defaultConversationId } = buildReplyTargets(items, phones);
    expect(targets).toEqual([]); // no number-matched target
    expect(defaultConversationId).toBe('conv-z'); // but the single thread is still sendable
  });

  it('returns null default when there is nothing to send into', () => {
    expect(buildReplyTargets([], [{ phone: A, primary: true }]).defaultConversationId).toBeNull();
  });
});
