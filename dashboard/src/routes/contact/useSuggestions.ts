// useSuggestions - a hand-rolled hook (like useContact) that owns a contact's
// pending AI suggestions. Fetches on mount, exposes accept/dismiss that round-trip
// to the review API and update the in-memory list, and refetches live when a
// `suggestion.updated` SSE event names this contact (extraction ran, or another
// tab accepted/dismissed). Accept RETURNS the server response so the caller
// (ContactDetail) can apply the updated contact via setContact - matching the
// update-in-place convention. On error accept/dismiss REJECT so the caller can
// surface an inline chip error (e.g. a 409 phone_in_use).
import { useCallback, useEffect, useState } from 'react';
import {
  acceptSuggestion,
  dismissSuggestion,
  getSuggestions,
  useEventStream,
  type Contact,
  type SuggestionItem,
} from '../../api/index.js';

export interface SuggestionsState {
  suggestions: SuggestionItem[];
  refetch: () => void;
  /** Accept a target; resolves with the updated contact + remaining suggestions
   *  (applied to this hook's state too). Rejects on a server error. */
  accept: (target: string) => Promise<{ contact: Contact; suggestions: SuggestionItem[] }>;
  /** Dismiss a target; the remaining suggestions are applied to state. */
  dismiss: (target: string) => Promise<void>;
}

// Each committed state records which contactId it describes (`forId`). When the
// id prop changes we DERIVE an empty list during render until the new fetch
// commits, instead of a synchronous setState in the effect (the cascading-render
// case). Same convention as useContact.
interface Committed {
  suggestions: SuggestionItem[];
  forId: string;
}

export function useSuggestions(contactId: string): SuggestionsState {
  const [state, setState] = useState<Committed>({ suggestions: [], forId: contactId });

  const load = useCallback(
    (signal?: AbortSignal) => {
      void getSuggestions(contactId, signal)
        .then((suggestions) => {
          if (signal?.aborted) return;
          setState({ suggestions, forId: contactId });
        })
        .catch(() => {
          /* best-effort: a fetch failure just leaves the current list */
        });
    },
    [contactId],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refetch = useCallback(() => load(), [load]);

  // Live refetch when THIS contact's suggestions change server-side.
  useEventStream({
    onSuggestionUpdated: (event) => {
      if (event.contactId === contactId) load();
    },
  });

  const accept = useCallback(
    async (target: string) => {
      const suggestion = state.forId === contactId
        ? state.suggestions.find((item) => item.target === target)
        : undefined;
      if (suggestion === undefined) throw new Error('Suggestion is no longer pending');
      const res = await acceptSuggestion(contactId, target, {
        revision: suggestion.revision,
        createdAt: suggestion.createdAt,
        runId: suggestion.runId,
      });
      setState({ suggestions: res.suggestions, forId: contactId });
      return res;
    },
    [contactId, state],
  );

  const dismiss = useCallback(
    async (target: string) => {
      const suggestion = state.forId === contactId
        ? state.suggestions.find((item) => item.target === target)
        : undefined;
      if (suggestion === undefined) throw new Error('Suggestion is no longer pending');
      const remaining = await dismissSuggestion(contactId, target, {
        revision: suggestion.revision,
        createdAt: suggestion.createdAt,
        runId: suggestion.runId,
      });
      setState({ suggestions: remaining, forId: contactId });
    },
    [contactId, state],
  );

  // The committed state is for the previous id -> the new fetch is in flight.
  const suggestions = state.forId === contactId ? state.suggestions : [];
  return { suggestions, refetch, accept, dismiss };
}
