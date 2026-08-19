// RosterConfirmDialog - the last thing an operator reads before a REAL relay
// group goes out (contact-rosters spec 6.3 pre-open / 6.4 add-to-live-group).
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
//   - INSIDE QUIET HOURS the footer is the THREE-button layout (spec 6.3/6.4):
//     [Cancel] [Send now anyway] [<verb> at 8:00 AM], with the DEFERRAL as the
//     default. That is not a cosmetic choice: the plain confirm now defers
//     server-side (202 + a pending row), so the default button describes what
//     the default action really does, and "Send now anyway" is the ONLY path
//     that passes `force` and texts people at 11pm.
//
// Fetching is the CALLER's job: preview-open 409s `relay_already_provisioned`
// once a thread exists and preview-add 409s `no_thread` before one, and both
// must refetch rather than open a dialog. So the dialog only ever receives a
// preview that really is previewable.
import { useState } from 'react';
import type { RosterPreview, RosterPreviewRecipient } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { quietClockLabel, refusalMessage } from './rosterWrites.js';
import styles from './RosterConfirmDialog.module.css';

/** Why a listed recipient will not receive this send. */
const NOT_RECEIVING: Readonly<Record<string, string>> = {
  no_phone: 'not receiving - no mobile number',
  opted_out: 'not receiving - opted out',
};

export interface RosterConfirmDialogProps {
  /** The question, e.g. "Open the relay group?" / "Add Alicia Grant to the relay group?" */
  title: string;
  /** The server-resolved preview. Never rebuilt client-side. */
  preview: RosterPreview;
  /** The DEFAULT action's label OUTSIDE quiet hours, e.g. "Open relay group" /
   *  "Add and notify". */
  confirmLabel: string;
  /** The verb phrase the DEFERRAL button reads with, e.g. "Open" -> "Open at
   *  8:00 AM"; "Add and notify" -> "Add and notify at 8:00 AM" (spec 6.3/6.4).
   *  Used only inside quiet hours. */
  deferLabel: string;
  /** Run the action. `force` is true ONLY for "Send now anyway" - the caller
   *  passes it to the endpoint as `?force=send_now`. Resolves -> the dialog
   *  closes; rejects -> its message renders inline and the dialog STAYS OPEN
   *  (nothing was sent). */
  onConfirm: (force: boolean) => Promise<void>;
  /** Cancel, dismiss, or a successful confirm - the caller clears its state. */
  onClose: () => void;
  /** False when the confirming endpoint CANNOT defer (a standalone relay create
   *  has no owner row to hold a pending action). The quiet-hours warning still
   *  renders - the operator must learn it is quiet hours - but it SWITCHES to
   *  the not-held sentence, because neither the deferral button nor the
   *  "send it now" escape it would name exists on this path. Defaults to true -
   *  tour and placement are unaffected.
   *  TODO(standalone-relay-group-quiet-hours-deferral): full deferral parity
   *  needs a pending row that carries its own member list, since a standalone
   *  group has no roster stored anywhere until it is created. */
  allowDefer?: boolean;
}

