// InboxRow — one inbox row: a contact (or untriaged unknown number) aggregating
// its comms. The row body is a single Link (tap → contact page, and the page
// marks the comms read via onOpen); the Mark-read / Assign actions are SIBLINGS
// of the Link (never nested in the <a>), always in the DOM, revealed on hover /
// keyboard focus-within / swipe. Unread rows get a left accent bar, bold name +
// preview, and a red count. Unknown rows get an amber "Needs triage" chip and
// route to the triage list. No dangerouslySetInnerHTML — text renders as React
// children (XSS-safe).
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { InboxChannel, InboxRow as InboxRowData } from '../../api/index.js';
import styles from './InboxRow.module.css';

export interface InboxRowProps {
  row: InboxRowData;
  currentUserId?: string;
  currentUserName: string;
  onOpen: (row: InboxRowData) => void;
  onMarkRead: (row: InboxRowData) => void;
  onAssign: (row: InboxRowData, userId: string | null, name: string) => void;
}

const CHANNEL_LABEL: Record<InboxChannel, string> = {
  sms: 'Text',
  mms: 'Photo',
  call: 'Call',
};

/** The deep-link target: contact rows → the contact page; unknown rows → the
 *  Contacts ▸ Unknown triage list, deep-linked with the number. */
function hrefFor(row: InboxRowData): string {
  if (row.kind === 'contact' && row.contactId !== undefined) {
    return `/contacts/${row.contactId}`;
  }
  return `/contacts/unknown?phone=${encodeURIComponent(row.phone ?? '')}`;
}

export function InboxRow({
  row,
  currentUserId,
  currentUserName,
  onOpen,
  onMarkRead,
  onAssign,
}: InboxRowProps): React.JSX.Element {
  const unread = row.unreadCount > 0;
  const canAssign = row.kind === 'contact' && row.contactId !== undefined && currentUserId !== undefined;

  // Swipe-to-reveal (mobile). Keyboard/pointer users reach the same buttons via
  // Tab (focus-within reveals them in CSS); swipe is an ADDITIONAL affordance.
  const [revealed, setRevealed] = useState(false);
  const startX = useRef<number | null>(null);
  function onPointerDown(e: React.PointerEvent): void {
    startX.current = e.clientX;
  }
  function onPointerUp(e: React.PointerEvent): void {
    if (startX.current === null) return;
    const dx = e.clientX - startX.current;
    startX.current = null;
    if (dx <= -40) setRevealed(true);
    else if (dx >= 40) setRevealed(false);
  }

  return (
    <li
      className={`${styles.rowItem} ${revealed ? styles.revealed : ''}`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className={`${styles.row} ${unread ? styles.unread : ''}`}>
        <Link className={styles.main} to={hrefFor(row)} onClick={() => onOpen(row)}>
          {row.role ? <span className={`${styles.dot} ${styles[`dot_${row.role}`] ?? ''}`} aria-hidden="true" /> : null}
          <span className={styles.head}>
            <span className={`${styles.name} ${unread ? styles.bold : ''}`}>{row.name}</span>
            <span className={styles.channel}>{CHANNEL_LABEL[row.channel]}</span>
            {row.placementContext ? <span className={styles.tag}>{row.placementContext.label}</span> : null}
            {row.needsTriage ? <span className={styles.triage}>Needs triage</span> : null}
            {row.assignment ? (
              <span className={styles.assigned}>
                Assigned - {row.assignment.userId === currentUserId ? 'You' : row.assignment.name}
              </span>
            ) : null}
          </span>
          <span className={`${styles.preview} ${unread ? styles.bold : ''}`}>
            {row.direction === 'outbound' ? `You: ${row.preview}` : row.preview}
          </span>
          {unread ? (
            <span className={styles.count} aria-label={`${row.unreadCount} unread`}>
              {row.unreadCount}
            </span>
          ) : null}
        </Link>

        <div className={styles.actions}>
          {unread ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => onMarkRead(row)}
              aria-label={`Mark ${row.name} read`}
            >
              Mark read
            </button>
          ) : null}
          {canAssign ? (
            row.assignment ? (
              <button
                type="button"
                className={styles.action}
                onClick={() => onAssign(row, null, '')}
                aria-label={`Unassign ${row.name}`}
              >
                Unassign
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={() => onAssign(row, currentUserId ?? '', currentUserName)}
                aria-label={`Assign ${row.name} to me`}
              >
                Assign to me
              </button>
            )
          ) : null}
        </div>
      </div>
    </li>
  );
}
