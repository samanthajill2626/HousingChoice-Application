// QuickReply - the ONE-TAP missed-call reply sheet at '/quick-reply/:callId'.
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
// THE URL NAMES A CALL, NEVER A RECIPIENT. The conversation is resolved from
// GET /api/calls/:callId - the server's own record of the call - and NOT from
// anything the URL carries. That distinction is the whole security posture of
// this view: it sends a real SMS on arrival with no user gesture, so a
// conversation id taken from the URL would let any link the founder can be made
// to open choose who gets texted. A CallSid that names no call gets a dead end,
// not a send. (An earlier draft passed the conversation in the query to save a
// round trip; it saved nothing - this call replaces the header fetch rather than
// adding to it - and it bought a URL-triggered send. Do not reintroduce it.)
//
// THE SEND IS FINAL. There is no undo (deliberate - Cameron 2026-08-20): an SMS
// cannot be recalled, so a delayed send with an Undo bar would buy an illusion
// at the cost of a whole edge case. Tapping sends. The sheet therefore shows who
// the reply is going to BEFORE the buttons, and the recipient travels in the
// same state object as the replies so it can never name a stale caller.
//
// The zero-tap missed-call auto-text is a separate, server-side path (the
// call.missedAutoText job) and is untouched by this view. It is deliberately NOT
// offered as an option here: it may already have fired for this same call, and
// re-sending it would text the caller the identical message twice.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  getCall,
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
 *  contact name when we have one, else the caller's number, else nothing. */
function recipientLabel(conversation: ConversationHeader): string | undefined {
  const named = conversation.participants?.find(
    (p) => typeof p.name === 'string' && p.name.length > 0,
  );
  if (named?.name !== undefined) return named.name;
  const phone = conversation.participant_phone;
  if (typeof phone !== 'string' || phone.length === 0) return undefined;
  return formatPhoneDisplay(phone);
}

/** What the callId resolved to. `ready` carries the conversation, the recipient
 *  label and the replies as ONE value: they are read together on every render,
 *  so holding them separately would let a reload show the previous caller's name
 *  above the next caller's replies. */
type Target =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      conversationId: string;
      recipient: string | undefined;
      options: QuickReplyOption[];
    }
  /** The CallSid names no call we hold. */
  | { kind: 'no_call' }
  /** A real call whose thread is gone - nothing to reply into. */
  | { kind: 'no_conversation' }
  | { kind: 'error'; message: string };

/** The send lifecycle for this view. */
type SendState =
  | { phase: 'idle' }
  | { phase: 'sending'; body: string }
  | { phase: 'sent'; body: string }
  | { phase: 'failed'; body: string; message: string };

