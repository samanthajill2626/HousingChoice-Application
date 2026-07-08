// useFakePhones data-hook tests. The client + SSE hook are mocked so the test
// can (a) assert the initial load wires personas+threads into state and (b) drive
// the pure merge reducer through each EngineEvent type via the captured onEvent.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, GroupSnapshot, Persona, Thread, ThreadMessage } from '../api/types.js';
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
  groups: [],
  groupUnreadByPool: {},
  selectedGroup: null,
  ...over,
});

const grp = (over: Partial<GroupSnapshot> = {}): GroupSnapshot => ({
  poolNumber: '+15550160001',
  members: [
    { number: '+15550170001', label: 'Diana Osei' },
    { number: '+15550170003', label: 'Gloria Mensah' },
  ],
  entries: [],
  lastActivityAt: '2026-06-15T00:00:00.000Z',
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

  it("a member's GROUP send (inbound, to = pool) does NOT increment the 1:1 unread", () => {
    // Group traffic is hidden from the 1:1 pane (isDirectMessage filter), so it
    // must not produce a phantom 1:1 badge — group activity counts via
    // groupUnreadByPool instead (driven by the separate group.updated event).
    const next = mergeEvent(baseState({ selected: '+15550100002' }), {
      type: 'message.appended',
      partyNumber: '+15550100001',
      message: msg({ direction: 'inbound', to: '+15550160001' }),
    });
    expect(next.unreadByNumber['+15550100001'] ?? 0).toBe(0);
    // ...but the message still lands in the raw thread (mirrors /control/threads).
    expect(next.threads[0]!.messages).toHaveLength(1);
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

// ---- group.updated merge (pure) ----------------------------------------------
// The event carries the WHOLE recomputed GroupSnapshot; the merge is
// replace-or-append by poolNumber (mirroring how threads key by partyNumber).

describe('mergeEvent group.updated (pure)', () => {
  it('appends a group it has not seen (and counts it as unread activity)', () => {
    const g = grp();
    const next = mergeEvent(baseState(), { type: 'group.updated', group: g });
    expect(next.groups).toEqual([g]);
    expect(next.groupUnreadByPool[g.poolNumber]).toBe(1);
  });

  it('replaces the existing group by poolNumber (no duplicate)', () => {
    const g0 = grp({ lastActivityAt: '2026-06-15T00:00:00.000Z' });
    const g1 = grp({ lastActivityAt: '2026-06-15T00:01:00.000Z' });
    const next = mergeEvent(baseState({ groups: [g0] }), { type: 'group.updated', group: g1 });
    expect(next.groups).toHaveLength(1);
    expect(next.groups[0]?.lastActivityAt).toBe('2026-06-15T00:01:00.000Z');
  });

  it('bumps unread when transcript activity advances on a NON-selected group', () => {
    const g0 = grp({ lastActivityAt: '2026-06-15T00:00:00.000Z' });
    const g1 = grp({ lastActivityAt: '2026-06-15T00:01:00.000Z' });
    const next = mergeEvent(baseState({ groups: [g0], selectedGroup: null }), {
      type: 'group.updated',
      group: g1,
    });
    expect(next.groupUnreadByPool[g1.poolNumber]).toBe(1);
  });

  it('does NOT bump unread for the SELECTED group', () => {
    const g0 = grp({ lastActivityAt: '2026-06-15T00:00:00.000Z' });
    const g1 = grp({ lastActivityAt: '2026-06-15T00:01:00.000Z' });
    const next = mergeEvent(
      baseState({ groups: [g0], selectedGroup: g0.poolNumber }),
      { type: 'group.updated', group: g1 },
    );
    expect(next.groupUnreadByPool[g1.poolNumber] ?? 0).toBe(0);
  });

  it('does NOT bump unread when lastActivityAt is unchanged (a delivery-slot status tick)', () => {
    const g0 = grp();
    const g1 = grp(); // same lastActivityAt — e.g. a recipient chip advanced
    const next = mergeEvent(baseState({ groups: [g0] }), { type: 'group.updated', group: g1 });
    expect(next.groupUnreadByPool[g1.poolNumber] ?? 0).toBe(0);
  });

  it('reset clears groups and group unread', () => {
    const next = mergeEvent(
      baseState({ groups: [grp()], groupUnreadByPool: { '+15550160001': 2 } }),
      { type: 'reset' },
    );
    expect(next.groups).toEqual([]);
    expect(next.groupUnreadByPool).toEqual({});
  });
});

// ---- Hook integration (mocked client + SSE) ---------------------------------

let capturedOnEvent: ((e: EngineEvent) => void) | undefined;
let capturedOnOpen: (() => void) | undefined;

vi.mock('../api/useFakeEvents.js', () => ({
  useFakeEvents: (handlers: { onEvent: (e: EngineEvent) => void; onOpen?: () => void }) => {
    capturedOnEvent = handlers.onEvent;
    capturedOnOpen = handlers.onOpen;
  },
}));

const personas: Persona[] = [
  { id: 'a', label: 'Ana', role: 'tenant', number: '+15550100001', adHoc: false },
];
const threads: Thread[] = [{ partyNumber: '+15550100001', messages: [msg({ sid: 'SMseed' })] }];
const seedGroups: GroupSnapshot[] = [
  {
    poolNumber: '+15550160001',
    members: [{ number: '+15550100001', label: 'Ana' }],
    entries: [],
    lastActivityAt: '2026-06-15T00:00:00.000Z',
  },
];

vi.mock('../api/client.js', () => ({
  getPersonas: vi.fn(async () => personas),
  getThreads: vi.fn(async () => threads),
  getGroups: vi.fn(async () => seedGroups),
  sendAsParty: vi.fn(async () => 'SMx'),
  addAdHoc: vi.fn(async () => personas[0]),
  setDeliveryOutcome: vi.fn(async () => undefined),
  resetAll: vi.fn(async () => undefined),
}));

import { useFakePhones } from './useFakePhones.js';

import * as client from '../api/client.js';

beforeEach(() => {
  capturedOnEvent = undefined;
  capturedOnOpen = undefined;
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

  it('re-fetches personas + threads + groups on every (re)connect via onOpen (full reconcile)', async () => {
    const getPersonasMock = vi.mocked(client.getPersonas);
    const getThreadsMock = vi.mocked(client.getThreads);
    const getGroupsMock = vi.mocked(client.getGroups);
    renderHook(() => useFakePhones());
    // Initial mount load.
    await waitFor(() => expect(getPersonasMock).toHaveBeenCalledTimes(1));
    expect(getThreadsMock).toHaveBeenCalledTimes(1);
    expect(getGroupsMock).toHaveBeenCalledTimes(1);
    expect(capturedOnOpen).toBeDefined();
    // Simulate an SSE (re)connect: the hook must re-fetch to reconcile any gap.
    await act(async () => {
      capturedOnOpen?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(getPersonasMock).toHaveBeenCalledTimes(2));
    expect(getThreadsMock).toHaveBeenCalledTimes(2);
    expect(getGroupsMock).toHaveBeenCalledTimes(2);
  });

  it('loads groups on mount', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.groups[0]?.poolNumber).toBe('+15550160001');
  });

  it('merges a live group.updated (replace-or-append by poolNumber)', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    act(() =>
      capturedOnEvent?.({
        type: 'group.updated',
        group: { ...seedGroups[0]!, lastActivityAt: '2026-06-15T00:05:00.000Z' },
      }),
    );
    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0]?.lastActivityAt).toBe('2026-06-15T00:05:00.000Z');
  });

  it('selectGroup selects the group, clears its unread, and deselects the persona', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    act(() => result.current.select('+15550100001'));
    // Activity on the (not-selected) group bumps its unread.
    act(() =>
      capturedOnEvent?.({
        type: 'group.updated',
        group: { ...seedGroups[0]!, lastActivityAt: '2026-06-15T00:06:00.000Z' },
      }),
    );
    expect(result.current.groupUnreadByPool['+15550160001']).toBe(1);

    act(() => result.current.selectGroup('+15550160001'));
    expect(result.current.selectedGroup).toBe('+15550160001');
    expect(result.current.selected).toBeNull();
    expect(result.current.groupUnreadByPool['+15550160001'] ?? 0).toBe(0);
  });

  it('select (persona) deselects the group', async () => {
    const { result } = renderHook(() => useFakePhones());
    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    act(() => result.current.selectGroup('+15550160001'));
    expect(result.current.selectedGroup).toBe('+15550160001');
    act(() => result.current.select('+15550100001'));
    expect(result.current.selected).toBe('+15550100001');
    expect(result.current.selectedGroup).toBeNull();
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
