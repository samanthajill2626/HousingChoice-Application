// MessageList — the scrolling timeline. Renders messages oldest→bottom (the
// hook hands them ascending by tsMsgId), loads older history when the user
// scrolls to the TOP (via the `before` cursor), and auto-scrolls to the bottom
// on the initial render + when a new message lands at the end.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Spinner } from '../../ui';
import { MessageBubble } from './MessageBubble';
import { isPending, type TimelineMessage } from './useThreadMessages';
import type { ConversationParticipant, Message } from '../../api';
import styles from './MessageList.module.css';

export interface MessageListProps {
  messages: TimelineMessage[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onRetry: (message: Message) => void;
  /** tsMsgId/localId currently being (re)sent — disables that bubble's Retry. */
  retryingId?: string;
  /** Relay group (M1.7): the live roster, forwarded to each bubble for relay
   *  attribution + per-recipient delivery chips. Absent on 1:1 threads. */
  roster?: ConversationParticipant[];
}

/** Scroll threshold (px) from the top that triggers a "load older" page. */
const TOP_THRESHOLD = 48;

export function MessageList({
  messages,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onRetry,
  retryingId,
  roster,
}: MessageListProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastKeyRef = useRef<string | undefined>(undefined);
  // Remember the scroll height before a prepend so we can keep the viewport
  // anchored after older messages load in at the top.
  const prependAnchor = useRef<{ height: number; top: number } | undefined>(undefined);

  const lastMessage = messages[messages.length - 1];
  const lastKey = lastMessage
    ? isPending(lastMessage)
      ? lastMessage.localId
      : lastMessage.tsMsgId
    : undefined;

  // Auto-scroll to the bottom when the newest message changes (new send/inbound),
  // unless we just prepended older history.
  useEffect(() => {
    if (prependAnchor.current !== undefined) return;
    if (lastKey !== undefined && lastKey !== lastKeyRef.current) {
      // Guard: scrollIntoView is unimplemented in jsdom (and absent on some
      // engines) — skip rather than throw.
      const el = bottomRef.current;
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'end' });
      }
      lastKeyRef.current = lastKey;
    }
  }, [lastKey, messages.length]);

  // After older messages prepend, restore the scroll position so the view
  // doesn't jump.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = prependAnchor.current;
    if (el && anchor) {
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
      prependAnchor.current = undefined;
    }
  });

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop <= TOP_THRESHOLD && hasMore && !loadingOlder) {
      prependAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
      onLoadOlder();
    }
  }

  return (
    <div className={styles.scroll} ref={scrollRef} onScroll={handleScroll} role="log" aria-label="Message timeline">
      {hasMore && (
        <div className={styles.olderRow}>
          {loadingOlder ? (
            <Spinner size="sm" label="Loading earlier messages" />
          ) : (
            <button type="button" className={styles.olderBtn} onClick={onLoadOlder}>
              Load earlier messages
            </button>
          )}
        </div>
      )}
      <ul className={styles.list}>
        {messages.map((m) => {
          const key = isPending(m) ? m.localId : m.tsMsgId;
          const isRetrying = retryingId !== undefined && retryingId === key;
          return (
            <MessageBubble
              key={key}
              message={m}
              onRetry={onRetry}
              retrying={isRetrying}
              {...(roster !== undefined && { roster })}
            />
          );
        })}
      </ul>
      <div ref={bottomRef} />
    </div>
  );
}
