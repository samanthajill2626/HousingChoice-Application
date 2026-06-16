// useRelayMembers — owns the relay-group ROSTER for one conversation (M1.7).
//
// Loads the members on mount (GET /members), exposes idempotent add/remove
// mutations, and — critically for the live-update mandate — updates the roster
// IN PLACE when a conversation.updated SSE event for this conversation arrives.
// That event carries the fresh `members[]`, so we prefer it over a refetch
// (ingestRoster); add/remove also patch optimistically from their own response.
//
// Only meaningful for a relay_group thread; the caller gates on the conversation
// type and passes `enabled: false` for 1:1 threads so no /members GET fires
// against a non-relay conversation (which would 404).
import { useCallback, useEffect, useState } from 'react';
import {
  addRelayMember,
  getRelayMembers,
  removeRelayMember,
  ApiError,
  type ConversationParticipant,
  type RelayMemberInput,
} from '../../api';

export interface UseRelayMembers {
  members: ConversationParticipant[];
  loading: boolean;
  /** Initial-load error (mutation errors are thrown to the caller). */
  error: ApiError | undefined;
  /** Add a member (idempotent on phone); resolves once the roster is updated. */
  add: (member: RelayMemberInput) => Promise<void>;
  /** Remove a member by E.164 phone (idempotent). */
  remove: (phone: string) => Promise<void>;
  /**
   * Merge a live roster from a conversation.updated SSE event. Preferred over a
   * refetch — the event already carries the authoritative member list.
   */
  ingestRoster: (members: ConversationParticipant[]) => void;
}

export function useRelayMembers(conversationId: string, enabled: boolean): UseRelayMembers {
  const [members, setMembers] = useState<ConversationParticipant[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  // Initial load (and reload when the conversation id changes / becomes enabled).
  useEffect(() => {
    if (!enabled || conversationId.length === 0) {
      setMembers([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(undefined);

    getRelayMembers(conversationId, controller.signal)
      .then((roster) => {
        if (active) setMembers(roster);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setError(err instanceof ApiError ? err : new ApiError(0, 'unknown_error', String(err)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [conversationId, enabled]);

  const add = useCallback(
    async (member: RelayMemberInput): Promise<void> => {
      const roster = await addRelayMember(conversationId, member);
      setMembers(roster);
    },
    [conversationId],
  );

  const remove = useCallback(
    async (phone: string): Promise<void> => {
      const roster = await removeRelayMember(conversationId, phone);
      setMembers(roster);
    },
    [conversationId],
  );

  // The SSE handler runs outside React's batching; keep it stable so the parent
  // can pass it straight to useEventStream without re-subscribing every render.
  const ingestRoster = useCallback((roster: ConversationParticipant[]) => {
    setMembers(roster);
  }, []);

  return { members, loading, error, add, remove, ingestRoster };
}
