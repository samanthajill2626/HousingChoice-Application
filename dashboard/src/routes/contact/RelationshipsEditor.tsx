// RelationshipsEditor — controlled editor for a list of relationship rows.
// Each row has a role input (with datalist suggestions) + a ContactSearchField
// (bound to name/contactId) + a Remove button. All mutations go via onChange —
// no local state for the rows.
import { useId, useRef, useState } from 'react';
import { type Contact, type Relationship } from '../../api/index.js';
import { Button } from '../../ui/index.js';
import { ContactSearchField } from './ContactSearchField.js';
import styles from './RelationshipsEditor.module.css';

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
  // Fix 5: instance-unique id for the datalist (no module-level constant)
  const uid = useId();
  const datalistId = `${uid}-role-suggestions`;

  // Fix 2: stable per-row ids so removing a middle row does not bleed
  // ContactSearchField internal state (activeIndex / dropdown query) into the
  // wrong row. The ids live in state (seeded once from the initial rows) and are
  // maintained in the add/remove handlers — the only ops that change length;
  // role/contact edits preserve positions, so ids stay aligned with `rows`.
  // (State, not a render-mutated ref — see react-hooks/refs.)
  const nextId = useRef(rows.length);
  const [ids, setIds] = useState<number[]>(() => rows.map((_, i) => i));

  const suggestions = roleSuggestions ?? [];

  function onRoleChange(index: number, newRole: string): void {
    const updated = rows.map((row, i) => (i === index ? { ...row, role: newRole } : row));
    onChange(updated);
  }

  function onContactChange(
    index: number,
    newValue: { name: string; contactId?: string },
  ): void {
    // Fix 4: omit contactId entirely when the user has not linked a contact
    // (free-typed name). Spread the existing row (which may have a contactId from
    // a prior pick), then overwrite name, and conditionally add contactId so
    // any previously-set key is removed when the new value has none.
    const updated = rows.map((row, i) => {
      if (i !== index) return row;
      // Build a fresh object without contactId, then conditionally add it back.
      // Omitting contactId entirely (not setting it to undefined) is important
      // so the key is absent on unlinked rows.
      const base: Relationship = { role: row.role, name: newValue.name };
      if (newValue.contactId) {
        base.contactId = newValue.contactId;
      }
      return base;
    });
    onChange(updated);
  }

  function onRemove(index: number): void {
    // Remove the stable id at the same position, keeping ids aligned with rows.
    setIds((prev) => prev.filter((_, i) => i !== index));
    onChange(rows.filter((_, i) => i !== index));
  }

  function onAdd(): void {
    // Append a new stable id in lockstep with the new row.
    setIds((prev) => [...prev, nextId.current++]);
    onChange([...rows, { role: '', name: '' }]);
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
              <li key={ids[i] ?? i} className={styles.row}>
                <input
                  className={styles.roleInput}
                  type="text"
                  value={row.role}
                  onChange={(e) => onRoleChange(i, e.target.value)}
                  placeholder="Role"
                  aria-label={`Relationship role ${n}`}
                  list={suggestions.length > 0 ? datalistId : undefined}
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
