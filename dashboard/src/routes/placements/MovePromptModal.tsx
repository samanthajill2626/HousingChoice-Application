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

export type MovePromptMode =
  | 'finalRent'
  | 'inspectionOutcome'
  | 'inspectionDate'
  | 'rentDetermined'
  | 'moveInReady';

export interface MovePromptResult {
  finalRent?: number;
  inspectionOutcome?: InspectionOutcome;
  inspectionDate?: string;
  rentDetermined?: number;
}

/** The raw, un-parsed field drafts - what the human has typed so far. */
export interface MovePromptDraft {
  rent?: string;
  outcome?: InspectionOutcome | '';
  inspectionDate?: string;
  determinedRent?: string;
}

export interface MovePromptModalProps {
  mode: MovePromptMode;
  onClose: () => void;
  onConfirm: (result: MovePromptResult) => void;
  busy?: boolean;
  /** moveInReady only: the tenant is LIF-eligible but LIF is not yet marked. */
  lifPending?: boolean;
  /** Prefill the input from what's already recorded (in-place stage-data), so the
   *  move still ASKS but never forces re-entry. Per-mode; unrelated keys ignored. */
  initial?: MovePromptResult;
  /**
   * OWNER-HELD draft storage, so what the human has typed SURVIVES a remount of
   * this modal. A 2026-08-24 e2e gate run caught the loss in the wild: the
   * Schedule-inspection dialog's filled date was EMPTY (and Confirm disabled)
   * moments after a successful fill - the modal subtree had re-initialized from
   * `initial` while its owner's `pending` state (and so the open dialog)
   * survived. A user typing when that trigger fires loses their entry the same
   * way. The exact remount trigger is load-dependent and unproven
   * (docs/issues/move-prompt-modal-loses-filled-date-under-load.md); holding
   * the draft in a parent-owned ref removes the CLASS regardless: state
   * initializers read it first, setters write through, and the parent resets it
   * when a NEW prompt opens. A ref, not state - drafts must never re-render the
   * owner per keystroke.
   */
  draftStore?: { current: MovePromptDraft | undefined };
}

/** Parse the rent input to a positive number, or null when invalid (≤0 / NaN). */
export function parseFinalRent(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const TITLES: Readonly<Record<MovePromptMode, string>> = {
  finalRent: 'Confirm final rent',
  inspectionOutcome: 'Record inspection outcome',
  inspectionDate: 'Schedule inspection',
  rentDetermined: 'Confirm determined rent',
  moveInReady: 'Confirm move-in ready',
};

export function MovePromptModal({
  mode,
  onClose,
  onConfirm,
  busy = false,
  lifPending = false,
  initial,
  draftStore,
}: MovePromptModalProps): React.JSX.Element {
  // Draft precedence: what the human already TYPED (draftStore, survives a
  // remount) wins over the recorded prefill (initial). See draftStore's doc.
  const [rent, setRentState] = useState(
    draftStore?.current?.rent ?? (initial?.finalRent !== undefined ? String(initial.finalRent) : ''),
  );
  const [outcome, setOutcomeState] = useState<InspectionOutcome | ''>(
    draftStore?.current?.outcome ?? initial?.inspectionOutcome ?? '',
  );
  const [inspectionDate, setInspectionDateState] = useState(
    draftStore?.current?.inspectionDate ?? initial?.inspectionDate ?? '',
  );
  const [determinedRent, setDeterminedRentState] = useState(
    draftStore?.current?.determinedRent ??
      (initial?.rentDetermined !== undefined ? String(initial.rentDetermined) : ''),
  );
  const writeDraft = (patch: Partial<MovePromptDraft>): void => {
    if (draftStore !== undefined) draftStore.current = { ...draftStore.current, ...patch };
  };
  const setRent = (value: string): void => {
    writeDraft({ rent: value });
    setRentState(value);
  };
  const setOutcome = (value: InspectionOutcome | ''): void => {
    writeDraft({ outcome: value });
    setOutcomeState(value);
  };
  const setInspectionDate = (value: string): void => {
    writeDraft({ inspectionDate: value });
    setInspectionDateState(value);
  };
  const setDeterminedRent = (value: string): void => {
    writeDraft({ determinedRent: value });
    setDeterminedRentState(value);
  };
  const rentId = useId();
  const groupId = useId();
  const dateId = useId();
  const determinedRentId = useId();

  const parsedRent = parseFinalRent(rent);
  const parsedDeterminedRent = parseFinalRent(determinedRent);
  const canConfirm =
    mode === 'finalRent'
      ? parsedRent !== null
      : mode === 'inspectionOutcome'
        ? outcome !== ''
        : mode === 'inspectionDate'
          ? inspectionDate !== ''
          : mode === 'rentDetermined'
            ? parsedDeterminedRent !== null
            : true; // moveInReady — always confirmable

  function handleConfirm(): void {
    if (mode === 'finalRent') {
      if (parsedRent === null) return;
      onConfirm({ finalRent: parsedRent });
    } else if (mode === 'inspectionOutcome') {
      if (outcome === '') return;
      onConfirm({ inspectionOutcome: outcome });
    } else if (mode === 'inspectionDate') {
      if (inspectionDate === '') return;
      onConfirm({ inspectionDate });
    } else if (mode === 'rentDetermined') {
      if (parsedDeterminedRent === null) return;
      onConfirm({ rentDetermined: parsedDeterminedRent });
    } else {
      onConfirm({});
    }
  }

  return (
    <Modal
      title={TITLES[mode]}
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
      ) : mode === 'rentDetermined' ? (
        <>
          <label className={styles.label} htmlFor={determinedRentId}>
            Determined rent (monthly)
          </label>
          <div className={styles.rentRow}>
            <span aria-hidden="true" className={styles.dollar}>
              $
            </span>
            <input
              id={determinedRentId}
              className={styles.input}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={determinedRent}
              onChange={(e) => setDeterminedRent(e.target.value)}
              placeholder="1450"
            />
          </div>
          {determinedRent !== '' && parsedDeterminedRent === null ? (
            <p role="alert" className={styles.error}>
              Enter an amount greater than 0.
            </p>
          ) : null}
        </>
      ) : mode === 'inspectionDate' ? (
        <>
          <label className={styles.label} htmlFor={dateId}>
            Inspection date
          </label>
          <input
            id={dateId}
            className={styles.input}
            type="date"
            value={inspectionDate}
            onChange={(e) => setInspectionDate(e.target.value)}
          />
        </>
      ) : mode === 'moveInReady' ? (
        <>
          <p className={styles.option}>
            Confirm this placement is ready for move-in.
          </p>
          {lifPending ? (
            <p role="alert" className={styles.error}>
              LIF is not marked for a LIF-eligible tenant — proceed anyway?
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
