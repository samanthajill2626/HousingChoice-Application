// MessageBubble — one message in a thread. The UI is a "fake phone" for the
// SELECTED PARTY, so bubbles are PARTY-CENTRIC, not engine/app-centric:
//   - engine `inbound`  = the party's OWN text (party→app) → the party's
//     OUTGOING side: RIGHT, brand surface, NO status chip (like a sent bubble).
//   - engine `outbound` = the APP texting the party (app→party) = what the party
//     RECEIVES → INCOMING side: LEFT, neutral surface, WITH the StatusChip (the
//     app→party delivery progression the delivery-profile toggle controls).
// The body is ALWAYS rendered as text (React escapes it) — never
// dangerouslySetInnerHTML — which is the XSS guard for message content. Media is
// restricted to same-origin canned assets.
import { StatusChip } from './StatusChip.js';
import { cannedLabelFor, isImageAsset } from '../assets/canned/index.js';
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
  // Engine `outbound` = app→party message the party RECEIVES (incoming/left,
  // carries the delivery chip). Engine `inbound` = the party's own sent text
  // (outgoing/right, no chip).
  const isAppMessage = message.direction === 'outbound';
  const partySide = isAppMessage ? 'incoming' : 'outgoing';
  const time = formatTime(message.createdAt);
  return (
    <div
      className={`${styles.row} ${isAppMessage ? styles.incoming : styles.outgoing}`}
      data-testid="message-bubble"
      data-direction={message.direction}
      data-party-side={partySide}
    >
      <div className={styles.bubble}>
        {message.mediaUrls && message.mediaUrls.length > 0 && (
          <div className={styles.media}>
            {message.mediaUrls.map((url) =>
              isImageAsset(url) ? (
                <img key={url} className={styles.thumb} src={url} alt={cannedLabelFor(url)} loading="lazy" />
              ) : (
                <a key={url} className={styles.thumb} href={url} target="_blank" rel="noopener noreferrer">
                  📄 {cannedLabelFor(url)}
                </a>
              ),
            )}
          </div>
        )}
        {message.body !== undefined && message.body !== '' && (
          <p className={styles.body}>{message.body}</p>
        )}
        <div className={styles.meta}>
          <time className={styles.time} dateTime={message.createdAt}>
            {time}
          </time>
          {isAppMessage && <StatusChip state={message.state} errorCode={message.errorCode} />}
        </div>
      </div>
    </div>
  );
}
