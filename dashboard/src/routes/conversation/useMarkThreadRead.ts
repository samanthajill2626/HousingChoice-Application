// useMarkThreadRead - the MULTI-PARTY thread auto-read (relay_group and
// group_text), extracted from the identical inline mount effect the two group
// views used to carry. It calls POST /api/conversations/:id/read once per
// mounted thread.
//
// Returns the same AutoReadHandle the contact page's useMarkContactRead does. A
// mark-UNREAD action must await `suppressAndDrain()` before its POST, or this
// auto-read can re-read the very thread the operator just flagged: unmounting
// the view stops FUTURE reads, not one already in flight and not one firing
// during the await.
//
// DELIBERATELY NARROWER than useMarkContactRead: MOUNT ONLY. No
// visibilitychange trigger and no message.persisted subscription - those belong
// to the contact page's model, and adding them here would change shipped
// behavior on both group views.
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { markConversationRead } from '../../api/index.js';
import { drainWithBound, type AutoReadHandle } from '../contact/useMarkContactRead.js';

export type { AutoReadHandle };

export function useMarkThreadRead(conversationId: string): AutoReadHandle {
  // The mark-unread latch, named by the thread it suppresses (never a bare
  // boolean), plus the read a drain must wait out - keyed the same way, so a
  // drain can never await some other thread's request.
  //
  // THERE IS NO IDENTITY RESET EFFECT HERE, AND THAT IS DELIBERATE.
  // `ConversationDetail`'s header effect calls `setStatus('loading')`
  // synchronously on every `conversationId` change, which renders the spinner
  // branch and UNMOUNTS the group view - so a thread switch already hands this
  // hook a fresh mount with fresh refs. That is a load-bearing property of an
  // UNRELATED component: an optimization that kept the child mounted across a
  // thread switch would, with a boolean latch, silently resurrect a
  // suppressed-forever bug. Keying both refs by `conversationId` is the belt to
  // that brace - the latch can only ever silence the thread it was set for.
  const suppressedFor = useRef<string | null>(null);
  const inFlightPromise = useRef<{ id: string; promise: Promise<unknown> } | null>(null);

  // Viewing the thread marks it read - the inbox unread badge clears once seen.
  // DELIBERATELY UNWIRED from the badge's optimistic layer (the same ruling
  // useMarkContactRead carries, and its regression test): this fires BLIND on
  // mount, with no unread knowledge, so an optimistic decrement here could
  // subtract a row the badge never counted. It reconciles through the cheap
  // count refetch this mark-read's own SSE event triggers. The visible
  // asymmetry is intended - opening a thread from an Inbox ROW decrements
  // instantly (useInbox knows that row's unread), opening it from Today or a
  // deep link does not. Wiring it later is safe (the clear key would be
  // `cv:<conversationId>`, the vocabulary useInbox already mints, so the two
  // would dedupe rather than double-decrement) but it needs the unread count.
  useEffect(() => {
    if (suppressedFor.current === conversationId) return;
    const request: Promise<void> = markConversationRead(conversationId)
      .catch(() => {
        /* best-effort - a failed mark-read must not break the view */
      })
      .finally(() => {
        // Release the drain handle for THIS request only.
        if (inFlightPromise.current?.promise === request) inFlightPromise.current = null;
      });
    inFlightPromise.current = { id: conversationId, promise: request };
    void request;
  }, [conversationId]);

  // Latch the auto-read off for THIS thread, then wait out whatever is already
  // in flight, so the mark-unread POST the caller issues next lands last.
  const suppressAndDrain = useCallback(async (): Promise<void> => {
    suppressedFor.current = conversationId;
    const pending = inFlightPromise.current;
    if (pending === null || pending.id !== conversationId) return;
    await drainWithBound(pending.promise);
  }, [conversationId]);

  // Undo the latch for THIS thread. Belt-and-braces here (this hook is
  // MOUNT-ONLY, so there is no later trigger a stuck latch could silence) but
  // the two auto-read hooks implement ONE contract and a half-implemented handle
  // is exactly how they drift apart.
  const release = useCallback((): void => {
    if (suppressedFor.current === conversationId) suppressedFor.current = null;
  }, [conversationId]);

  // Memoized: this handle flows into consumer effect deps, and a churning
  // identity there POST-loops (the hazard UnreadContext records for
  // noteRowsCleared/rollbackRowsCleared).
  return useMemo<AutoReadHandle>(
    () => ({ suppressAndDrain, release }),
    [suppressAndDrain, release],
  );
}
