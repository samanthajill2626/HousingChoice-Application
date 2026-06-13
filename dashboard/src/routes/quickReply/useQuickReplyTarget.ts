// useQuickReplyTarget — resolve which conversation a quick reply should be sent
// to, from the route's `:callId` param and/or a `?conversationId=` query param.
//
// THE M1.9 SEAM (read this before touching the resolution logic):
// ----------------------------------------------------------------
// Calls do NOT exist as entities yet. There is no call API, no
// callId→conversation mapping, and no missed-call push trigger — all of that is
// milestone M1.9. So this hook resolves a target in exactly two ways today:
//
//   • conversationId present (?conversationId=<id>) → that's the target. This is
//     the WORKING M1.4 path: send a canned reply to a KNOWN conversation. We
//     fetch it (getConversation) so the UI can show who it's going to and link
//     to the full thread.
//
//   • only a callId (the deep-link the SW produces from a missed-call push) →
//     there is no way to resolve it to a conversation yet, so we return an
//     HONEST interim state ('no_call_api'). We do NOT fabricate a conversation.
//
// >>> TODO(M1.9): when the call entity + API land, resolve callId→conversation
// >>> HERE: fetch the call (GET /api/calls/<callId> or equivalent), read its
// >>> conversationId, and fall through to the same getConversation path below.
// >>> The 'no_call_api' branch is the ONLY thing that changes — everything
// >>> downstream (the sheet, the send, the auto-send) already works off a
// >>> resolved conversationId, so M1.9 is a drop-in at this seam.
import { useApi, getConversation, ApiError, type Conversation } from '../../api/index.js';

/** What kind of target we resolved to. */
export type TargetKind =
  | 'loading' // still fetching the conversation
  | 'conversation' // resolved → we have a Conversation to reply into
  | 'no_call_api' // only a callId, no call API yet (M1.9 interim state)
  | 'error'; // the conversation fetch failed

export interface QuickReplyTarget {
  kind: TargetKind;
  /** The resolved conversation id, when kind === 'conversation'. */
  conversationId: string | undefined;
  /** The fetched conversation, when kind === 'conversation'. */
  conversation: Conversation | undefined;
  /** The error, when kind === 'error'. */
  error: ApiError | undefined;
  /** Re-run the underlying fetch (retry). */
  refetch: () => void;
}

/**
 * @param callId          the `:callId` route param (may be undefined).
 * @param conversationId  the `?conversationId=` query param (the M1.4 path).
 */
export function useQuickReplyTarget(
  callId: string | undefined,
  conversationId: string | null,
): QuickReplyTarget {
  // We only fetch when we actually have a conversationId. When we have only a
  // callId, there is no call API yet (M1.9) — so the fetcher short-circuits to a
  // sentinel and the hook reports the honest 'no_call_api' interim state.
  const { data, error, loading, refetch } = useApi<Conversation | null>(
    async (signal) => {
      if (conversationId !== null && conversationId !== '') {
        return getConversation(conversationId, signal);
      }
      // No conversationId → nothing to fetch. (TODO(M1.9): resolve callId here.)
      return null;
    },
    [conversationId],
  );

  if (conversationId === null || conversationId === '') {
    // No conversation to work off. If there's a callId we're in the honest
    // interim state; if there's neither, it's still the same "can't resolve"
    // surface (the route always has a :callId, so this is the missed-call case).
    void callId;
    return {
      kind: 'no_call_api',
      conversationId: undefined,
      conversation: undefined,
      error: undefined,
      refetch,
    };
  }

  if (loading) {
    return { kind: 'loading', conversationId, conversation: undefined, error: undefined, refetch };
  }
  if (error !== undefined) {
    return { kind: 'error', conversationId, conversation: undefined, error, refetch };
  }
  return {
    kind: 'conversation',
    conversationId,
    conversation: data ?? undefined,
    error: undefined,
    refetch,
  };
}