/** "A", "A and B", "A, B and C" - the warning names who is already grouped. */
function formatNames(names: string[]): string {
  if (names.length === 0) return 'These people';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

export function RosterConfirmDialog({
  title,
  preview,
  confirmLabel,
  deferLabel,
  onConfirm,
  onClose,
  allowDefer = true,
}: RosterConfirmDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (force: boolean): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onConfirm(force)
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

  // Inside quiet hours the DEFAULT is the deferral, and it names the instant it
  // will happen. A server that reports `deferred` without an instant still gets
  // a truthful (time-less) label rather than "at Invalid Date".
  // ...unless the caller's endpoint cannot defer at all. Then the deferral
  // affordances go away (both of them) and the plain confirm is the only
  // action. The WARNING still renders on `preview.deferred` so the operator
  // learns it is quiet hours - but it CHANGES SENTENCE, because the deferring
  // copy names two things that no longer exist here: the wait ("this goes out
  // then") and the escape from it ("unless you send it now", which is the
  // button `canDefer` just removed). Promising a deferral this endpoint cannot
  // perform is the same class of lie as a count over a suppressed leg.
  //
  // The replacement says exactly ONE thing: quiet hours do not hold this send.
  // It deliberately does NOT promise an immediate send - a standalone create
  // that answers `connecting` has no number yet and sends its intro only once a
  // warmed number registers, which can be minutes later or (a group that never
  // gets one) never. "This does not wait for them" is true on BOTH tiers.
  const clock = preview.quietEndsAt !== undefined ? quietClockLabel(preview.quietEndsAt) : '';
  const canDefer = preview.deferred && allowDefer;
  const defaultLabel = !canDefer
    ? confirmLabel
    : clock === ''
      ? `${deferLabel} when quiet hours end`
      : `${deferLabel} at ${clock}`;
  const quietLine = canDefer
    ? clock === ''
      ? 'Quiet hours - this goes out when they end unless you send it now.'
      : `Quiet hours until ${clock} - this goes out then unless you send it now.`
    : clock === ''
      ? 'Quiet hours - this does not wait for them.'
      : `Quiet hours until ${clock} - this does not wait for them.`;

  return (
    <Modal
      title={title}
      // Escape, the backdrop and the header X all call Modal's onClose with no
      // condition of their own, and Cancel is already disabled={busy}. THIS
      // dialog is what renders the round trip's outcome - the inline refusal, the
      // caller's success routing, its result panels - so a dismissal mid-flight
      // orphans that answer: the action stays unresolved, and the caller's own
      // start affordance comes back armed over it. On the relay-open surfaces
      // that action is also irreversible once it lands (a claimed pool number and
      // an intro to everyone listed), and `POST /api/relay-groups` has no
      // idempotency key, so the re-armed retry is a SECOND number and a second
      // text to the same people.
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className={styles.actions}>
          {/* Authored Cancel -> (Send now anyway) -> default: desktop puts the
              default rightmost, and the narrow rule reverses the column so it
              lands on TOP (spec 6.7) without either order being re-authored. */}
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {canDefer ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => run(true)}
              disabled={busy}
            >
              Send now anyway
            </Button>
          ) : null}
          <Button size="sm" type="button" onClick={() => run(false)} disabled={busy}>
            {defaultLabel}
          </Button>
        </div>
      }
    >
      <section className={styles.previewBox} aria-label="Message preview">
        <p className={styles.bubble}>{preview.body}</p>
      </section>
      {/* A LIVE group with exactly these members already exists (spec 5). This
          block adds itself ABOVE the recipient list and changes nothing below
          it: no button moves, nothing is refused, and there is nothing to
          acknowledge - the operator reads it and decides. Absent when the
          server found no match AND when it could not tell; the dialog cannot
          distinguish those, by design, because both mean "say nothing". */}
      {preview.duplicateOf !== undefined ? (
        <div className={styles.duplicateWarning} role="status">
          <p>
            <strong>{formatNames(preview.duplicateOf.memberNames)}</strong>{' '}
            {preview.duplicateOf.partition === 'connecting'
              ? 'already have a relay group being connected.'
              : 'already have an open relay group.'}
          </p>
          <p>
            {preview.duplicateOf.partition === 'connecting'
              ? 'That group is still waiting on a number, and this one will get a second - so they would end up with two numbers for one conversation and no way to tell which one you are watching.'
              : 'This group will get its own separate number, so they would have two numbers for one conversation and no way to tell which one you are watching.'}
          </p>
          {/* NEW TAB, and deliberately not the dialog's primary action:
              navigating this tab away would discard the half-built group the
              operator is standing in, which is worse than the duplicate. */}
          <a
            href={`/conversations/${preview.duplicateOf.conversationId}`}
            target="_blank"
            rel="noreferrer"
          >
            View the existing group
          </a>
        </div>
      ) : null}
      <ul className={styles.recipients} aria-label="Recipients">
        {preview.recipients.map((r, i) => (
          <RecipientRow key={`${r.name ?? 'unnamed'}-${i}`} recipient={r} />
        ))}
      </ul>
      <p className={styles.count}>{countLine}</p>
      {preview.deferred ? <p className={styles.quiet}>{quietLine}</p> : null}
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
