// OWNED BY FEATURE AGENT 4 (M1.4). Route: '/quick-reply/:callId' (authenticated).
//
// The missed-call quick-reply DEEP-LINK target (Change Order 2 / doc §7.1 "Call
// triage at volume"). This is the iOS decline-with-canned-text UX: tapping a
// missed-call push deep-links the founder here onto a canned-reply bottom Sheet
// — two taps total (open push → tap a reply). On Android the SW also routes
// here (a notification action tap appends `#action=<id>` to the URL and the SW
// postMessages the action to a focused client); this view then auto-sends the
// matching canned reply ONCE. See PHASE1_CHANGE_ORDER_2.md and FRONTEND_FOUNDATION.md.
//
// SEQUENCING (M1.4 vs M1.9): calls don't exist as entities yet — the call
// entity, the callId→conversation resolution, the missed-call push triggers, and
// the auto-text are all M1.9. So this builds the REUSABLE sheet + the canned-
// reply SEND working off a KNOWN conversation, with a crisp M1.9 seam:
//   • ?conversationId=<id>  → the WORKING M1.4 path (reply to that conversation).
//   • only :callId          → honest interim state ("Call details aren't
//                             available yet"); M1.9 resolves it (see
//                             useQuickReplyTarget's TODO(M1.9) seam).
//
// Built on the shared foundation only (src/api, src/ui, src/push are READ-ONLY).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError,
  getSettings,
  sendMessage,
  useApi,
  type OrgSettings,
} from '../api/index.js';
import { Button, EmptyState, PhoneIcon, Sheet, Spinner, useToast } from '../ui/index.js';
import { buildOptions, optionForAction, type QuickReplyOption } from './quickReply/actions.js';
import { useNotificationAction } from './quickReply/useNotificationAction.js';
import { useQuickReplyTarget } from './quickReply/useQuickReplyTarget.js';
import { QuickReplySheetBody } from './quickReply/QuickReplySheetBody.js';
import { SentConfirmation } from './quickReply/SentConfirmation.js';

/** A pending/just-sent reply: a canned option, or a free-typed custom reply. */
type Sendable = QuickReplyOption | { id: 'custom'; body: string };

/** The send lifecycle within this view. */
type SendState =
  | { phase: 'idle' }
  | { phase: 'sending'; option: Sendable }
  | { phase: 'sent'; body: string };

