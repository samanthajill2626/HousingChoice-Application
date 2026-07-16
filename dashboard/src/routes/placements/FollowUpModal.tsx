// FollowUpModal - the placement hub's manual follow-up date/time dialog, mirroring
// the tour DateTimeModal pattern (TourModals.tsx): a datetime-local normalized to
// a full ISO instant (the navigator's timezone) before the parent POSTs it via
// setPlacementFollowUp. The dialog owns ONLY its input + busy/error UX; the parent
// owns the mutation (POST /deadline -> refetch) via the async onConfirm it passes.
// onConfirm resolves on success (the dialog closes) and throws on failure (inline
// error, dialog stays open). Opened from the header kebab's "Set follow-up" AND
// the Deadlines-and-nudges card's Set/Change controls (one shared modal).
import { useState } from 'react';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import styles from './PlacementDetail.module.css';

/** Normalize a zoneless datetime-local value to a full ISO instant. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

/** An ISO instant -> the local `YYYY-MM-DDTHH:mm` a datetime-local input wants, so
 *  editing an existing follow-up opens the picker on its current time. "" when the
 *  instant is absent/unparseable (a fresh set opens empty). */
function toLocalInput(iso: string | undefined): string {
  if (iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FollowUpModal({
  initial,
  onClose,
  onConfirm,
}: {
  /** The current follow-up instant (ISO), when changing an existing one. */
  initial?: string;
  onClose: () => void;
  /** POST the follow-up; resolves on success (dialog closes), throws to stay open. */
  onConfirm: (iso: string) => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState(() => toLocalInput(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = 'placement-follow-up-at';
  const formId = `${inputId}-form`;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (value === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(toIso(value));
      onClose();
    } catch {
      setError("Couldn't set the follow-up - please try again.");
      setBusy(false);
    }
  };

  return (
    <Modal
      title={initial !== undefined ? 'Change follow-up' : 'Set follow-up'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" type="submit" form={formId} disabled={value === '' || busy}>
            {busy ? 'Saving...' : 'Save follow-up'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className={styles.modalForm}
        aria-label="Set follow-up form"
        onSubmit={(e) => void submit(e)}
      >
        <label className={styles.modalLabel} htmlFor={inputId}>
          Follow-up date and time
        </label>
        <input
          id={inputId}
          className={styles.modalInput}
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        {error !== null ? (
          <p role="alert" className={styles.modalError}>
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