export function QuickReply(): React.JSX.Element {
  const { callId } = useParams<{ callId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [target, setTarget] = useState<Target>({ kind: 'loading' });
  const [send, setSend] = useState<SendState>({ phase: 'idle' });
  /** An '#action=' id that named no reply we can send - surfaced, never silent. */
  const [unmatchedAction, setUnmatchedAction] = useState<string | undefined>(undefined);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Resolve the call and load the canned replies together. Both are required
  // before anything can be sent, and both land in one setState so the rendered
  // recipient and the rendered replies always describe the same call.
  useEffect(() => {
    if (callId === undefined) {
      setTarget({ kind: 'no_call' });
      return undefined;
    }
    const controller = new AbortController();
    let alive = true;
    setTarget({ kind: 'loading' });
    setSend({ phase: 'idle' });
    setUnmatchedAction(undefined);
    void (async () => {
      try {
        const [settings, call] = await Promise.all([
          getSettings(controller.signal),
          getCall(callId, controller.signal),
        ]);
        if (!alive) return;
        if (call.conversation === null) {
          setTarget({ kind: 'no_conversation' });
          return;
        }
        setTarget({
          kind: 'ready',
          conversationId: call.conversation.conversationId,
          recipient: recipientLabel(call.conversation),
          options: buildQuickReplyOptions(settings.settings.quickReplies),
        });
      } catch (err) {
        if (!alive || controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) {
          setTarget({ kind: 'no_call' });
          return;
        }
        setTarget({
          kind: 'error',
          message: err instanceof ApiError ? err.message : "Couldn't load this missed call.",
        });
      }
    })();
    return () => {
      alive = false;
      controller.abort();
    };
  }, [callId, reloadNonce]);

  const doSend = useCallback(
    async (conversationId: string, body: string): Promise<void> => {
      if (body.length === 0) return;
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
    [],
  );

  // The Android action-button path: send the named reply on arrival, ONCE.
  //
  // The latch is a ref keyed by callId, set BEFORE the send and regardless of
  // whether the id resolved. A ref rather than state because StrictMode
  // double-invokes this effect in development and a ref survives that; keyed by
  // callId rather than by mount because the whole point is "one auto-send per
  // call", which is the guarantee that has to hold no matter how the component
  // is scheduled.
  //
  // The hash is cleared through the router (not raw history.replaceState, which
  // would discard the router's own history entry state), so a pull-to-refresh
  // cannot replay the send.
  const autoSentForRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (target.kind !== 'ready' || callId === undefined) return;
    if (autoSentForRef.current === callId) return;
    autoSentForRef.current = callId;

    const action = parseActionHash(location.hash);
    if (action === null) return;
    navigate({ hash: '' }, { replace: true });

    const matched = optionForAction(target.options, action);
    if (matched === undefined) {
      // NEVER silent. The founder pressed a labelled button; if we cannot map it
      // back to a reply (settings edited since the push, a blank template) they
      // have to be told, or they walk away believing a text went out.
      setUnmatchedAction(action);
      return;
    }
    void doSend(target.conversationId, matched.body);
  }, [target, callId, location.hash, navigate, doSend]);

  return (
    <section className={styles.page} aria-labelledby="quick-reply-heading">
      <h1 id="quick-reply-heading" className={styles.heading}>
        Quick reply
      </h1>
      <p className={styles.lede}>{lede()}</p>
      {renderBody()}
    </section>
  );

  function lede(): string {
    if (target.kind !== 'ready') return 'Replying to a missed call.';
    return target.recipient === undefined
      ? 'Missed call. Tap a reply to text them back now.'
      : `Missed call from ${target.recipient}. Tap a reply to text them back now.`;
  }

  function deadEnd(message: string): React.JSX.Element {
    return (
      <div className={styles.block} role="alert">
        <p className={styles.errorText}>{message}</p>
        <Link className={styles.link} to="/inbox">
          Open the inbox
        </Link>
      </div>
    );
  }

  function renderBody(): React.JSX.Element {
    // The reply landed. Terminal - the buttons are gone, because a second tap
    // here would be a second text nobody asked for.
    if (send.phase === 'sent' && target.kind === 'ready') {
      return (
        <div className={styles.block}>
          <p className={styles.sentHeading}>Sent</p>
          <p className={styles.sentBody}>{send.body}</p>
          <div className={styles.links}>
            <Link
              className={styles.link}
              to={`/conversations/${encodeURIComponent(target.conversationId)}`}
            >
              Open the conversation
            </Link>
            <Link className={styles.link} to="/inbox">
              Back to the inbox
            </Link>
          </div>
        </div>
      );
    }

    if (target.kind === 'loading') {
      return <Spinner center label="Loading your quick replies" />;
    }

    // The CallSid names no call we hold. Only a hand-typed URL or a worker
    // holding a notification for a call that has since been purged gets here.
    if (target.kind === 'no_call') {
      return deadEnd(
        callId === undefined
          ? "We couldn't tell which call this is."
          : `We couldn't find that call (${callId}).`,
      );
    }

    if (target.kind === 'no_conversation') {
      return deadEnd(
        "That call isn't linked to a conversation, so there's nothing to reply to here.",
      );
    }

    if (target.kind === 'error') {
      return (
        <div className={styles.block} role="alert">
          <p className={styles.errorText}>{target.message}</p>
          <Button variant="secondary" onClick={() => setReloadNonce((n) => n + 1)}>
            Retry
          </Button>
        </div>
      );
    }

    if (target.options.length === 0) {
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
            <Link
              className={styles.link}
              to={`/conversations/${encodeURIComponent(target.conversationId)}`}
            >
              Open the conversation
            </Link>
          </div>
        </div>
      );
    }

    const sending = send.phase === 'sending';
    const conversationId = target.conversationId;
    return (
      <div className={styles.block}>
        {unmatchedAction !== undefined ? (
          <p className={styles.errorText} role="alert">
            That quick reply is no longer set up, so nothing was sent. Pick one below.
          </p>
        ) : null}
        {send.phase === 'failed' ? (
          <p className={styles.errorText} role="alert">
            {send.message} Tap again to retry.
          </p>
        ) : null}
        <ul className={styles.replies}>
          {target.options.map((option) => (
            <li key={option.index}>
              <Button
                block
                variant="secondary"
                size="lg"
                disabled={sending}
                loading={sending && send.body === option.body}
                onClick={() => void doSend(conversationId, option.body)}
              >
                {option.body}
              </Button>
            </li>
          ))}
        </ul>
        <Link
          className={styles.link}
          to={`/conversations/${encodeURIComponent(conversationId)}`}
        >
          Open the conversation instead
        </Link>
      </div>
    );
  }
}
