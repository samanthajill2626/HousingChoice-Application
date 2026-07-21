// UnmatchedRow -- one row on the /email triage list. A header BUTTON toggles an
// expandable detail region (lazily fetching the full body on first open and
// marking the row read); the per-status action buttons are SIBLINGS of that
// button (never nested in it), matching the InboxRow pattern. Purely
// presentational: it renders text as React children (never
// dangerouslySetInnerHTML) and calls the page's callbacks -- the page owns the
// mutations, modals, and navigation.
import { useState } from 'react';
import { getUnmatchedEmailDetail, type UnmatchedEmailItem, type UnmatchedEmailRow } from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { EmailHtmlFrame } from '../contact/EmailHtmlFrame.js';
import { formatBroadcastDate } from '../broadcasts/broadcastFormat.js';
import type { UnmatchedFilter } from './useUnmatchedEmail.js';
import styles from './EmailTriage.module.css';

export interface UnmatchedRowProps {
  row: UnmatchedEmailRow;
  filter: UnmatchedFilter;
  onMarkRead: (id: string) => void;
  /** Open the Link-to-contact modal (page-owned). */
  onLink: (id: string) => void;
  /** Open the New-contact modal (page-owned). */
  onNewContact: (id: string) => void;
  /** Open the Spam confirm dialog (page-owned). */
  onSpam: (id: string) => void;
  /** Dismiss the row (direct; page runs it + surfaces any error). */
  onDismiss: (id: string) => void;
  /** Release a quarantined row back to Unmatched (direct). */
  onRelease: (id: string) => void;
  /** Delete a quarantined row (direct; == dismiss, labeled "Delete"). */
  onDelete: (id: string) => void;
}

/** The sender line: the display name, else the address, else a placeholder; a
 *  parse-skipped row (no readable MIME) reads "Unparseable mail". */
function senderName(row: UnmatchedEmailRow): string {
  if (row.parse_skipped !== undefined) return 'Unparseable mail';
  if (row.from.name !== undefined && row.from.name.trim().length > 0) return row.from.name.trim();
  if (row.from.address.length > 0) return row.from.address;
  return 'Unknown sender';
}

/** The subject line (semibold): honest placeholders for empty / unparseable. */
function subjectText(row: UnmatchedEmailRow): string {
  if (row.parse_skipped !== undefined) return 'This message could not be read';
  return row.subject.trim().length > 0 ? row.subject : '(no subject)';
}

/** The quarantine reason tag: virus beats spam; a GRAY verdict is "possible". */
function quarantineTag(row: UnmatchedEmailRow): string {
  if (row.virus_verdict === 'FAIL') return 'Virus';
  if (row.spam_verdict === 'FAIL') return 'Spam';
  if (row.spam_verdict === 'GRAY') return 'Possible spam';
  return 'Quarantined';
}

/** A compact byte size, e.g. "12 KB" / "1.4 MB". */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function UnmatchedRow({
  row,
  filter,
  onMarkRead,
  onLink,
  onNewContact,
  onSpam,
  onDismiss,
  onRelease,
  onDelete,
}: UnmatchedRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<UnmatchedEmailItem | null>(null);
  const [detailStatus, setDetailStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  // Lazy-mount gate for the sandboxed HTML frame: keep the iframe OUT of the DOM
  // until the operator opens "View original formatting".
  const [htmlOpen, setHtmlOpen] = useState(false);

  const unread = !row.read;
  const id = row.unmatchedId;

  function toggle(): void {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;
    // Lazily fetch the full body the first time the row opens.
    if (detail === null && detailStatus !== 'loading') {
      setDetailStatus('loading');
      getUnmatchedEmailDetail(id)
        .then((d) => {
          setDetail(d);
          setDetailStatus('idle');
        })
        .catch(() => setDetailStatus('error'));
    }
    // Opening the message reads it (optimistic dot clear + POST); no-op if read.
    if (unread) onMarkRead(id);
  }

  return (
    <li className={styles.rowItem}>
      <div className={`${styles.row} ${unread ? styles.unread : ''}`}>
        <button type="button" className={styles.main} aria-expanded={expanded} onClick={toggle}>
          {unread ? <span className={styles.dot} role="img" aria-label="Unread" /> : null}
          <span className={styles.head}>
            <span className={`${styles.from} ${unread ? styles.bold : ''}`}>{senderName(row)}</span>
            <span className={styles.subject}>{subjectText(row)}</span>
            {filter === 'quarantine' ? (
              <span className={styles.spamTag}>{quarantineTag(row)}</span>
            ) : null}
            {row.attachments_meta.length > 0 ? (
              <span className={styles.attachCount}>
                {row.attachments_meta.length} file{row.attachments_meta.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </span>
          {row.snippet.length > 0 ? <span className={styles.snippet}>{row.snippet}</span> : null}
          <span className={styles.time}>{formatBroadcastDate(row.received_at)}</span>
        </button>

        <div className={styles.actions}>
          {filter === 'unmatched' ? (
            <>
              <button type="button" className={styles.action} onClick={() => onLink(id)}>
                Link to contact
              </button>
              <button type="button" className={styles.action} onClick={() => onNewContact(id)}>
                New contact
              </button>
              <button type="button" className={styles.action} onClick={() => onSpam(id)}>
                Spam
              </button>
              <button type="button" className={styles.action} onClick={() => onDismiss(id)}>
                Dismiss
              </button>
            </>
          ) : (
            <>
              <button type="button" className={styles.action} onClick={() => onRelease(id)}>
                Release
              </button>
              <button type="button" className={styles.action} onClick={() => onDelete(id)}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {expanded ? (
        <div className={styles.detail}>
          {detailStatus === 'loading' ? <Spinner /> : null}
          {detailStatus === 'error' ? (
            <p className={styles.detailError} role="alert">
              We couldn&apos;t load this message.
            </p>
          ) : null}
          {detail !== null ? (
            <>
              <p className={styles.detailMeta}>
                From {detail.from.address.length > 0 ? detail.from.address : 'unknown sender'}
              </p>
              <div className={styles.body}>{detail.text}</div>
              {detail.html_sanitized !== undefined ? (
                // B7: the plain-text body renders above; this discloses the
                // ORIGINAL HTML formatting in a fully sandboxed, CSP-locked iframe
                // (EmailHtmlFrame), mounted LAZILY only once the operator opens it.
                <details
                  className={styles.htmlDetails}
                  onToggle={(e) => setHtmlOpen((e.currentTarget as HTMLDetailsElement).open)}
                >
                  <summary className={styles.htmlToggle}>View original formatting</summary>
                  {htmlOpen ? <EmailHtmlFrame html={detail.html_sanitized} /> : null}
                </details>
              ) : null}
              {row.attachments_meta.length > 0 ? (
                <div className={styles.attachments}>
                  <span className={styles.attachLabel}>Attachments</span>
                  <ul className={styles.attachList}>
                    {row.attachments_meta.map((a, i) => (
                      <li key={`${a.filename}-${i}`}>
                        {a.filename} <span className={styles.attachSize}>({formatBytes(a.size)})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
