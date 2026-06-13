// MessageBubble — one timeline message. Inbound messages sit LEFT, outbound
// RIGHT (by `direction`). Outbound messages carry a DeliveryBadge (queued →
// sent → delivered, or a failure with the human-readable reason; "sent" is NOT
// an error) and, on a failed/undelivered send, an inline Retry that re-sends
// the same body.
//
// MMS media: the backend mirrors inbound MMS media to S3 (`media_s3_keys`) and
// the provider `mediaUrls` are not publicly fetchable, so for M1.4 we render a
// clear "media attachment" placeholder chip rather than a broken <img>.
// TODO(foundation): serve signed S3 URLs for media_s3_keys so attachments can
// render inline — flagged; no media-serving endpoint exists yet in src/api.
import { Badge, Button, DeliveryBadge, presentDeliveryStatus } from '../../ui';
import { isPending, type TimelineMessage } from './useThreadMessages';
import type { Message, MessageAuthor } from '../../api';
import styles from './MessageBubble.module.css';

const AUTHOR_LABEL: Record<MessageAuthor, string> = {
  tenant: 'Tenant',
  landlord: 'Landlord',
  teammate: 'Teammate',
  ai: 'Assistant',
  unknown: 'Unknown sender',
};

export interface MessageBubbleProps {
  message: TimelineMessage;
  /** Re-send a failed/undelivered message (outbound only). */
  onRetry: (message: Message) => void;
  /** True while a retry/send is in flight (disables the Retry button). */
  retrying?: boolean;
}

function mediaCount(message: TimelineMessage): number {
  const keys = message.media_s3_keys?.length ?? 0;
  const urls = message.mediaUrls?.length ?? 0;
  return Math.max(keys, urls);
}

export function MessageBubble({ message, onRetry, retrying = false }: MessageBubbleProps): React.JSX.Element {
  const outbound = message.direction === 'outbound';
  const pending = isPending(message);
  const { isFailure } = presentDeliveryStatus(message.delivery_status);
  const media = mediaCount(message);
  const hasBody = typeof message.body === 'string' && message.body.length > 0;

  const sideClass = outbound ? styles.outbound : styles.inbound;

  return (
    <li className={`${styles.row} ${sideClass}`}>
      <div className={styles.bubble} aria-label={`${AUTHOR_LABEL[message.author]} message`}>
        <span className={styles.author}>{AUTHOR_LABEL[message.author]}</span>

        {hasBody && <p className={styles.body}>{message.body}</p>}

        {media > 0 && (
          <span className={styles.media} title="Media attachment (not yet viewable)">
            📎 {media === 1 ? 'Media attachment' : `${media} media attachments`}
          </span>
        )}

        {!hasBody && media === 0 && <p className={styles.empty}>(no content)</p>}

        {outbound && (
          <div className={styles.meta}>
            {pending ? (
              <Badge tone="neutral" dot>
                Sending…
              </Badge>
            ) : (
              <DeliveryBadge
                status={message.delivery_status}
                {...(message.error_code !== undefined && { errorCode: message.error_code })}
              />
            )}
            {!pending && isFailure && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRetry(message)}
                loading={retrying}
                title="Re-send this message"
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
