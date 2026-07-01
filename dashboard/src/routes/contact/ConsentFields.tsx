// ConsentFields — the shared "Consent to text" input trio: a method dropdown
// (the four HUMAN values), a `when` date (default today), and an optional note.
// Reused by BOTH the optional contact-create section (§3.3) and the just-in-time
// hard-block modal (§3.4). Every control is labelled (getByLabel-resolvable).
//
// This captures only the HUMAN consent methods — web_form / inbound_text are
// stamped automatically by the backend and are never chosen here.
import type { HumanConsentMethod } from '../../lib/consentCopy.js';
import { HUMAN_CONSENT_METHODS, HUMAN_CONSENT_METHOD_LABELS } from '../../lib/consentCopy.js';
import styles from './ConsentFields.module.css';

export interface ConsentValue {
  /** The chosen HUMAN method, or '' when none is picked yet. */
  method: HumanConsentMethod | '';
  /** YYYY-MM-DD (the date input value). */
  when: string;
  /** Optional free-text note. */
  note: string;
}

export interface ConsentFieldsProps {
  value: ConsentValue;
  onChange: (next: ConsentValue) => void;
  /** Prefix for the field ids/labels so multiple instances stay unique + so
   *  getByLabel targets the right instance (e.g. "create" vs "jit"). */
  idPrefix: string;
  /** Disable all controls (e.g. while a submit is in flight). */
  disabled?: boolean;
  /** When true, a method MUST be chosen — marks the select aria-required (the JIT
   *  modal requires it; the create section leaves it optional). */
  methodRequired?: boolean;
}

export function ConsentFields({
  value,
  onChange,
  idPrefix,
  disabled = false,
  methodRequired = false,
}: ConsentFieldsProps): React.JSX.Element {
  const methodId = `${idPrefix}-consent-method`;
  const whenId = `${idPrefix}-consent-when`;
  const noteId = `${idPrefix}-consent-note`;

  return (
    <div className={styles.fields}>
      <label className={styles.field} htmlFor={methodId}>
        <span className={styles.label}>How did they consent?</span>
        <select
          id={methodId}
          className={styles.select}
          value={value.method}
          onChange={(e) => onChange({ ...value, method: e.target.value as ConsentValue['method'] })}
          disabled={disabled}
          aria-required={methodRequired}
        >
          <option value="">{methodRequired ? 'Select a method…' : 'No consent recorded'}</option>
          {HUMAN_CONSENT_METHODS.map((m) => (
            <option key={m} value={m}>
              {HUMAN_CONSENT_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field} htmlFor={whenId}>
        <span className={styles.label}>When</span>
        <input
          id={whenId}
          className={styles.input}
          type="date"
          value={value.when}
          onChange={(e) => onChange({ ...value, when: e.target.value })}
          disabled={disabled}
        />
      </label>

      <label className={styles.field} htmlFor={noteId}>
        <span className={styles.label}>Note (optional)</span>
        <textarea
          id={noteId}
          className={styles.note}
          rows={2}
          value={value.note}
          placeholder="e.g. said OK to texts at the fair"
          onChange={(e) => onChange({ ...value, note: e.target.value })}
          disabled={disabled}
        />
      </label>
    </div>
  );
}
