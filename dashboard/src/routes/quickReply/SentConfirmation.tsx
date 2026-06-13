// SentConfirmation — the post-send acknowledgement shown in the sheet. No undo
// (per spec — just a clear confirmation): the reply went out from the business
// number; offer to open the full conversation or dismiss back to the inbox.
import { Button } from '../../ui/index.js';
import styles from './QuickReply.module.css';

export interface SentConfirmationProps {
  /** The body text that was sent. */
  body: string;
  /** The conversation it went to (for the "Open conversation" link). */
  conversationId: string | undefined;
  /** Dismiss the sheet (→ inbox). */
  onClose: () => void;
}

export function SentConfirmation({
  body,
  conversationId,
  onClose,
}: SentConfirmationProps): React.JSX.Element {
  return (
    <div className={styles.sent}>
      <div className={styles.sentIcon} aria-hidden="true">
        {/* Inline check — no external icon dependency (CSP). */}
        <svg
          width={24}
          height={24}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <div className={styles.sentTitle}>Reply sent</div>
      <div className={styles.sentBody}>
        Sent from your business number: “{body}”
      </div>
      <div className={styles.sentActions}>
        {conversationId !== undefined && conversationId !== '' && (
          <Button
            as="a"
            href={`/conversations/${encodeURIComponent(conversationId)}`}
            variant="secondary"
            block
          >
            Open conversation
          </Button>
        )}
        <Button variant="ghost" block onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
