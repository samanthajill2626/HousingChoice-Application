// RosterConfirmDialog - the last thing an operator reads before a REAL group
// text goes out (contact-rosters spec 6.3 pre-open / 6.4 add-to-live-group).
// Both confirms are the SAME shape because they answer the same question:
// exactly what will be sent, and to exactly whom.
//
//   - THE BODY IS THE SERVER'S. It is composed from the `relay.intro` /
//     `relay.member_added` catalog entries by the same code the send path uses
//     and rendered verbatim here. The templates are founder-editable, so a
//     browser-side copy would drift the first time one is edited.
//   - EVERY recipient is listed, receiving or not, with the reason. An
//     opted-out member's leg is suppressed at send time, so a bare "3
//     recipients" over a suppressed leg is precisely the lie this dialog
//     exists to prevent - and the COUNT is the server's distinct-reachable-
//     numbers count, never the number of rows.
//   - The quiet-hours line is HONEST ABOUT THE INTERIM: quiet hours are
//     evaluated and reported, but slice 6 owns the actual deferral, so a
//     confirmed send still goes out now and the copy says exactly that. It
//     never offers an "Open at 8:00 AM" button it cannot honour.
//
// Fetching is the CALLER's job: preview-open 409s `relay_already_provisioned`
// once a thread exists and preview-add 409s `no_thread` before one, and both
// must refetch rather than open a dialog. So the dialog only ever receives a
// preview that really is previewable.
import { useState } from 'react';
import type { RosterPreview, RosterPreviewRecipient } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { refusalMessage } from './rosterWrites.js';
import styles from './RosterConfirmDialog.module.css';

/** Why a listed recipient will not receive this send. */
const NOT_RECEIVING: Readonly<Record<string, string>> = {
  no_phone: 'not receiving - no mobile number',
  opted_out: 'not receiving - opted out',
};

/** A clock label for the quiet-window end, in the viewer's zone (the ToursPage
 *  idiom). The INSTANT itself is always the server's - we only format it. */
function clockLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export interface RosterConfirmDialogProps {
  /** The question, e.g. "Open the group text?" / "Add Alicia Grant to the group text?" */
  title: string;
  /** The server-resolved preview. Never rebuilt client-side. */
  preview: RosterPreview;
  /** The DEFAULT action's label, e.g. "Open group text" / "Add and notify". */
  confirmLabel: string;
  /** Run the action. Resolves -> the dialog closes; rejects -> its message
   *  renders inline and the dialog STAYS OPEN (nothing was sent). */
  onConfirm: () => Promise<void>;
  /** Cancel, dismiss, or a successful confirm - the caller clears its state. */
  onClose: () => void;
}

export function RosterConfirmDialog({
  title,
  preview,
  confirmLabel,
  onConfirm,
  onClose,
}: RosterConfirmDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onConfirm()
      .then(() => onClose())
      .catch((err: unknown) => {
        setError(refusalMessage(err));
        setBusy(false);
      });
  };

  const countLine =
    preview.recipientCount === 1
      ? '1 recipient will receive this.'
      : `${preview.recipientCount} recipients will receive this.`;

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <div className={styles.actions}>
          {/* Authored Cancel-then-default: desktop puts the default rightmost,
              and the narrow rule reverses the column so it lands on TOP
              (spec 6.7) without either order being re-authored. */}
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" type="button" onClick={run} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <section className={styles.previewBox} aria-label="Message preview">
        <p className={styles.bubble}>{preview.body}</p>
      </section>
      <ul className={styles.recipients} aria-label="Recipients">
        {preview.recipients.map((r, i) => (
          <RecipientRow key={`${r.name ?? 'unnamed'}-${i}`} recipient={r} />
        ))}
      </ul>
      <p className={styles.count}>{countLine}</p>
      {preview.deferred ? (
        <p className={styles.quiet}>
          {preview.quietEndsAt !== undefined
            ? `Quiet hours until ${clockLabel(preview.quietEndsAt)} - this will still send now.`
            : 'Quiet hours - this will still send now.'}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** One recipient line: the name, plus the reason when their leg is suppressed.
 *  A bare-phone participant has no name and this dialog prints no phone numbers
 *  (spec 6.2's rule holds everywhere), so they are named structurally. */
function RecipientRow({ recipient }: { recipient: RosterPreviewRecipient }): React.JSX.Element {
  const reason = NOT_RECEIVING[recipient.reachability];
  return (
    <li className={styles.recipient}>
      <span className={styles.recipientName}>{recipient.name ?? 'Unnamed number'}</span>
      {reason !== undefined ? <span className={styles.reason}>{reason}</span> : null}
    </li>
  );
}
