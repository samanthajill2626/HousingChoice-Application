// useFakePhones data-hook tests. The client + SSE hook are mocked so the test
// can (a) assert the initial load wires personas+threads into state and (b) drive
// the pure merge reducer through each EngineEvent type via the captured onEvent.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, Persona, Thread, ThreadMessage } from '../api/types.js';
import { mergeEvent, type FakeState } from './useFakePhones.js';

// ---- Pure-reducer unit tests (no React) -------------------------------------

const msg = (over: Partial<ThreadMessage>): ThreadMessage => ({
  sid: 'SM1',
  direction: 'inbound',
  from: '+15550100001',
  to: '+15550009999',
  state: 'delivered',
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
  ...over,
});

const baseState = (over: Partial<FakeState> = {}): FakeState => ({
  personas: [],
  threads: [],
  unreadByNumber: {},
  selected: null,
  ...over,
});

describe('mergeEvent (pure)', () => {
  it('message.appended creates a thread when absent', () => {
    const m = msg({ sid: 'SMa' });
    const next = mergeEvent(baseState(), { type: 'message.appended', partyNumber: '+15550100001', message: m });
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.partyNumber).toBe('+15550100001');
    expect(next.threads[0]?.messages[0]?.sid).toBe('SMa');
  });

  it('message.appended appends to the existing thread', () => {
    const existing: Thread = { partyNumber: '+15550100001', messages: [msg({ sid: 'SMa' })] };
    const next = mergeEvent(baseState({ threads: [existing] }), {
      type: 'message.appended',
      partyNumber: '+15550100001',
      message: msg({ sid: 'SMb' }),
    });
    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.messages.map((m) => m.sid)).toEqual(['SMa', 'SMb']);
  });

  it('inbound message.appended to a NON-selected party increments unread', () => {
    const next = mergeEvent(baseState({ selected: '+15550100002' }), {
      type: 'message.appended',
      partyNumber: '+15550100001',
      message: msg({ direction: 'inbound' }),
    });
    expect(next.unreadByNumber['+15550100001']).toBe(1);
  });

  it('inbound message.appended to the SELECTED party does not increment unread', () => {
    const next = mergeEvent(baseState({ selected: '+15550100001' }), {
      type: 'message.appended',
      partyNumber: '+15550100001',
      message: msg({ direction: 'inbound' }),
    });
    expect(next.unreadByNumber['+15550100001'] ?? 0).toBe(0);
  });

  it('outbound message.appended never increments unread', () => {
    const next = mergeEvent(baseState({ selected: '+15550100002' }), {
      type: 'message.appended',
      partyNumber: '+15550100001',
      message: msg({ direction: 'outbound' }),
    });
    expect(next.unreadByNumber['+15550100001'] ?? 0).toBe(0);
  });

  it('message.updated patches the message state by sid', () => {
    const existing: Thread = { partyNumber: '+15550100001', messages: [msg({ sid: 'SMa', state: 'queued' })] };
    const next = mergeEvent(baseState({ threads: [existing] }), {
      type: 'message.updated',
      partyNumber: '+15550100001',
      message: msg({ sid: 'SMa', state: 'delivered' }),
    });
    expect(next.threads[0]?.messages[0]?.state).toBe('delivered');
  });

  it('persona.added appends the persona', () => {
    const persona: Persona = { id: 'x', label: 'X', role: 'tenant', number: '+15550100009', adHoc: true };
    const next = mergeEvent(baseState(), { type: 'persona.added', persona });
    expect(next.personas.map((p) => p.id)).toEqual(['x']);
  });

  it('reset clears threads and unread', () => {
    const next = mergeEvent(
      baseState({
        threads: [{ partyNumber: '+15550100001', messages: [msg({})] }],
        unreadByNumber: { '+15550100001': 3 },
      }),
      { type: 'reset' },
    );
    expect(next.threads).toEqual([]);
    expect(next.unreadByNumber).toEqual({});
  });
});

// ---- Hook integration (mocked client + SSE) ---------------------------------

let capturedOnEvent: ((e: EngineEvent) => void) | undefined;

vi.mock('../api/useFakeEvents.js', () => ({
  useFakeEvents: (handlers: { onEvent: (e: EngineEvent) => void }) => {
    capturedOnEvent = handlers.onEvent;
  },
}));

const personas: Persona[] = [
  { id: 'a', label: 'Ana', role: 'tenant', number: '+15550100001', adHoc: false },
];
const threads: Thread[] = [{ partyNumber: '+15550100001', messages: [msg({ sid: 'SMseed' })] }];

vi.mock('../api/client.js', () => ({
  getPersonas: vi.fn(async () => personas),
  getThreads: vi.fn(async () => threads),
  sendAsParty: vi.fn(async () => 'SMx'),
  addAdHoc: vi.fn(async () => personas[0]),
  setDeliveryOutcome: vi.fn(async () => undefined),
  resetAll: vi.fn(async () => undefined),
}));

import { useFakePhones } from './useFakePhones.js';

beforeEach(() => {
  capturedOnEvent = undefined;
});
afterEach(() => vi.clearAllMocks());

describe('useFakePhones', () => {
  it('loads personas + threads on mount', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.personas).toHaveLength(1));
    expect(result.current.personas[0]?.label).toBe('Ana');
    expect(result.current.threads[0]?.messages[0]?.sid).toBe('SMseed');
  });

  it('merges a live message.appended into the right thread', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    act(() =>
      capturedOnEvent?.({
        type: 'message.appended',
        partyNumber: '+15550100001',
        message: msg({ sid: 'SMlive' }),
      }),
    );
    expect(result.current.threads[0]?.messages.map((m) => m.sid)).toEqual(['SMseed', 'SMlive']);
  });

  it('clears unread for a party on select', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    // an inbound to a non-selected party bumps unread
    act(() =>
      capturedOnEvent?.({
        type: 'message.appended',
        partyNumber: '+15550100001',
        message: msg({ sid: 'SMin', direction: 'inbound' }),
      }),
    );
    expect(result.current.unreadByNumber['+15550100001']).toBe(1);
    act(() => result.current.select('+15550100001'));
    expect(result.current.selected).toBe('+15550100001');
    expect(result.current.unreadByNumber['+15550100001'] ?? 0).toBe(0);
  });
});
