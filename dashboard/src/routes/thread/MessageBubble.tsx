// MessageBubble — one timeline message. Inbound messages sit LEFT, outbound
// RIGHT (by `direction`). Outbound messages carry a DeliveryBadge (queued →
// sent → delivered, or a failure with the human-readable reason; "sent" is NOT
// an error) and, on a failed/undelivered send, an inline Retry that re-sends
// the same body.
//
// MMS media: the backend mirrors inbound MMS media to S3 and records
// `media_attachments` ({s3Key, contentType}). Each is served by the authed
// same-origin endpoint and rendered BY TYPE: allowlisted images inline, PDFs as
// a viewer link, anything else as a download. Provider `mediaUrls` are not
// publicly fetchable, so an UNMIRRORED message (no attachments) still shows a
// "media attachment" placeholder chip rather than a broken <img>.
import { Badge, Button, DeliveryBadge, presentDeliveryStatus } from '../../ui';
import { isPending, type TimelineMessage } from './useThreadMessages';
import { PerRecipientDeliveryBadges } from './PerRecipientDeliveryBadges';
import { CallEntry } from './CallEntry';
import { memberLabelForKey } from './relay';
import type { ConversationParticipant, Message, MessageAuthor } from '../../api';
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
  /**
   * Relay group (M1.7): the live roster. When present, this bubble renders in
   * RELAY mode — inbound attribution resolves relay_sender_key against the
   * roster, and a delivery_recipients map renders per-recipient chips. Absent
   * for 1:1 threads → byte-for-byte the original 1:1 rendering.
   */
  roster?: ConversationParticipant[];
}

/**
 * Mirrored attachments for a message: prefers the cohesive media_attachments
 * record, folding legacy media_s3_keys into it as octet-stream (→ download).
 */
function attachmentsOf(message: TimelineMessage): { s3Key: string; contentType: string }[] {
  if (Array.isArray(message.media_attachments)) return message.media_attachments;
  if (Array.isArray(message.media_s3_keys)) {
    return message.media_s3_keys.map((s3Key) => ({ s3Key, contentType: 'application/octet-stream' }));
  }
  return [];
}

export function MessageBubble({
  message,
  onRetry,
  retrying = false,
  roster,
}: MessageBubbleProps): React.JSX.Element {
  // Voice call (M1.9): a call is a metadata-only timeline event, not a chat
  // bubble — render the dedicated CallEntry and skip all the 1:1/relay text +
  // delivery rendering below. (An optimistic pending bubble is always an
  // outbound SMS, never a call, so this never collides with PendingMessage.)
  if (message.type === 'call' && !isPending(message)) {
    return <CallEntry message={message} />;
  }

  const outbound = message.direction === 'outbound';
  const pending = isPending(message);
  const { isFailure } = presentDeliveryStatus(message.delivery_status);
  // Mirrored (S3-backed) inbound MMS attachments are viewable via the authed
  // same-origin media endpoint (the session cookie rides along); each renders by
  // its stored type. Unmirrored media (e.g. local without a bucket) has no
  // attachments and falls back to the provider-URL placeholder chip.
  const attachments = attachmentsOf(message);
  const unmirroredCount = message.mediaUrls?.length ?? 0;
  const hasBody = typeof message.body === 'string' && message.body.length > 0;

  // Relay mode (M1.7): only when a roster is supplied. Attribution comes from
  // relay_sender_key resolved against the roster (NEVER the body); the fan-out
  // state is the delivery_recipients map (per-recipient chips below).
  const isRelay = roster !== undefined;
  const recipients = isRelay ? message.delivery_recipients : undefined;
  const hasRecipients = recipients !== undefined && Object.keys(recipients).length > 0;
  const lateReply = isRelay && message.received_on_closed_thread === true;
  // For an inbound relayed message, the author is the sender member; resolve it.
  const relayAuthorLabel =
    isRelay && !outbound && message.relay_sender_key !== undefined
      ? memberLabelForKey(roster, message.relay_sender_key)
      : undefined;
  const authorLabel = relayAuthorLabel ?? AUTHOR_LABEL[message.author];

  const sideClass = outbound ? styles.outbound : styles.inbound;

  return (
    <li className={`${styles.row} ${sideClass}`}>
      <div className={styles.bubble} aria-label={`${authorLabel} message`}>
        <span className={styles.author}>{authorLabel}</span>

        {hasBody && <p className={styles.body}>{message.body}</p>}

        {attachments.length > 0 ? (
          <div className={styles.mediaGallery}>
            {attachments.map((att, i) => {
              const src = `/api/messages/${encodeURIComponent(message.provider_sid)}/media/${i}`;
              // Images render inline; PDFs open in the browser's sandboxed viewer
              // (the serve endpoint sends them inline); anything else downloads.
              if (att.contentType.startsWith('image/')) {
                return (
                  <a key={i} className={styles.mediaLink} href={src} target="_blank" rel="noopener noreferrer">
                    <img className={styles.mediaImg} src={src} alt={`Attachment ${i + 1}`} loading="lazy" />
                  </a>
                );
              }
              const isPdf = att.contentType === 'application/pdf';
              return (
                <a key={i} className={styles.mediaFile} href={src} target="_blank" rel="noopener noreferrer">
                  {isPdf ? `📄 PDF attachment ${i + 1}` : `📎 Attachment ${i + 1}`}
                </a>
              );
            })}
          </div>
        ) : (
          unmirroredCount > 0 && (
            <span className={styles.media} title="Media attachment (not yet viewable)">
              📎 {unmirroredCount === 1 ? 'Media attachment' : `${unmirroredCount} media attachments`}
            </span>
          )
        )}

        {!hasBody && attachments.length === 0 && unmirroredCount === 0 && (
          <p className={styles.empty}>(no content)</p>
        )}

        {lateReply && (
          <Badge tone="warning" dot title="Arrived after the thread was closed">
            Late reply (thread closed)
          </Badge>
        )}

        {/* Relay fan-out: per-recipient delivery chips (resolved to members). */}
        {hasRecipients && roster !== undefined && (
          <PerRecipientDeliveryBadges recipients={recipients} roster={roster} />
        )}

        {/* 1:1 outbound delivery badge + retry. In relay mode the per-recipient
         * chips above ARE the delivery state, so skip the single badge. */}
        {outbound && !isRelay && (
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

        {/* Relay outbound with no recipient map yet (e.g. optimistic team send
         * before fan-out seeds it): show the simple "Sending…" cue. */}
        {outbound && isRelay && !hasRecipients && pending && (
          <div className={styles.meta}>
            <Badge tone="neutral" dot>
              Sending…
            </Badge>
          </div>
        )}
      </div>
    </li>
  );
}
