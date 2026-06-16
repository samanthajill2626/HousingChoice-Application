// MessageBubble — one message in a thread. Inbound sits left on a neutral
// surface; outbound sits right on the brand surface (mirrors a familiar chat
// idiom while staying on the dashboard token palette). The body is ALWAYS
// rendered as text (React escapes it) — never dangerouslySetInnerHTML — which is
// the XSS guard for message content. Media is restricted to same-origin canned
// assets; an outbound message also carries a StatusChip for its delivery state.
import { StatusChip } from './StatusChip.js';
import { cannedLabelFor } from '../assets/canned/index.js';
import styles from './MessageBubble.module.css';
import type { ThreadMessage } from '../api/types.js';

export interface MessageBubbleProps {
  message: ThreadMessage;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function MessageBubble({ message }: MessageBubbleProps): React.JSX.Element {
  const isOutbound = message.direction === 'outbound';
  const time = formatTime(message.createdAt);
  return (
    <div
      className={`${styles.row} ${isOutbound ? styles.outbound : styles.inbound}`}
      data-testid="message-bubble"
      data-direction={message.direction}
    >
      <div className={styles.bubble}>
        {message.mediaUrls && message.mediaUrls.length > 0 && (
          <div className={styles.media}>
            {message.mediaUrls.map((url) => (
              <img
                key={url}
                className={styles.thumb}
                src={url}
                alt={cannedLabelFor(url)}
                loading="lazy"
              />
            ))}
          </div>
        )}
        {message.body !== undefined && message.body !== '' && (
          <p className={styles.body}>{message.body}</p>
        )}
        <div className={styles.meta}>
          <time className={styles.time} dateTime={message.createdAt}>
            {time}
          </time>
          {isOutbound && <StatusChip state={message.state} errorCode={message.errorCode} />}
        </div>
      </div>
    </div>
  );
}
