// MessageEditor — the broadcast template editor. One job: a labeled <textarea>
// (≤1600 chars with a live count) plus merge-field insert chips that drop a token
// at the cursor (so the operator builds "Hi [TenantName], a [Beds]-bedroom home at
// [Address] …"). When the broadcast is for a property (unitId set) the property
// is shown and a note explains the [FlyerLink] is attached automatically.
import { useId, useRef } from 'react';
import { BROADCAST_MERGE_FIELDS } from '../../api/index.js';
import { DEFAULT_SEND_TEMPLATE } from './resolveTemplate.js';
import styles from './MessageEditor.module.css';

const MAX_TEMPLATE_LEN = 1600;

export interface MessageEditorProps {
  value: string;
  onChange: (next: string) => void;
  /** A short property reference shown when this broadcast is for a unit (the
   *  flyer link is then attached). Absent → no property note. */
  propertyLabel?: string;
  /** Resolved mode (a single recipient): the value is the FINAL rendered message,
   *  not a template. Hide the merge-field chips AND the flyer note (there are no
   *  tokens left to insert); keep the labeled textarea + live count. */
  resolved?: boolean;
}

export function MessageEditor({
  value,
  onChange,
  propertyLabel,
  resolved = false,
}: MessageEditorProps): React.JSX.Element {
  const uid = useId();
  const textareaId = `${uid}-template`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** Insert a merge token at the cursor (replacing any selection), then restore
   *  focus + place the caret just after the inserted token. */
  function insertToken(token: string): void {
    const el = textareaRef.current;
    if (el === null) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > MAX_TEMPLATE_LEN) return; // don't exceed the cap on insert
    onChange(next);
    // Restore focus + caret after React commits the new value.
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className={styles.editor}>
      <label className={styles.field} htmlFor={textareaId}>
        <span className={styles.fieldLabel}>Message</span>
      </label>

      {resolved ? null : (
        <div className={styles.chips} role="group" aria-label="Insert a merge field">
          {BROADCAST_MERGE_FIELDS.map((token) => (
            <button
              key={token}
              type="button"
              className={styles.chip}
              onClick={() => insertToken(token)}
            >
              {token}
            </button>
          ))}
        </div>
      )}

      <textarea
        id={textareaId}
        ref={textareaRef}
        className={styles.textarea}
        rows={6}
        maxLength={MAX_TEMPLATE_LEN}
        value={value}
        placeholder={DEFAULT_SEND_TEMPLATE}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className={styles.footRow}>
        <span className={styles.count}>
          {value.length}/{MAX_TEMPLATE_LEN}
        </span>
      </div>

      {propertyLabel !== undefined && !resolved ? (
        <p className={styles.propertyNote}>
          For <strong>{propertyLabel}</strong> — the flyer link is attached automatically (use{' '}
          <code>[FlyerLink]</code> to place it).
        </p>
      ) : null}
    </div>
  );
}
