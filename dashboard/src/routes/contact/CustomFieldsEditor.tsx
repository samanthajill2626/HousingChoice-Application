// CustomFieldsEditor — controlled editor for a list of custom key/value fields.
// Used by both the Create Contact dialog and the Edit Contact dialog.
// Renders one labelled row per entry (label input + value input + Remove button),
// plus an "+ Add custom field" button. All mutations are propagated via onChange —
// this component holds NO local state for the rows.
import { useId } from 'react';
import { type CustomField } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import styles from './CustomFieldsEditor.module.css';

export interface CustomFieldsEditorProps {
  rows: CustomField[];
  onChange: (rows: CustomField[]) => void;
  labelSuggestions?: string[];
}

export function CustomFieldsEditor({
  rows,
  onChange,
  labelSuggestions,
}: CustomFieldsEditorProps): React.JSX.Element {
  // Fix 5: instance-unique id for the datalist (no module-level constant)
  const uid = useId();
  const datalistId = `${uid}-label-suggestions`;

  const suggestions = labelSuggestions ?? [];

  function onLabelChange(index: number, newLabel: string): void {
    const updated = rows.map((row, i) => (i === index ? { ...row, label: newLabel } : row));
    onChange(updated);
  }

  function onValueChange(index: number, newValue: string): void {
    const updated = rows.map((row, i) => (i === index ? { ...row, value: newValue } : row));
    onChange(updated);
  }

  function onRemove(index: number): void {
    onChange(rows.filter((_, i) => i !== index));
  }

  function onAdd(): void {
    onChange([...rows, { label: '', value: '' }]);
  }

  return (
    <div className={styles.editor}>
      {suggestions.length > 0 && (
        <datalist id={datalistId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}

      {rows.length > 0 && (
        <ul className={styles.list}>
          {rows.map((row, i) => {
            const n = i + 1;
            return (
              <li key={i} className={styles.row}>
                <input
                  className={styles.input}
                  type="text"
                  value={row.label}
                  onChange={(e) => onLabelChange(i, e.target.value)}
                  placeholder="Field label"
                  aria-label={`Field label ${n}`}
                  list={suggestions.length > 0 ? datalistId : undefined}
                />
                <input
                  className={styles.input}
                  type="text"
                  value={row.value}
                  onChange={(e) => onValueChange(i, e.target.value)}
                  placeholder="Field value"
                  aria-label={`Field value ${n}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Remove custom field ${n}`}
                  onClick={() => onRemove(i)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <Button variant="secondary" size="sm" type="button" onClick={onAdd}>
        + Add custom field
      </Button>
    </div>
  );
}
