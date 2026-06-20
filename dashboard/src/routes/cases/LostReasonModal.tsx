// LostReasonModal — captures WHY a placement was lost before transitioning it to
// the `lost` terminal stage (F2.2). A category radio group (the 7 F1
// LOST_REASON_CATEGORIES with LOST_REASON_CATEGORY_LABELS) AND a free-text field;
// either (a category OR non-empty trimmed text) satisfies the backend, so the
// confirm button stays DISABLED until validateLostReason passes (mirrors the
// server rule). On confirm it hands the built { category?, text? } back to the
// caller, which performs the transitionPlacement(toStage:'lost', …). Reuses the
// shared Modal primitive + the Button.
import { useId, useState } from 'react';
import {
  LOST_REASON_CATEGORIES,
  LOST_REASON_CATEGORY_LABELS,
  validateLostReason,
  type LostReason,
  type LostReasonCategory,
} from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { Modal } from '../contact/Modal.js';
import styles from './LostReasonModal.module.css';

export interface LostReasonModalProps {
  /** Tenant name for the prompt context (display only). */
  subject?: string;
  onClose: () => void;
  /** Called with the built reason on confirm (the caller does the transition). */
  onConfirm: (reason: LostReason) => void;
  /** Disables the confirm button while the caller's transition is in flight. */
  busy?: boolean;
}

/** Build the structured reason from the form state, omitting empty parts. */
export function buildLostReason(
  category: LostReasonCategory | '',
  text: string,
): LostReason {
  const trimmed = text.trim();
  const reason: LostReason = {};
  if (category !== '') reason.category = category;
  if (trimmed.length > 0) reason.text = trimmed;
  return reason;
}

export function LostReasonModal({
  subject,
  onClose,
  onConfirm,
  busy = false,
}: LostReasonModalProps): React.JSX.Element {
  const [category, setCategory] = useState<LostReasonCategory | ''>('');
  const [text, setText] = useState('');
  const groupId = useId();
  const textId = useId();

  const reason = buildLostReason(category, text);
  const canConfirm = validateLostReason(reason);

  return (
    <Modal
      title="Mark placement lost"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={!canConfirm}
            loading={busy}
            onClick={() => onConfirm(reason)}
          >
            Mark lost
          </Button>
        </>
      }
    >
      {subject ? (
        <p className={styles.subject}>
          Why is <strong>{subject}</strong>&apos;s placement being closed?
        </p>
      ) : (
        <p className={styles.subject}>Why is this placement being closed?</p>
      )}

      <fieldset className={styles.fieldset} aria-labelledby={groupId}>
        <legend id={groupId} className={styles.legend}>
          Reason
        </legend>
        {LOST_REASON_CATEGORIES.map((cat) => (
          <label key={cat} className={styles.option}>
            <input
              type="radio"
              name="lost-reason-category"
              value={cat}
              checked={category === cat}
              onChange={() => setCategory(cat)}
            />
            <span>{LOST_REASON_CATEGORY_LABELS[cat]}</span>
          </label>
        ))}
      </fieldset>

      <label className={styles.textLabel} htmlFor={textId}>
        Notes (optional if a reason is picked)
      </label>
      <textarea
        id={textId}
        className={styles.textarea}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add any detail…"
      />
    </Modal>
  );
}
