// useFakePhones — the fake-phones UI data hook. Loads personas+threads on mount,
// subscribes to live engine events over SSE, and merges them into local state
// with a PURE reducer (`mergeEvent`) so the merge is independently unit-tested
// and race-reasonable. Also tracks per-party unread counts. Action passthroughs
// wrap the control client; callers never touch fetch/EventSource directly.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addAdHoc as apiAddAdHoc,
  getPersonas,
  getThreads,
  resetAll as apiResetAll,
  sendAsParty as apiSendAsParty,
  setDeliveryOutcome as apiSetDeliveryOutcome,
} from '../api/client.js';
import { useFakeEvents } from '../api/useFakeEvents.js';
import type {
  AddAdHocInput,
  DeliveryProfile,
  EngineEvent,
  Persona,
  SendAsPartyInput,
  Thread,
} from '../api/types.js';

/** The reducible state the live merge operates on. */
export interface FakeState {
  personas: Persona[];
  threads: Thread[];
  /** Per-party-number unread inbound count; cleared when that party is selected. */
  unreadByNumber: Record<string, number>;
  /** The currently-selected party number, or null for the empty state. */
  selected: string | null;
}

export const initialState: FakeState = {
  personas: [],
  threads: [],
  unreadByNumber: {},
  selected: null,
};

/**
 * Apply a single live EngineEvent to the state, immutably. Pure — no I/O, no
 * `selected` mutation beyond reading it for the unread rule:
 *   - message.appended: append to the matching thread (create it if absent); an
 *     INBOUND message to a party that is NOT currently selected bumps its unread.
 *   - message.updated: patch the matching message's fields (state, timestamps)
 *     by sid within its thread; no-op if the thread/message is unknown.
 *   - persona.added: append the persona.
 *   - reset: clear threads + unread (personas + selection are left as-is; the
 *     hook re-derives selection validity on its own).
 */
export function mergeEvent(state: FakeState, event: EngineEvent): FakeState {
  switch (event.type) {
    case 'message.appended': {
      const { partyNumber, message } = event;
      const idx = state.threads.findIndex((t) => t.partyNumber === partyNumber);
      let threads: Thread[];
      if (idx === -1) {
        threads = [...state.threads, { partyNumber, messages: [message] }];
      } else {
        const existing = state.threads[idx]!;
        const replaced: Thread = { ...existing, messages: [...existing.messages, message] };
        threads = state.threads.map((t, i) => (i === idx ? replaced : t));
      }
      let unreadByNumber = state.unreadByNumber;
      if (message.direction === 'inbound' && partyNumber !== state.selected) {
        unreadByNumber = {
          ...state.unreadByNumber,
          [partyNumber]: (state.unreadByNumber[partyNumber] ?? 0) + 1,
        };
      }
      return { ...state, threads, unreadByNumber };
    }
    case 'message.updated': {
      const { partyNumber, message } = event;
      const idx = state.threads.findIndex((t) => t.partyNumber === partyNumber);
      if (idx === -1) return state;
      const existing = state.threads[idx]!;
      const messages = existing.messages.map((m) => (m.sid === message.sid ? { ...m, ...message } : m));
      const replaced: Thread = { ...existing, messages };
      return { ...state, threads: state.threads.map((t, i) => (i === idx ? replaced : t)) };
    }
    case 'persona.added': {
      if (state.personas.some((p) => p.id === event.persona.id)) return state;
      return { ...state, personas: [...state.personas, event.persona] };
    }
    case 'reset': {
      return { ...state, threads: [], unreadByNumber: {} };
    }
    default:
      return state;
  }
}

export interface UseFakePhones {
  personas: Persona[];
  threads: Thread[];
  unreadByNumber: Record<string, number>;
  selected: string | null;
  select: (partyNumber: string) => void;
  refresh: () => Promise<void>;
  // Action passthroughs (control client).
  sendAsParty: (input: SendAsPartyInput) => Promise<string>;
  addAdHoc: (input: AddAdHocInput) => Promise<Persona>;
  setDeliveryOutcome: (partyNumber: string, profile: DeliveryProfile) => Promise<void>;
  resetAll: () => Promise<void>;
}

export function useFakePhones(): UseFakePhones {
  const [state, setState] = useState<FakeState>(initialState);

  const refresh = useCallback(async (): Promise<void> => {
    const [personas, threads] = await Promise.all([getPersonas(), getThreads()]);
    setState((prev) => ({ ...prev, personas, threads }));
  }, []);

  // Initial load on mount. Guard against setting state after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const [personas, threads] = await Promise.all([getPersonas(), getThreads()]);
      if (mountedRef.current) setState((prev) => ({ ...prev, personas, threads }));
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Live merge. The handler is recreated each render but the SSE hook keeps it
  // in a ref, so this does not churn the EventSource.
  const onEvent = useCallback((event: EngineEvent) => {
    setState((prev) => mergeEvent(prev, event));
  }, []);
  useFakeEvents({ onEvent });

  const select = useCallback((partyNumber: string): void => {
    setState((prev) => {
      const { [partyNumber]: _cleared, ...rest } = prev.unreadByNumber;
      return { ...prev, selected: partyNumber, unreadByNumber: rest };
    });
  }, []);

  return {
    personas: state.personas,
    threads: state.threads,
    unreadByNumber: state.unreadByNumber,
    selected: state.selected,
    select,
    refresh,
    sendAsParty: apiSendAsParty,
    addAdHoc: apiAddAdHoc,
    setDeliveryOutcome: apiSetDeliveryOutcome,
    resetAll: apiResetAll,
  };
}
