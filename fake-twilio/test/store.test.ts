// fake-twilio/test/store.test.ts
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/engine/store.js';
import type { ThreadMessage } from '../src/engine/types.js';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    sid: 'SM1', direction: 'outbound', from: '+15550009999', to: '+15550100001',
    body: 'hi', state: 'queued', createdAt: '2026-06-15T00:00:00.000Z', updatedAt: '2026-06-15T00:00:00.000Z',
    ...over,
  };
}

describe('ConversationStore', () => {
  it('appends messages into a per-party thread', () => {
    const store = new ConversationStore();
    store.append('+15550100001', msg({ sid: 'SM1' }));
    store.append('+15550100001', msg({ sid: 'SM2', direction: 'inbound', from: '+15550100001', to: '+15550009999' }));
    expect(store.thread('+15550100001').messages.map((m) => m.sid)).toEqual(['SM1', 'SM2']);
  });

  it('updates a message state by sid', () => {
    const store = new ConversationStore();
    store.append('+15550100001', msg({ sid: 'SM1', state: 'queued' }));
    store.updateState('SM1', 'delivered');
    expect(store.thread('+15550100001').messages[0]?.state).toBe('delivered');
  });

  it('lists all threads and resets cleanly', () => {
    const store = new ConversationStore();
    store.append('+15550100001', msg());
    store.append('+15550100002', msg({ to: '+15550100002' }));
    expect(store.listThreads().length).toBe(2);
    store.reset();
    expect(store.listThreads()).toHaveLength(0);
  });
});
