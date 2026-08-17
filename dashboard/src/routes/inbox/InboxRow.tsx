// InboxRow — one inbox row: a contact (or untriaged unknown number) aggregating
// its comms. The row body is a single Link (tap → contact page, and the page
// marks the comms read via onOpen); the Mark-read action is a SIBLING of the
// Link (never nested in the <a>), always in the DOM, revealed on hover /
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
  onOpen: (row: InboxRowData) => void;
  onMarkRead: (row: InboxRowData) => void;
  /** The toggle's other half: shown INSTEAD of Mark read when the row is read.
   *  Optional so existing callers (and tests) that only mark read keep working;
   *  when absent a read row simply shows no action. */
  onMarkUnread?: (row: InboxRowData) => void;
}

const CHANNEL_LABEL: Record<InboxChannel, string> = {
  sms: 'Text',
  mms: 'Photo',
  call: 'Call',
  email: 'Email',
};

/** The deep-link target: contact rows -> the contact page; the two MULTI-PARTY
 *  kinds (relay_group, group_text) -> the conversation view; unknown rows -> the
 *  Contacts > Unknown triage list, deep-linked with the number.
 *  The trailing return is the UNKNOWN case, so an unhandled kind would silently
 *  link to `/contacts/unknown?phone=` (empty) - a wrong-surface link that looks
 *  like it worked. Every kind is handled above it on purpose. */
function hrefFor(row: InboxRowData): string {
  if (
    (row.kind === 'relay_group' || row.kind === 'group_text') &&
    row.conversationId !== undefined
  ) {
    return `/conversations/${row.conversationId}`;
  }
  if (row.kind === 'contact' && row.contactId !== undefined) {
    return `/contacts/${row.contactId}`;
  }
  return `/contacts/unknown?phone=${encodeURIComponent(row.phone ?? '')}`;
}

export function InboxRow({
  row,
  onOpen,
  onMarkRead,
  onMarkUnread,
}: InboxRowProps): React.JSX.Element {
  const unread = row.unreadCount > 0;
  const isRelay = row.kind === 'relay_group';
  const isGroupText = row.kind === 'group_text';
  // Both multi-party kinds get the same people glyph; the CHIP is what tells
  // them apart (a masked relay thread vs a native carrier group text).
  const isMultiParty = isRelay || isGroupText;
  // The channel/kind chip: contact/unknown rows show the latest item's channel
  // (Text/Photo/Call); a multi-party row has no channel - show what it IS.
  const kindLabel = isRelay
    ? 'Relay group'
    : isGroupText
      ? 'Group text'
      : row.channel
        ? CHANNEL_LABEL[row.channel]
        : '';

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
            <span className={`${styles.name} ${unread ? styles.bold : ''}`}>
              {isMultiParty ? <span aria-hidden="true">👥 </span> : null}
              {row.name}
            </span>
            <span className={styles.channel}>{kindLabel}</span>
            {/* RELAY-only lifecycle: a native group text has no closed state in
                v1 (spec 10) and its rows carry no `status` at all. */}
            {isRelay && row.status === 'closed' ? <span className={styles.tag}>Closed</span> : null}
            {row.placementContext ? <span className={styles.tag}>{row.placementContext.label}</span> : null}
            {row.needsTriage ? <span className={styles.triage}>Needs triage</span> : null}
            {row.deleted ? <span className={styles.deletedTag}>Deleted</span> : null}
          </span>
          <span className={`${styles.preview} ${unread ? styles.bold : ''}`}>
            {/* "You:" disambiguates an outbound message BODY. A call preview
                already names its direction ("Outgoing call - 42s"), so the
                prefix would double-encode it. */}
            {row.direction === 'outbound' && row.channel !== 'call' ? `You: ${row.preview}` : row.preview}
          </span>
          {unread ? (
            <span className={styles.count} aria-label={`${row.unreadCount} unread`}>
              {row.unreadCount}
            </span>
          ) : null}
        </Link>

        <div className={styles.actions}>
          {/* ONE toggle, never both: Mark read while unread, Mark unread while
              read. The affordance always describes the state change it makes,
              so there is no "click Mark read on an already-read row" case. */}
          {unread ? (
            <button
              type="button"
              className={styles.action}
              onClick={() => onMarkRead(row)}
              aria-label={`Mark ${row.name} read`}
            >
              Mark read
            </button>
          ) : onMarkUnread !== undefined && !row.deleted && row.status !== 'closed' ? (
            // Not offered where the server would refuse it: a soft-deleted
            // contact's (resurfaced) row that was just marked read on the All
            // tab (409 contact_deleted), or a relay row that closed under us
            // (409 thread_closed). "as unread" keeps the two labels from being
            // substrings of each other for assistive tech and selectors.
            <button
              type="button"
              className={styles.action}
              onClick={() => onMarkUnread(row)}
              aria-label={`Mark ${row.name} as unread`}
            >
              Mark unread
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