export default function QuickReply(): React.JSX.Element {
  const { callId } = useParams<{ callId: string }>();
  const [searchParams] = useSearchParams();
  const conversationId = searchParams.get('conversationId');
  const navigate = useNavigate();
  const toast = useToast();

  // The action id (if any) that brought us here — Android action tap via the SW.
  // Keyed by callId (M4) so navigating to a second missed-call deep-link picks
  // up that call's action instead of the first's stale latch.
  const action = useNotificationAction(callId);

  // Resolve the target conversation (the M1.9 seam lives in this hook).
  const target = useQuickReplyTarget(callId, conversationId);

  // Canned templates come from org settings.
  const settingsQuery = useApi<OrgSettings>((s) => getSettings(s), []);

  const options = useMemo<QuickReplyOption[]>(
    () => (settingsQuery.data ? buildOptions(settingsQuery.data) : []),
    [settingsQuery.data],
  );

  const [send, setSend] = useState<SendState>({ phase: 'idle' });

  // Guard: the auto-send (Android action path) must fire at most once PER callId,
  // even across re-renders / the async send window. A ref latch — never state —
  // so React re-renders can't replay it.
  //
  // M4: keyed by callId. Navigating between two missed-call deep-links within
  // one client keeps this component mounted (only :callId changes), so a
  // per-mount latch would carry a stale "sent" state into the second call and
  // swallow its auto-send. Reset the latch (and any stale sent confirmation)
  // when callId changes — preserving "send exactly once per callId".
  const autoSentRef = useRef(false);
  const latchCallIdRef = useRef<string | undefined>(callId);
  useEffect(() => {
    if (latchCallIdRef.current !== callId) {
      latchCallIdRef.current = callId;
      autoSentRef.current = false;
      setSend({ phase: 'idle' });
    }
  }, [callId]);

  const doSend = useCallback(
    async (option: Sendable): Promise<void> => {
      const cid = target.conversationId;
      if (cid === undefined) return; // no resolved conversation — nothing to send into
      const body = option.body.trim();
      if (body.length === 0) return;
      setSend({ phase: 'sending', option });
      try {
        // The send goes out FROM THE BUSINESS NUMBER automatically (server-side).
        await sendMessage(cid, { body });
        setSend({ phase: 'sent', body });
      } catch (err) {
        const message =
          err instanceof ApiError ? `Couldn't send: ${err.message}` : "Couldn't send the reply.";
        toast.error(message);
        setSend({ phase: 'idle' });
      }
    },
    [target.conversationId, toast],
  );

  // Auto-send for the Android notification-action path: when an action id is
  // present and resolves to a known option AND we have a conversation + settings,
  // send it exactly once. The ref latch is set BEFORE the async call so a render
  // mid-flight can never double-send.
  useEffect(() => {
    if (autoSentRef.current) return;
    if (action === null) return;
    if (target.kind !== 'conversation' || target.conversationId === undefined) return;
    if (settingsQuery.loading || options.length === 0) return;
    const matched = optionForAction(options, action);
    if (matched === undefined) return; // unknown action id — fall back to a manual tap
    autoSentRef.current = true;
    void doSend(matched);
  }, [action, target.kind, target.conversationId, settingsQuery.loading, options, doSend]);

  const close = useCallback(() => {
    // Closing the sheet leaves the deep-link view — go to the inbox.
    void navigate('/', { replace: true });
  }, [navigate]);

  const sheetTitle = send.phase === 'sent' ? 'Reply sent' : 'Quick reply';

  // Always a Sheet (the "two taps total" bottom-sheet feel on mobile).
  return (
    <Sheet open onClose={close} title={sheetTitle}>
      {renderBody()}
    </Sheet>
  );

  function renderBody(): React.JSX.Element {
    // Sent confirmation takes precedence regardless of how the send started
    // (manual tap, custom reply, or the Android auto-send).
    if (send.phase === 'sent') {
      return (
        <SentConfirmation
          body={send.body}
          conversationId={target.conversationId}
          onClose={close}
        />
      );
    }

    // Honest interim state: only a callId, no call API yet (M1.9).
    if (target.kind === 'no_call_api') {
      return (
        <EmptyState
          icon={<PhoneIcon size={28} />}
          title="Call details aren't available yet"
          description={
            <>
              This missed-call reply view connects to the call once call tracking
              ships. For now, open the conversation from the inbox to reply.
              (Reference: call {callId ?? 'unknown'}.)
            </>
          }
          action={
            <Button variant="secondary" onClick={close}>
              Back to inbox
            </Button>
          }
        />
      );
    }

    // Conversation fetch error.
    if (target.kind === 'error') {
      return (
        <EmptyState
          title="Couldn't load the conversation"
          description={target.error?.message ?? 'Please try again.'}
          action={
            <Button variant="secondary" onClick={target.refetch}>
              Retry
            </Button>
          }
        />
      );
    }

    // Loading the conversation and/or settings.
    if (target.kind === 'loading' || settingsQuery.loading) {
      return <Spinner center label="Loading replies…" />;
    }

    // Settings failed to load — without templates there's nothing canned to show.
    if (settingsQuery.error !== undefined && settingsQuery.data === undefined) {
      return (
        <EmptyState
          title="Couldn't load quick replies"
          description={settingsQuery.error.message}
          action={
            <Button variant="secondary" onClick={settingsQuery.refetch}>
              Retry
            </Button>
          }
        />
      );
    }

    // The working sheet: canned replies + custom + open-conversation link.
    return (
      <QuickReplySheetBody
        conversation={target.conversation}
        conversationId={target.conversationId ?? ''}
        options={options}
        sending={send.phase === 'sending'}
        sendingId={send.phase === 'sending' ? send.option.id : null}
        onSendOption={(o) => void doSend(o)}
        onSendCustom={(body) => void doSend({ id: 'custom', body })}
      />
    );
  }
}
