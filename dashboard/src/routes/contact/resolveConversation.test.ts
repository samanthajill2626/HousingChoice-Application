import { describe, expect, it } from 'vitest';
import { resolveSingleConversation } from './resolveConversation.js';
import type { TimelineItem } from '../../api/index.js';

function msg(conversationId: string, id: string): TimelineItem {
  return {
    kind: 'message',
    id,
    at: '2026-06-08T09:00:00Z',
    conversationId,
    tsMsgId: id,
    direction: 'inbound',
    author: 'tenant',
    type: 'sms',
    delivery_status: 'delivered',
  };
}

describe('resolveSingleConversation', () => {
  it('returns the id when exactly one conversation is involved', () => {
    expect(resolveSingleConversation([msg('c1', 'a'), msg('c1', 'b')])).toBe('c1');
  });

  it('returns null when multiple conversations are involved', () => {
    expect(resolveSingleConversation([msg('c1', 'a'), msg('c2', 'b')])).toBeNull();
  });

  it('returns null when there are no messages', () => {
    expect(resolveSingleConversation([])).toBeNull();
  });

  it('counts a call with a conversationId', () => {
    const call: TimelineItem = {
      kind: 'call',
      id: 'call1',
      at: '2026-06-08T11:00:00Z',
      conversationId: 'c9',
      call_outcome: 'answered',
    };
    expect(resolveSingleConversation([call])).toBe('c9');
  });
});
