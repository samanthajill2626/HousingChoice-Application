// useFakePhones — the fake-phones UI data hook. Loads personas+threads on mount,
// subscribes to live engine events over SSE, and merges them into local state
// with a PURE reducer (`mergeEvent`) so the merge is independently unit-tested
// and race-reasonable. Also tracks per-party unread counts. Action passthroughs
// wrap the control client; callers never touch fetch/EventSource directly.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addAdHoc as apiAddAdHoc,
  getGroups,
  getPersonas,
  getThreads,
  resetAll as apiResetAll,
  sendAsParty as apiSendAsParty,
  setDeliveryOutcome as apiSetDeliveryOutcome,
} from '../api/client.js';
import { useFakeEvents } from '../api/useFakeEvents.js';
import { isDirectMessage } from '../api/types.js';
import type {
  AddAdHocInput,
  DeliveryProfile,
  EngineEvent,
  GroupSnapshot,
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
  /** Traffic-inferred relay groups (additive slice; keyed by poolNumber). */
  groups: GroupSnapshot[];
  /** Per-pool unread TRANSCRIPT-activity count; cleared when that group is
   *  selected. Mirrors `unreadByNumber` — bumped per group.updated whose
   *  lastActivityAt advanced (delivery-slot status ticks don't count). */
  groupUnreadByPool: Record<string, number>;
  /** The currently-selected group's pool number, or null. Mutually exclusive
   *  with `selected` — pool numbers and persona numbers are separate keyspaces,
   *  so selecting one side always nulls the other. */
  selectedGroup: string | null;
}

export const initialState: FakeState = {
  personas: [],
  threads: [],
  unreadByNumber: {},
  selected: null,
  groups: [],
  groupUnreadByPool: {},
  selectedGroup: null,
};

/**
 * Apply a single live EngineEvent to the state, immutably. Pure — no I/O, no
 * `selected` mutation beyond reading it for the unread rule:
 *   - message.appended: append to the matching thread (create it if absent); an
 *     INBOUND message to a party that is NOT currently selected bumps its unread.
 *   - message.updated: patch the matching message's fields (state, timestamps)
 *     by sid within its thread; no-op if the thread/message is unknown.
 *   - persona.added: append the persona.
 *   - group.updated: the event carries the WHOLE recomputed GroupSnapshot —
 *     replace-or-append by poolNumber. A snapshot whose lastActivityAt advanced
 *     (new transcript entry/leg — NOT a delivery-slot tick) on a group that is
 *     NOT currently selected bumps that group's unread.
 *   - reset: clear threads + groups + both unread maps (personas + selection
 *     are left as-is; the hook re-derives selection validity on its own).
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
      // Only DIRECT (business app↔party) inbounds count toward the 1:1 badge —
      // group traffic is hidden from the 1:1 pane (App filters on the same
      // predicate) and counts via groupUnreadByPool instead. Without this, a
      // member's own group send (direction inbound, to=pool) would show a
      // phantom unread on a pane it doesn't even render in.
      if (
        message.direction === 'inbound' &&
        isDirectMessage(message) &&
        partyNumber !== state.selected
      ) {
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
    case 'group.updated': {
      const { group } = event;
      const idx = state.groups.findIndex((g) => g.poolNumber === group.poolNumber);
      const prev = idx === -1 ? undefined : state.groups[idx];
      const groups =
        idx === -1 ? [...state.groups, group] : state.groups.map((g, i) => (i === idx ? group : g));
      // Same-format ISO strings compare correctly as strings. Equal timestamps
      // mean a delivery-slot status tick (no new transcript activity) — no bump.
      const activityAdvanced = prev === undefined || group.lastActivityAt > prev.lastActivityAt;
      let groupUnreadByPool = state.groupUnreadByPool;
      if (activityAdvanced && group.poolNumber !== state.selectedGroup) {
        groupUnreadByPool = {
          ...state.groupUnreadByPool,
          [group.poolNumber]: (state.groupUnreadByPool[group.poolNumber] ?? 0) + 1,
        };
      }
      return { ...state, groups, groupUnreadByPool };
    }
    case 'reset': {
      return { ...state, threads: [], unreadByNumber: {}, groups: [], groupUnreadByPool: {} };
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
  groups: GroupSnapshot[];
  groupUnreadByPool: Record<string, number>;
  selectedGroup: string | null;
  select: (partyNumber: string) => void;
  selectGroup: (poolNumber: string) => void;
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
    const [personas, threads, groups] = await Promise.all([getPersonas(), getThreads(), getGroups()]);
    setState((prev) => ({ ...prev, personas, threads, groups }));
  }, []);

  // Initial load on mount. Guard against setting state after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      const [personas, threads, groups] = await Promise.all([getPersonas(), getThreads(), getGroups()]);
      if (mountedRef.current) setState((prev) => ({ ...prev, personas, threads, groups }));
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
  // On every (re)connect, re-fetch personas+threads so events emitted during an
  // SSE gap (no Last-Event-ID/replay) can't silently desync the UI — `refresh`
  // does an idempotent full reconcile (replace), so the initial-mount overlap is
  // harmless.
  useFakeEvents({
    onEvent,
    onOpen: () => {
      void refresh();
    },
  });

  // Persona and group selection are mutually exclusive (one right-hand panel):
  // selecting either side clears the other and marks its own row read.
  const select = useCallback((partyNumber: string): void => {
    setState((prev) => {
      const { [partyNumber]: _cleared, ...rest } = prev.unreadByNumber;
      return { ...prev, selected: partyNumber, unreadByNumber: rest, selectedGroup: null };
    });
  }, []);

  const selectGroup = useCallback((poolNumber: string): void => {
    setState((prev) => {
      const { [poolNumber]: _cleared, ...rest } = prev.groupUnreadByPool;
      return { ...prev, selectedGroup: poolNumber, groupUnreadByPool: rest, selected: null };
    });
  }, []);

  return {
    personas: state.personas,
    threads: state.threads,
    unreadByNumber: state.unreadByNumber,
    selected: state.selected,
    groups: state.groups,
    groupUnreadByPool: state.groupUnreadByPool,
    selectedGroup: state.selectedGroup,
    select,
    selectGroup,
    refresh,
    sendAsParty: apiSendAsParty,
    addAdHoc: apiAddAdHoc,
    setDeliveryOutcome: apiSetDeliveryOutcome,
    resetAll: apiResetAll,
  };
}
