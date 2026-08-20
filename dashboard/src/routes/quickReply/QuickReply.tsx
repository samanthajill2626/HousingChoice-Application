// QuickReply - the ONE-TAP missed-call reply sheet at
// '/quick-reply/:callId?conversationId=<id>'.
//
// This is the deep-link target of the missed-call push (PHASE1_CHANGE_ORDER_2
// founder triage): the founder taps the notification and lands here on the
// canned replies from Settings > Templates, one tap from a sent text. On Android
// the notification also carries action BUTTONS, and the service worker appends
// '#action=qr-<n>' when one is tapped - that reply then sends on arrival with no
// further tap, which is the actual one-tap path. iOS does not support
// notification actions, so there the plain tap lands here and the reply is the
// second tap; that asymmetry is inherent to the platform, not a gap here.
//
// WHY THE CONVERSATION IS IN THE QUERY. The push payload already carries
// conversationId beside callId (app/src/routes/webhooks/voice.ts), so the worker
// hands it straight to this view. That skips a GET /api/calls/:callId round trip
// on the one screen where latency is most visible - the founder is standing
// there having just missed a call. callId stays in the path because it names the
// call and keys the send-once latch below.
//
// THE SEND IS FINAL. There is no undo (deliberate - Cameron 2026-08-20): an SMS
// cannot be recalled, so a delayed send with an Undo bar would buy an illusion
// at the cost of a whole edge case. Tapping sends. The sheet therefore shows who
// the reply is going to BEFORE the buttons.
//
// The zero-tap missed-call auto-text is a separate, server-side path (the
// call.missedAutoText job) and is untouched by this view. It is deliberately NOT
// offered as an option here: it may already have fired for this same call, and
// re-sending it would text the caller the identical message twice.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ApiError,
  getConversation,
  getSettings,
  sendMessage,
  type ConversationHeader,
} from '../../api/index.js';
import { Button, Spinner } from '../../ui/index.js';
import { formatPhoneDisplay } from '../../lib/phone.js';
import {
  buildQuickReplyOptions,
  optionForAction,
  parseActionHash,
  type QuickReplyOption,
} from './quickReplyActions.js';
import styles from './QuickReply.module.css';

/** Where the reply is going, for the founder to read before tapping. A resolved
 *  contact name when we have one, else the caller's number, else nothing (the
 *  header fetch is decoration - it must never block the send). */
function recipientLabel(conversation: ConversationHeader): string | undefined {
  const named = conversation.participants?.find(
    (p) => typeof p.name === 'string' && p.name.length > 0,
  );
  if (named?.name !== undefined) return named.name;
  const phone = conversation.participant_phone;
  if (typeof phone !== 'string' || phone.length === 0) return undefined;
  return formatPhoneDisplay(phone);
}

/** The send lifecycle for this view. */
type SendState =
  | { phase: 'idle' }
  | { phase: 'sending'; body: string }
  | { phase: 'sent'; body: string }
  | { phase: 'failed'; body: string; message: string };

