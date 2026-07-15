// TourModals - the four small input dialogs the tour header + Schedule card open:
//   - BookTourModal / RescheduleTourModal: a datetime-local, normalized to a full
//     ISO instant (the navigator's timezone) before the parent PATCHes it. Book
//     runs on a timeless 'requested' tour (sets scheduledAt + status scheduled);
//     Reschedule runs on an already-timed tour (same PATCH shape). An odd time
//     (past / >14 days out) stops the first submit with a confirmable warning
//     and the button becomes "Schedule anyway"/"Reschedule anyway" — submitting
//     again confirms; editing the time clears it (tourTime.ts, shared with
//     ScheduleTourForm).
//   - RecordOutcomeModal: the exit gate - a move-forward / not-a-fit radio choice.
//     The parent PATCHes { outcome, moveForward } (and closes the tour on not-a-fit).
//   - CancelTourModal: a confirm dialog - the parent PATCHes { status: canceled }.
//
// Each dialog owns ONLY its input + validation + busy/error UX; the parent owns
// the mutation (patchTour -> setTour) via the async onConfirm it passes. onConfirm
// resolves on success (the dialog closes) and throws on failure (inline error,
// dialog stays open). ScheduleTourForm is create-only and deliberately NOT reused.
import { useState } from 'react';
import { type TourOutcome } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import { currentHourLocal, tourTimeWarning } from './tourTime.js';
import styles from './TourDetail.module.css';

/** Normalize a zoneless datetime-local value to a full ISO instant. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

interface DateModalProps {
  onClose: () => void;
  /** PATCH the new time; resolves on success, throws to keep the dialog open. */
  onConfirm: (isoScheduledAt: string) => Promise<void>;
}

/** Shared datetime dialog body for Book + Reschedule (they differ only in copy). */
function DateTimeModal({
  title,
  formLabel,
  fieldLabel,
  confirmLabel,
  anywayLabel,
  busyLabel,
  errorText,
  inputId,
  onClose,
  onConfirm,
}: DateModalProps & {
  title: string;
  formLabel: string;
  fieldLabel: string;
  confirmLabel: string;
  /** The confirm button's label while an odd-time warning is pending. */
  anywayLabel: string;
  busyLabel: string;
  errorText: string;
  inputId: string;
}): React.JSX.Element {
  // Seeded with today at the current WHOLE hour (:00) so the native picker
  // opens anchored there instead of the live minute (Cameron, 2026-07-14).
  const [value, setValue] = useState(() => currentHourLocal());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The pending confirmable time warning (past / >14 days out) — the first
  // submit stops on it; submitting the same odd time again is the confirmation.
  const [warning, setWarning] = useState<string | null>(null);
  const formId = `${inputId}-form`;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (value === '' || busy) return;
    const oddTime = tourTimeWarning(value);
    if (oddTime !== null && oddTime !== warning) {
      setWarning(oddTime);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(toIso(value));
      onClose();
    } catch {
      setError(errorText);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form={formId} disabled={value === '' || busy}>
            {busy ? busyLabel : warning !== null ? anywayLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.modalForm} aria-label={formLabel} onSubmit={(e) => void submit(e)}>
        <label className={styles.modalLabel} htmlFor={inputId}>
          {fieldLabel}
        </label>
        <input
          id={inputId}
          className={styles.modalInput}
          type="datetime-local"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            // Editing withdraws a pending warning — the next submit re-checks.
            if (warning !== null) setWarning(null);
          }}
          required
        />
        {warning !== null ? (
          <p role="alert" className={styles.modalWarn}>
            {warning} Press “{anywayLabel}” to confirm, or pick a different time.
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className={styles.modalError}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function BookTourModal({ onClose, onConfirm }: DateModalProps): React.JSX.Element {
  // "Schedule" vocabulary (Cameron, 2026-07-14) — matches the contact page's
  // "+ Schedule" tours card. The component keeps its BookTourModal name (and
  // the tour model its 'book' verb) — only displayed copy changes.
  return (
    <DateTimeModal
      title="Schedule tour"
      formLabel="Schedule tour form"
      fieldLabel="Date and time"
      confirmLabel="Confirm schedule"
      anywayLabel="Schedule anyway"
      busyLabel="Scheduling..."
      errorText="Couldn't schedule the tour - please try again."
      inputId="tour-book-at"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

export function RescheduleTourModal({ onClose, onConfirm }: DateModalProps): React.JSX.Element {
  return (
    <DateTimeModal
      title="Reschedule tour"
      formLabel="Reschedule tour form"
      fieldLabel="New date and time"
      confirmLabel="Confirm reschedule"
      anywayLabel="Reschedule anyway"
      busyLabel="Rescheduling..."
      errorText="Couldn't reschedule the tour - please try again."
      inputId="tour-reschedule-at"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

export function RecordOutcomeModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  /** PATCH the exit-gate decision; resolves on success, throws to stay open. */
  onConfirm: (decision: { outcome: TourOutcome; moveForward: boolean }) => Promise<void>;
}): React.JSX.Element {
  const [moveForward, setMoveForward] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (moveForward === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({
        outcome: moveForward ? 'move_forward' : 'not_a_fit',
        moveForward,
      });
      onClose();
    } catch {
      setError("Couldn't record the outcome - please try again.");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Record outcome"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form="tour-outcome-form" disabled={moveForward === null || busy}>
            {busy ? 'Saving...' : 'Save decision'}
          </Button>
        </>
      }
    >
      <form id="tour-outcome-form" className={styles.modalForm} aria-label="Record outcome form" onSubmit={(e) => void submit(e)}>
        <fieldset className={styles.radioGroup}>
          <legend className={styles.modalLabel}>Moving forward with this property?</legend>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="tour-move-forward"
              checked={moveForward === true}
              onChange={() => setMoveForward(true)}
            />
            <span>Yes - move forward</span>
          </label>
          <label className={styles.radioRow}>
            <input
              type="radio"
              name="tour-move-forward"
              checked={moveForward === false}
              onChange={() => setMoveForward(false)}
            />
            <span>No - not a fit</span>
          </label>
        </fieldset>
        <p className={styles.modalHint}>
          Moving forward starts a placement; not a fit closes the tour.
        </p>
        {error !== null ? (
          <p role="alert" className={styles.modalError}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function CancelTourModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  /** PATCH { status: canceled }; resolves on success, throws to stay open. */
  onConfirm: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doCancel = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch {
      setError("Couldn't cancel the tour - please try again.");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Cancel tour?"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Keep tour
          </Button>
          <Button variant="danger" size="sm" type="button" onClick={() => void doCancel()} disabled={busy}>
            {busy ? 'Canceling...' : 'Cancel tour'}
          </Button>
        </>
      }
    >
      <p>
        This tour will be marked <strong>canceled</strong>. Any armed reminders stop. You can
        reschedule it later to revive it.
      </p>
      {error !== null ? (
        <p role="alert" className={styles.modalError}>
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
