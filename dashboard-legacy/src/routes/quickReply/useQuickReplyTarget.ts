// useQuickReplyTarget — resolve which conversation a quick reply should be sent
// to, from the route's `:callId` param and/or a `?conversationId=` query param.
//
// THE M1.9 SEAM (now wired):
// --------------------------
// Two ways to resolve a target:
//
//   • conversationId present (?conversationId=<id>) → that's the target. This is
//     the WORKING M1.4 path: send a canned reply to a KNOWN conversation. We
//     fetch it (getConversation) so the UI can show who it's going to and link
//     to the full thread.
//
//   • only a callId (the deep-link the SW produces from a missed-call push) →
//     resolve it with getCall(callId): the response carries the call entry's
//     conversation directly. We read that conversation and fall through to the
//     same 'conversation' state below — so everything downstream (the sheet, the
//     send, the auto-send) works off a resolved conversationId unchanged.
//
// HONEST fallbacks (never fabricate a conversation):
//   - getCall 404 (unknown CallSid) → 'error'.
//   - call found but its conversation is gone (server returns conversation:null)
//     → 'missing_conversation' (a distinct honest state — the call is real but
//     there is nothing to reply into).
//   - neither callId nor conversationId → 'no_call_api' (can't resolve at all).
import {
  useApi,
  getCall,
  getConversation,
  ApiError,
  type Conversation,
} from '../../api/index.js';

/** What kind of target we resolved to. */
export type TargetKind =
  | 'loading' // still fetching the call/conversation
  | 'conversation' // resolved → we have a Conversation to reply into
  | 'missing_conversation' // the call resolved but its conversation is gone (M1.9)
  | 'no_call_api' // neither a callId nor a conversationId to resolve from
  | 'error'; // the call/conversation fetch failed

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

/** The fetcher's resolution: the conversation to reply into (or null when the
 *  call resolved but its conversation no longer exists). `null` distinguishes
 *  "nothing to fetch" (no inputs) from "resolved to no conversation". */
type Resolution =
  | { kind: 'none' } // no inputs to resolve from
  | { kind: 'conversation'; conversation: Conversation }
  | { kind: 'missing_conversation' }; // call resolved, conversation gone

/**
 * @param callId          the `:callId` route param (may be undefined).
 * @param conversationId  the `?conversationId=` query param (the M1.4 path).
 */
export function useQuickReplyTarget(
  callId: string | undefined,
  conversationId: string | null,
): QuickReplyTarget {
  // Resolve in priority order: an explicit conversationId wins (M1.4 path); else
  // resolve the callId via getCall (M1.9). Re-runs when either input changes.
  const { data, error, loading, refetch } = useApi<Resolution>(
    async (signal) => {
      if (conversationId !== null && conversationId !== '') {
        const conversation = await getConversation(conversationId, signal);
        return { kind: 'conversation', conversation };
      }
      if (callId !== undefined && callId !== '') {
        // The call response carries the conversation directly — no second fetch.
        const { conversation } = await getCall(callId, signal);
        if (conversation === null) return { kind: 'missing_conversation' };
        return { kind: 'conversation', conversation };
      }
      // Nothing to resolve from.
      return { kind: 'none' };
    },
    [conversationId, callId],
  );

  if (loading) {
    return {
      kind: 'loading',
      conversationId: conversationId ?? undefined,
      conversation: undefined,
      error: undefined,
      refetch,
    };
  }
  if (error !== undefined) {
    return {
      kind: 'error',
      conversationId: conversationId ?? undefined,
      conversation: undefined,
      error,
      refetch,
    };
  }

  if (data === undefined || data.kind === 'none') {
    // No callId and no conversationId — can't resolve a target at all.
    return {
      kind: 'no_call_api',
      conversationId: undefined,
      conversation: undefined,
      error: undefined,
      refetch,
    };
  }

  if (data.kind === 'missing_conversation') {
    // The call is real but its conversation is gone — honest dead-end.
    return {
      kind: 'missing_conversation',
      conversationId: undefined,
      conversation: undefined,
      error: undefined,
      refetch,
    };
  }

  return {
    kind: 'conversation',
    conversationId: data.conversation.conversationId,
    conversation: data.conversation,
    error: undefined,
    refetch,
  };
}
