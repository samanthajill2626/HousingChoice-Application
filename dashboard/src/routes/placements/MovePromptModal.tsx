// MovePromptModal — the small gated prompts the backend requires on two
// specific moves (F2.1):
//   - finalRent: prompted on the move OUT of `awaiting_rent_acceptance` (the
//     accepted contract rent, written onto the unit). Must be > 0.
//   - inspectionOutcome: prompted on the move OUT of `awaiting_inspection`
//     (pass / fail).
// One component, a `mode` selects which. On confirm it hands back the captured
// value; the caller includes it in the transition body. Reuses Modal + Button.
import { useId, useState } from 'react';
import { INSPECTION_OUTCOMES, type InspectionOutcome } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import styles from './MovePromptModal.module.css';

export type MovePromptMode = 'finalRent' | 'inspectionOutcome';

export interface MovePromptResult {
  finalRent?: number;
  inspectionOutcome?: InspectionOutcome;
}

export interface MovePromptModalProps {
  mode: MovePromptMode;
  onClose: () => void;
  onConfirm: (result: MovePromptResult) => void;
  busy?: boolean;
}

/** Parse the rent input to a positive number, or null when invalid (≤0 / NaN). */
export function parseFinalRent(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function MovePromptModal({
  mode,
  onClose,
  onConfirm,
  busy = false,
}: MovePromptModalProps): React.JSX.Element {
  const [rent, setRent] = useState('');
  const [outcome, setOutcome] = useState<InspectionOutcome | ''>('');
  const rentId = useId();
  const groupId = useId();

  const parsedRent = parseFinalRent(rent);
  const canConfirm =
    mode === 'finalRent' ? parsedRent !== null : outcome !== '';

  function handleConfirm(): void {
    if (mode === 'finalRent') {
      if (parsedRent === null) return;
      onConfirm({ finalRent: parsedRent });
    } else {
      if (outcome === '') return;
      onConfirm({ inspectionOutcome: outcome });
    }
  }

  return (
    <Modal
      title={mode === 'finalRent' ? 'Confirm final rent' : 'Record inspection outcome'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canConfirm}
            loading={busy}
            onClick={handleConfirm}
          >
            Confirm move
          </Button>
        </>
      }
    >
      {mode === 'finalRent' ? (
        <>
          <label className={styles.label} htmlFor={rentId}>
            Final contract rent (monthly)
          </label>
          <div className={styles.rentRow}>
            <span aria-hidden="true" className={styles.dollar}>
              $
            </span>
            <input
              id={rentId}
              className={styles.input}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={rent}
              onChange={(e) => setRent(e.target.value)}
              placeholder="1550"
            />
          </div>
          {rent !== '' && parsedRent === null ? (
            <p role="alert" className={styles.error}>
              Enter an amount greater than 0.
            </p>
          ) : null}
        </>
      ) : (
        <fieldset className={styles.fieldset} aria-labelledby={groupId}>
          <legend id={groupId} className={styles.label}>
            Inspection outcome
          </legend>
          {INSPECTION_OUTCOMES.map((o) => (
            <label key={o} className={styles.option}>
              <input
                type="radio"
                name="inspection-outcome"
                value={o}
                checked={outcome === o}
                onChange={() => setOutcome(o)}
              />
              <span>{o === 'pass' ? 'Pass' : 'Fail'}</span>
            </label>
          ))}
        </fieldset>
      )}
    </Modal>
  );
}
