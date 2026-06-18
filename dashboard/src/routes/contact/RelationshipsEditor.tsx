// RelationshipsEditor — controlled editor for a list of relationship rows.
// Each row has a role input (with datalist suggestions) + a ContactSearchField
// (bound to name/contactId) + a Remove button. All mutations go via onChange —
// no local state for the rows.
import { type Contact, type Relationship } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { ContactSearchField } from './ContactSearchField.js';
import styles from './RelationshipsEditor.module.css';

const DATALIST_ID = 'relationship-role-suggestions';

export interface RelationshipsEditorProps {
  rows: Relationship[];
  onChange: (rows: Relationship[]) => void;
  candidates: Contact[];
  roleSuggestions?: string[];
}

export function RelationshipsEditor({
  rows,
  onChange,
  candidates,
  roleSuggestions,
}: RelationshipsEditorProps): React.JSX.Element {
  const suggestions = roleSuggestions ?? [];

  function onRoleChange(index: number, newRole: string): void {
    const updated = rows.map((row, i) => (i === index ? { ...row, role: newRole } : row));
    onChange(updated);
  }

  function onContactChange(
    index: number,
    newValue: { name: string; contactId?: string },
  ): void {
    const updated = rows.map((row, i) =>
      i === index ? { ...row, name: newValue.name, contactId: newValue.contactId } : row,
    );
    onChange(updated);
  }

  function onRemove(index: number): void {
    onChange(rows.filter((_, i) => i !== index));
  }

  function onAdd(): void {
    onChange([...rows, { role: '', name: '' }]);
  }

  return (
    <div className={styles.editor}>
      {suggestions.length > 0 && (
        <datalist id={DATALIST_ID}>
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
                  className={styles.roleInput}
                  type="text"
                  value={row.role}
                  onChange={(e) => onRoleChange(i, e.target.value)}
                  placeholder="Role"
                  aria-label={`Relationship role ${n}`}
                  list={suggestions.length > 0 ? DATALIST_ID : undefined}
                />
                <ContactSearchField
                  value={{ name: row.name, contactId: row.contactId }}
                  onChange={(v) => onContactChange(i, v)}
                  candidates={candidates}
                  inputLabel={`Contact search ${n}`}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Remove relationship ${n}`}
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
        + Add relationship
      </Button>
    </div>
  );
}