export function QuickReply(): React.JSX.Element {
  const { callId } = useParams<{ callId: string }>();
  const [searchParams] = useSearchParams();
  const conversationId = searchParams.get('conversationId') ?? undefined;

  const [options, setOptions] = useState<QuickReplyOption[] | undefined>(undefined);
  const [recipient, setRecipient] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [send, setSend] = useState<SendState>({ phase: 'idle' });

  // Load the canned replies (required) and the thread header (decoration). A
  // header failure is swallowed on purpose: not knowing the caller's name is a
  // worse screen than not being able to reply at all, but it is not a blocker.
  // With no conversation there is nothing to send into, so nothing is fetched -
  // that dead end renders from the URL alone.
  useEffect(() => {
    if (conversationId === undefined) return undefined;
    const controller = new AbortController();
    let alive = true;
    setOptions(undefined);
    setLoadError(undefined);
    void (async () => {
      try {
        const [settings, conversation] = await Promise.all([
          getSettings(controller.signal),
          conversationId === undefined
            ? Promise.resolve(undefined)
            : getConversation(conversationId, controller.signal).catch(() => undefined),
        ]);
        if (!alive) return;
        setOptions(buildQuickReplyOptions(settings.settings.quickReplies));
        setRecipient(conversation === undefined ? undefined : recipientLabel(conversation));
      } catch (err) {
        if (!alive || controller.signal.aborted) return;
        setLoadError(
          err instanceof ApiError ? err.message : "Couldn't load your quick replies.",
        );
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [conversationId, reloadNonce]);

  const doSend = useCallback(
    async (body: string): Promise<void> => {
      if (conversationId === undefined || body.length === 0) return;
      setSend({ phase: 'sending', body });
      try {
        // Sends from the business number automatically (resolved server-side).
        await sendMessage(conversationId, { body });
        setSend({ phase: 'sent', body });
      } catch (err) {
        setSend({
          phase: 'failed',
          body,
          message: err instanceof ApiError ? err.message : "The reply didn't send.",
        });
      }
    },
    [conversationId],
  );

  // The Android action-button path: send the named reply on arrival, ONCE.
  //
  // The hash is read here rather than held in state, and the latch is keyed by
  // callId, so the whole thing is one atomic step per call. That matters because
  // the worker navigates an already-open client to a second missed call's
  // deep-link without remounting this component - only :callId changes. A latch
  // keyed by anything else would either swallow the second call's auto-send or,
  // worse, fire the FIRST call's action into the second call's thread.
  //
  // The latch is set before the send and regardless of whether the id resolved,
  // so a stale id (settings edited between push and tap) degrades to a manual
  // tap instead of retrying. The hash is stripped at the same moment it is
  // consumed, so a pull-to-refresh cannot replay the send.
  const autoSentForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (options === undefined || conversationId === undefined || callId === undefined) return;
    if (autoSentForRef.current === callId) return;
    autoSentForRef.current = callId;

    const action = parseActionHash(window.location.hash);
    if (action === null) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    const matched = optionForAction(options, action);
    if (matched === undefined) return;
    void doSend(matched.body);
  }, [options, conversationId, callId, doSend]);

  return (
    <section className={styles.page} aria-labelledby="quick-reply-heading">
      <h1 id="quick-reply-heading" className={styles.heading}>
        Quick reply
      </h1>
      <p className={styles.lede}>
        {recipient === undefined
          ? 'Missed call. Tap a reply to text them back now.'
          : `Missed call from ${recipient}. Tap a reply to text them back now.`}
      </p>
      {renderBody()}
    </section>
  );

  function renderBody(): React.JSX.Element {
    // No conversation to reply into. The worker only ever sends us here with
    // one, so this is a hand-typed URL or a stale worker - say so plainly rather
    // than inventing a thread.
    if (conversationId === undefined) {
      return (
        <div className={styles.block} role="alert">
          <p className={styles.errorText}>
            We couldn&apos;t tell which conversation this call belongs to
            {callId === undefined ? '' : ` (call ${callId})`}.
          </p>
          <Link className={styles.link} to="/inbox">
            Open the inbox
          </Link>
        </div>
      );
    }

    // The reply landed. Terminal - the buttons are gone, because a second tap
    // here would be a second text nobody asked for.
    if (send.phase === 'sent') {
      return (
        <div className={styles.block}>
          <p className={styles.sentHeading}>Sent</p>
          <p className={styles.sentBody}>{send.body}</p>
          <div className={styles.links}>
            <Link className={styles.link} to={`/conversations/${encodeURIComponent(conversationId)}`}>
              Open the conversation
            </Link>
            <Link className={styles.link} to="/inbox">
              Back to the inbox
            </Link>
          </div>
        </div>
      );
    }

    if (loadError !== undefined) {
      return (
        <div className={styles.block} role="alert">
          <p className={styles.errorText}>{loadError}</p>
          <Button variant="secondary" onClick={() => setReloadNonce((n) => n + 1)}>
            Retry
          </Button>
        </div>
      );
    }

    if (options === undefined) {
      return <Spinner center label="Loading your quick replies" />;
    }

    if (options.length === 0) {
      return (
        <div className={styles.block}>
          <p className={styles.empty}>
            No quick replies are set up yet. Add them under Settings, Templates - they show up
            here and on the missed-call notification itself.
          </p>
          <div className={styles.links}>
            <Link className={styles.link} to="/settings/templates">
              Set up quick replies
            </Link>
            <Link className={styles.link} to={`/conversations/${encodeURIComponent(conversationId)}`}>
              Open the conversation
            </Link>
          </div>
        </div>
      );
    }

    const sending = send.phase === 'sending';
    return (
      <div className={styles.block}>
        {send.phase === 'failed' ? (
          <p className={styles.errorText} role="alert">
            {send.message} Tap again to retry.
          </p>
        ) : null}
        <ul className={styles.replies}>
          {options.map((option) => (
            <li key={option.index}>
              <Button
                block
                variant="secondary"
                size="lg"
                disabled={sending}
                loading={sending && send.body === option.body}
                onClick={() => void doSend(option.body)}
              >
                {option.body}
              </Button>
            </li>
          ))}
        </ul>
        <Link className={styles.link} to={`/conversations/${encodeURIComponent(conversationId)}`}>
          Open the conversation instead
        </Link>
      </div>
    );
  }
}
