// QuickRepliesEditor — an editable chip list for the missed-call quick replies.
// Each chip is a reply (1..maxChars); up to `max` of them. Add via an input +
// "Add", remove via each chip's "×". Disabled (VA read-only) renders the chips
// as static text with no controls. The parent owns the array; this is controlled.
import { useState } from 'react';
import styles from './TemplatesSection.module.css';

export interface QuickRepliesEditorProps {
  replies: string[];
  disabled: boolean;
  max: number;
  maxChars: number;
  onChange: (next: string[]) => void;
}

export function QuickRepliesEditor({
  replies,
  disabled,
  max,
  maxChars,
  onChange,
}: QuickRepliesEditorProps): React.JSX.Element {
  const [draft, setDraft] = useState('');

  function add(): void {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed.length > maxChars || replies.length >= max) return;
    onChange([...replies, trimmed]);
    setDraft('');
  }

  function remove(index: number): void {
    onChange(replies.filter((_, i) => i !== index));
  }

  return (
    <div className={styles.chips}>
      <ul className={styles.chipList}>
        {replies.map((reply, i) => (
          <li key={`${reply}-${i}`} className={styles.chip}>
            <span className={styles.chipText}>{reply}</span>
            {!disabled ? (
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove quick reply: ${reply}`}
                onClick={() => remove(i)}
              >
                ×
              </button>
            ) : null}
          </li>
        ))}
        {replies.length === 0 && disabled ? (
          <li className={styles.chipEmpty}>No quick replies.</li>
        ) : null}
      </ul>

      {!disabled ? (
        <div className={styles.chipAddRow}>
          <label className={styles.chipAddField}>
            <span className={styles.srOnly}>New quick reply</span>
            <input
              className={styles.input}
              type="text"
              value={draft}
              maxLength={maxChars}
              placeholder="Add a quick reply"
              disabled={replies.length >= max}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </label>
          <button
            type="button"
            className={styles.chipAddBtn}
            onClick={add}
            disabled={draft.trim().length === 0 || replies.length >= max}
          >
            Add
          </button>
        </div>
      ) : null}

      {!disabled && replies.length >= max ? (
        <span className={styles.hint}>Maximum of {max} quick replies.</span>
      ) : null}
    </div>
  );
}
